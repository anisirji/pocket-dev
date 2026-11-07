import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { createGitApi } from './git.js';
import { createHistoryApi } from './history.js';
import { createAuth, QR_TTL_MIN } from './auth.js';
import { terminalQr, qrNote } from './qr.js';
import { openConfig } from './config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCROLLBACK_MAX = 500_000;
const BODY_MAX = 64_000;
const UPLOAD_MAX = 25 * 1024 * 1024;

const config = openConfig(process.env.POCKET_DEV_CONFIG || path.join(ROOT, 'config.json'));
const PORT = Number(process.env.PORT) || config.read().port || 7777;

function lanIp() {
  const ifaces = os.networkInterfaces();
  const names = ['en0', ...Object.keys(ifaces).filter((n) => n !== 'en0')];
  for (const name of names) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const auth = createAuth({ config, port: PORT, lanIp });

const HOME = os.homedir();
const RECENT_MAX = 5;
const PROJECT_ROOTS = [path.join(HOME, 'Desktop'), path.join(HOME, 'Desktop', 'Projects')];

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? HOME + p.slice(1) : p);
const absDir = (p) => path.resolve(HOME, expandHome(p.trim()));
const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const resolveDir = (p) => (typeof p === 'string' && p.trim() && isDir(absDir(p)) ? absDir(p) : null);

const folderName = (dir) => (dir === HOME ? '~' : path.basename(dir) || dir);
const folderView = (dir) => ({ name: folderName(dir), path: dir });

function listProjects() {
  const found = [];
  for (const root of PROJECT_ROOTS) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(root, e.name);
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) found.push(dir);
    }
  }
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' }));
}

const DEFAULT_SHORTCUTS = ['claude', 'codex', 'npm run dev', 'git status', 'git pull'];
const isShortcut = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= 200 && !/[\x00-\x1f\x7f]/.test(s);
const isShortcutList = (v) => Array.isArray(v) && v.length <= 30 && v.every(isShortcut);
const stringsIn = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string') : undefined);
// Each parser returns what it can use from a hand-edited value, or undefined when nothing is usable.
const LISTS = {
  folders: { parse: stringsIn, fallback: [] },
  recentFolders: { parse: stringsIn, fallback: [] },
  shortcuts: { parse: (v) => (isShortcutList(v) ? v : undefined), fallback: DEFAULT_SHORTCUTS },
};
// The fallback is for this read only; the malformed value stays in config.json until the user fixes it or edits that list.
function readList(key) {
  const value = config.read()[key];
  return (value === undefined ? undefined : LISTS[key].parse(value)) ?? LISTS[key].fallback;
}
for (const [key, { parse }] of Object.entries(LISTS)) {
  const value = config.read()[key];
  if (value !== undefined && parse(value)?.length !== value.length) {
    console.warn(`config.json: ${key} is malformed. Pocket Dev ignores what it cannot use and leaves the file as it is.`);
  }
}

function listFolders() {
  const existing = (list) => [...new Set(list.map(resolveDir).filter(Boolean))].map(folderView);
  return { home: HOME, pinned: existing(readList('folders')), recent: existing(readList('recentFolders')), projects: listProjects().map(folderView) };
}

// Hand-written entries such as "~/app" name the same folder as the resolved path the page sends back. Edits start
// from the raw list so entries Pocket Dev cannot read stay in the file.
const isEntryFor = (dir) => (p) => typeof p === 'string' && absDir(p) === dir;
const rawList = (key) => {
  const value = config.read()[key];
  return Array.isArray(value) ? value : [];
};

function setPinned(dir, pinned) {
  const list = rawList('folders');
  if (list.some(isEntryFor(dir)) === pinned) return;
  config.update({ folders: pinned ? [...list, dir] : list.filter((p) => !isEntryFor(dir)(p)) });
}

