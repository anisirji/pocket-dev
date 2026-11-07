import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.POCKET_DEV_CONFIG || path.join(ROOT, 'config.json');
const SCROLLBACK_MAX = 500_000;
const BODY_MAX = 64_000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const fresh = { password: crypto.randomBytes(9).toString('base64url'), port: 7777 };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 });
    console.log(`Created ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = loadConfig();

function saveConfig() {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}
const PASSWORD = process.env.POCKET_DEV_PASSWORD || config.password;
const PORT = Number(process.env.PORT) || config.port || 7777;

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

const tokens = new Set();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Hashing first gives equal-length buffers, so timingSafeEqual never leaks the password length.
const passwordMatches = (given) => crypto.timingSafeEqual(sha256(given), sha256(PASSWORD));

function cookieToken(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'pd_token') return v;
  }
  return undefined;
}

const isAuthed = (req) => tokens.has(cookieToken(req));

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

function listFolders() {
  const existing = (list = []) => list.map(resolveDir).filter(Boolean).map(folderView);
  return { home: HOME, pinned: existing(config.folders), recent: existing(config.recentFolders), projects: listProjects().map(folderView) };
}

function setPinned(dir, pinned) {
  const list = config.folders ?? [];
  if (list.includes(dir) === pinned) return;
  config.folders = pinned ? [...list, dir] : list.filter((p) => p !== dir);
  saveConfig();
}

// Home is always the sheet's first row, so keeping it out of recent leaves all five slots for real projects.
function rememberRecent(dir) {
  if (dir === HOME) return;
  config.recentFolders = [dir, ...(config.recentFolders ?? []).filter((p) => p !== dir)].slice(0, RECENT_MAX);
  saveConfig();
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

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(req, res) {
  const { password } = await readJson(req);
  if (typeof password !== 'string' || !passwordMatches(password)) {
    await sleep(1000);
    return sendJson(res, 401, { error: 'Wrong password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  tokens.add(token);
  res.setHeader('set-cookie', `pd_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  sendJson(res, 200, { ok: true });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be a whole number from 1 to 65535.' };
  if (port === PORT) return { error: `Port ${port} is Pocket Dev itself.` };
  return { port };
}

async function handleApi(req, res, pathname) {
  const [, , resource, key] = pathname.split('/');
  const route = `${req.method} ${resource}${key ? '/:key' : ''}`;

  if (route === 'POST login') return login(req, res);
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'Not logged in' });

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

const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html' };

function servePage(req, res, pathname) {
  const file = PAGES[pathname];
  if (!file || req.method !== 'GET') return sendJson(res, 404, { error: 'Not found' });
  if (file === 'index.html' && !isAuthed(req)) {
    res.writeHead(302, { location: '/login.html' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(ROOT, 'public', file)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else servePage(req, res, pathname);
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
  if (!isAuthed(req)) return rejectUpgrade(socket, 401, 'Unauthorized');
  // SameSite=Strict should already block cross-site upgrades; the Origin check is the backstop.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return rejectUpgrade(socket, 403, 'Forbidden');
  const session = match && sessions.get(match[1]);
  if (!session) return rejectUpgrade(socket, 404, 'Not Found');
  wss.handleUpgrade(req, socket, head, (ws) => attachClient(session, ws));
});

// A phone that sleeps can leave a dead socket behind; without pings it would buffer output forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pocket Dev running at http://${lanIp()}:${PORT}`);
  console.log(`Password: ${PASSWORD}`);
});