// Home is always the sheet's first row, so keeping it out of recent leaves all five slots for real projects.
function rememberRecent(dir) {
  if (dir === HOME) return;
  config.update({ recentFolders: [dir, ...rawList('recentFolders').filter((p) => !isEntryFor(dir)(p))].slice(0, RECENT_MAX) });
}

const UPLOAD_DIR = path.join(HOME, '.pocket-dev', 'uploads');

function uploadName(header) {
  let name = '';
  try { name = decodeURIComponent(header ?? ''); } catch {}
  name = name.split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f:]/g, '')
    .replace(/\s+/g, '-')
    .slice(-100)
    .replace(/^[.-]+/, '');
  return name || 'upload';
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function openUploadFile(name) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const stamp = timestamp();
  for (let n = 1; ; n++) {
    const file = path.join(UPLOAD_DIR, `${stamp}-${n === 1 ? '' : `${n}-`}${name}`);
    try {
      return { file, fd: fs.openSync(file, 'wx', 0o600) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function tooLarge(res) {
  res.setHeader('connection', 'close');
  sendJson(res, 413, { error: 'File is larger than 25 MB' });
}

async function upload(req, res) {
  if (Number(req.headers['content-length']) > UPLOAD_MAX) return tooLarge(res);
  const { file, fd } = openUploadFile(uploadName(req.headers['x-filename']));
  let size = 0;
  try {
    await pipeline(req, async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > UPLOAD_MAX) throw new Error('File is larger than 25 MB');
        yield chunk;
      }
    }, fs.createWriteStream(null, { fd }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    if (size > UPLOAD_MAX) return tooLarge(res);
    throw err;
  }
  sendJson(res, 201, { path: file });
}

const sessions = new Map();

function nextTitle(cwd) {
  const base = folderName(cwd);
  const taken = new Set([...sessions.values()].map((s) => s.title));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

const broadcast = (session, msg) => {
  const data = JSON.stringify(msg);
  for (const ws of session.clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

function appendScrollback(session, chunk) {
  let buf = session.scrollback + chunk;
  if (buf.length > SCROLLBACK_MAX) {
    // Cut at a line boundary so the replay rarely starts inside an escape sequence.
    const start = buf.length - SCROLLBACK_MAX;
    const nl = buf.indexOf('\n', start);
    buf = buf.slice(nl === -1 ? start : nl + 1);
  }
  session.scrollback = buf;
}

function createSession(cwd) {
  const shell = process.env.SHELL || '/bin/zsh';
  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    // launchd and nohup start node without LANG, which makes ls print non-ASCII filenames as ???.
    env: { LANG: 'en_US.UTF-8', ...process.env, TERM: 'xterm-256color' },
  });
  const session = {
    id: crypto.randomBytes(6).toString('hex'),
    title: nextTitle(cwd),
    cwd,
    pty: proc,
    scrollback: '',
    clients: new Set(),
    exitCode: null,
  };
  proc.onData((d) => {
    appendScrollback(session, d);
    broadcast(session, { t: 'out', d });
  });
  proc.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    broadcast(session, { t: 'exit', code: exitCode });
  });
  sessions.set(session.id, session);
  return session;
}

function destroySession(session) {
  try {
    process.kill(-session.pty.pid, 'SIGHUP');
  } catch {
    try { session.pty.kill(); } catch {}
  }
  for (const ws of session.clients) ws.close(1000, 'session closed');
  sessions.delete(session.id);
}

const sessionView = ({ id, title, exitCode }) => ({ id, title, exitCode });

const isDim = (n) => Number.isInteger(n) && n >= 10 && n <= 500;

function attachClient(session, ws) {
  session.clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (session.scrollback) ws.send(JSON.stringify({ t: 'out', d: session.scrollback }));
  if (session.exitCode !== null) ws.send(JSON.stringify({ t: 'exit', code: session.exitCode }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (session.exitCode !== null) return;
    if (msg.t === 'in' && typeof msg.d === 'string') {
      // Several pages can share a session (another browser tab, the desktop); the one typing owns the size.
      const { pty: proc } = session;
      if (ws.size && (proc.cols !== ws.size.cols || proc.rows !== ws.size.rows)) proc.resize(ws.size.cols, ws.size.rows);
      proc.write(msg.d);
    } else if (msg.t === 'resize' && isDim(msg.cols) && isDim(msg.rows)) {
      ws.size = { cols: msg.cols, rows: msg.rows };
      session.pty.resize(msg.cols, msg.rows);
    }
  });
  ws.on('close', () => session.clients.delete(ws));
}

const forwards = new Map();

const forwardView = (port, fwd) => ({ port, url: `http://${fwd.host}:${port}` });
const listForwards = () => [...forwards].map(([port, fwd]) => forwardView(port, fwd));

// Dev servers bind 127.0.0.1 or ::1 depending on the tool, so try both before giving up.
function pipeToLocalhost(client, port, sockets, hosts = ['127.0.0.1', '::1']) {
  const [host, ...fallbacks] = hosts;
  const upstream = net.connect({ port, host, allowHalfOpen: true });
  upstream.once('error', () => {
    if (fallbacks.length && !client.destroyed) pipeToLocalhost(client, port, sockets, fallbacks);
    else client.destroy();
  });
  upstream.once('connect', () => {
    upstream.removeAllListeners('error');
    upstream.on('error', () => client.destroy());
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

async function openForward(port) {
  const existing = forwards.get(port);
  if (existing) return forwardView(port, existing);
  const host = lanIp();
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => sockets.delete(client));
    pipeToLocalhost(client, port, sockets);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const fwd = { server, host, sockets };
  forwards.set(port, fwd);
  return forwardView(port, fwd);
}

function closeForward(port) {
  const fwd = forwards.get(port);
  if (!fwd) return false;
  fwd.server.close();
  for (const s of fwd.sockets) s.destroy();
  forwards.delete(port);
  return true;
}

function forwardError(err, port) {
  if (err.code === 'EADDRINUSE') {
    return `Port ${port} is already in use on ${lanIp()}. If your dev server listens on all interfaces (0.0.0.0), it is already reachable at http://${lanIp()}:${port} without a forward.`;
  }
  if (err.code === 'EACCES') return `Not allowed to listen on port ${port} (ports below 1024 need root).`;
  return `Could not open port ${port}: ${err.message}`;
}

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be a whole number from 1 to 65535.' };
  if (port === PORT) return { error: `Port ${port} is Pocket Dev itself.` };
  return { port };
}

async function handleApi(req, res, url) {
  const [, , resource, key] = url.pathname.split('/');
  const route = `${req.method} ${resource}${key ? '/:key' : ''}`;

  const authReply = await auth.handleApi(req, url.pathname, () => readJson(req));
  if (authReply) return sendJson(res, authReply.status, authReply.body, authReply.headers);
  if (!auth.deviceFor(req)) return sendJson(res, 401, { error: 'Not logged in' });
  if (resource === 'git') {
    const { status, body } = await handleGit(req.method, url, () => readJson(req));
    return sendJson(res, status, body);
  }
  if (resource === 'history') return handleHistory(req, res, url.pathname);

  switch (route) {
    case 'GET sessions':
      return sendJson(res, 200, [...sessions.values()].map(sessionView));
    case 'POST sessions': {
      const { cwd = HOME } = await readJson(req);
      const dir = resolveDir(cwd);
      if (!dir) return sendJson(res, 400, { error: `Not a folder: ${cwd}` });
      const session = createSession(dir);
      rememberRecent(dir);
      return sendJson(res, 201, sessionView(session));
    }
    case 'DELETE sessions/:key': {
      const session = sessions.get(key);
      if (!session) return sendJson(res, 404, { error: 'No such session' });
      destroySession(session);
      return sendJson(res, 204);
    }
    case 'GET folders':
      return sendJson(res, 200, listFolders());
    case 'PUT folders/:key': {
      if (key !== 'pinned') return sendJson(res, 404, { error: 'Not found' });
      const { path: given, pinned } = await readJson(req);
      if (typeof pinned !== 'boolean') return sendJson(res, 400, { error: 'Expected { path, pinned }' });
      const dir = resolveDir(given);
      if (!dir) return sendJson(res, 400, { error: `Not a folder: ${given}` });
      setPinned(dir, pinned);
      return sendJson(res, 200, listFolders());
    }
    case 'POST upload':
      return upload(req, res);
    case 'GET shortcuts':
      return sendJson(res, 200, readList('shortcuts'));
    case 'PUT shortcuts': {
      const list = await readJson(req);
      if (!isShortcutList(list)) {
        return sendJson(res, 400, { error: 'Shortcuts must be a list of up to 30 one-line commands, each 1 to 200 characters.' });
      }
      config.update({ shortcuts: list });
      return sendJson(res, 200, list);
    }
    case 'GET forwards':
      return sendJson(res, 200, listForwards());
    case 'POST forwards': {
      const { port, error } = parsePort((await readJson(req)).port);
      if (error) return sendJson(res, 400, { error });
      try {
        return sendJson(res, 201, await openForward(port));
      } catch (err) {
        return sendJson(res, 409, { error: forwardError(err, port) });
      }
    }
    case 'DELETE forwards/:key':
      return closeForward(Number(key)) ? sendJson(res, 204) : sendJson(res, 404, { error: 'Not forwarded' });
    case 'GET info':
      return sendJson(res, 200, { lanIp: lanIp(), forwards: listForwards() });
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

const handleGit = createGitApi({ config });
const handleHistory = createHistoryApi({ createSession, sessionView, sendJson });

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html',
  '/git.js': 'git.js', '/graph.js': 'graph.js', '/git.css': 'git.css',
  '/history.js': 'history.js', '/history.css': 'history.css',
  '/settings.js': 'settings.js', '/settings.css': 'settings.css',
};
const PUBLIC_PAGES = new Set(['login.html']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function servePage(req, res, pathname) {
  const file = PAGES[pathname];
  if (!file || req.method !== 'GET') return sendJson(res, 404, { error: 'Not found' });
  if (!PUBLIC_PAGES.has(file) && !auth.deviceFor(req)) {
    if (!file.endsWith('.html')) return sendJson(res, 401, { error: 'Not logged in' });
    res.writeHead(302, { location: '/login.html' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(ROOT, 'public', file)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' && url.searchParams.has('k')) {
      const { status, headers, body } = auth.redeemQrKey(req, url.searchParams.get('k'));
      res.writeHead(status, { 'cache-control': 'no-store', ...headers });
      res.end(body);
    } else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else servePage(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
  }
});

const wss = new WebSocketServer({ noServer: true });

const rejectUpgrade = (socket, status, text) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const match = /^\/ws\/([0-9a-f]+)$/.exec(pathname);
  const device = auth.deviceFor(req);
  if (!device) return rejectUpgrade(socket, 401, 'Unauthorized');
  // SameSite=Strict should already block cross-site upgrades; the Origin check is the backstop.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return rejectUpgrade(socket, 403, 'Forbidden');
  const session = match && sessions.get(match[1]);
  if (!session) return rejectUpgrade(socket, 404, 'Not Found');
  wss.handleUpgrade(req, socket, head, (ws) => {
    auth.trackSocket(device, ws);
    attachClient(session, ws);
  });
});

// A phone that sleeps can leave a dead socket behind; without pings it would buffer output forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', async () => {
  console.log(await terminalQr(auth.mintQrUrl()));
  console.log(`Pocket Dev running at http://${lanIp()}:${PORT}`);
  console.log(auth.passwordLine);
  console.log(qrNote(QR_TTL_MIN));
});
