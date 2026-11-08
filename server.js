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
import { resolveConfigPath, STATE_DIR } from './paths.js';
import { openTerminalHost } from './terminals.js';
import { startPower, handlePowerApi, powerStatus } from './power.js';
import { createAppsApi, snapshot as appsSnapshot } from './apps.js';
import { startAdmin } from './admin.js';
import { createPhoneAccess } from './access.js';
import { createChatApi } from './chat/index.js';
import { createFilesApi } from './files.js';
import { createCollaborators } from './collaborators.js';
import { captureScreen } from './screen.js';
import { collectHealth } from './health.js';
import { createTunnel } from './tunnel.js';
import { createMessages } from './messages.js';
import { sameOrigin } from './transport.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCROLLBACK_MAX = 500_000;
const BODY_MAX = 64_000;
const UPLOAD_MAX = 25 * 1024 * 1024;

const config = openConfig(resolveConfigPath());
const PORT = Number(process.env.PORT) || config.read().port || 7777;

// Every IPv4 address the Mac has on a network, en0 first. POCKET_DEV_LAN_IP_FILE replaces the interface lookup in
// tests: the file holds one address, empty means no network.
function lanIps() {
  if (process.env.POCKET_DEV_LAN_IP_FILE) {
    let ip = '';
    try { ip = fs.readFileSync(process.env.POCKET_DEV_LAN_IP_FILE, 'utf8').trim(); } catch {}
    return ip ? [ip] : [];
  }
  const ifaces = os.networkInterfaces();
  const names = ['en0', ...Object.keys(ifaces).filter((n) => n !== 'en0')];
  return names.flatMap((name) => (ifaces[name] ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
}
const lanIp = () => lanIps()[0] ?? null;

const localName = () => {
  const name = os.hostname().toLowerCase();
  return name.endsWith('.local') ? name : `${name}.local`;
};
let tunnel;
const urls = () => ({ lan: lanIp() && `http://${lanIp()}:${PORT}`, local: `http://${localName()}:${PORT}`, remote: tunnel?.view().url ?? null });
const LOCAL_NOTE = 'same Wi-Fi only; some Android phones cannot open .local names';

// A DNS-rebinding page reaches this port under its own name, so only names that mean this Mac are served: its
// addresses and .local name on PORT, loopback, and config.json "allowedHosts" (a tunnel's domain, any port). The
// addresses are read per request because the network can change.
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
function hostAllowed(host) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec((host ?? '').toLowerCase());
  if (!m) return false;
  const name = m[1].replace(/\.$/, '');
  if (urls().remote && name === new URL(urls().remote).hostname && (m[2] === undefined || Number(m[2]) === 443)) return true;
  const extra = config.read().allowedHosts;
  if (Array.isArray(extra) && extra.some((h) => typeof h === 'string' && h.toLowerCase() === name)) return true;
  const port = m[2] === undefined ? 80 : Number(m[2]);
  return port === PORT && [...LOOPBACK_NAMES, localName(), ...lanIps()].includes(name);
}
const MISDIRECTED = 'Misdirected Request: this server answers only to its own addresses.';

let collaborators;
const auth = createAuth({ config, port: PORT, urls, localNote: LOCAL_NOTE,
  extraActiveCount: () => collaborators?.sessionCount() || 0,
  onLockdown: () => collaborators?.lockdown(),
});
collaborators = createCollaborators({ config, auth, urls });

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

// Past the limit the body is read and dropped instead of cut off: a server that answers and closes mid-upload makes the
// client's next write fail with EPIPE/ECONNRESET, and browsers then report a network error instead of the 413.
// DRAIN_MAX caps how much a client can make the Mac read for nothing.
const DRAIN_MAX = 2 * UPLOAD_MAX;

function tooLarge(res) {
  res.setHeader('connection', 'close');
  sendJson(res, 413, { error: 'File is larger than 25 MB' });
}

async function upload(req, res) {
  const declared = Number(req.headers['content-length']);
  if (declared > DRAIN_MAX) return tooLarge(res);
  const { file, fd } = openUploadFile(uploadName(req.headers['x-filename']));
  let size = 0;
  const over = () => size > UPLOAD_MAX || declared > UPLOAD_MAX;
  try {
    await pipeline(req, async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > DRAIN_MAX) throw new Error('File is larger than 25 MB');
        if (!over()) yield chunk;
      }
    }, fs.createWriteStream(null, { fd }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    if (over()) return tooLarge(res);
    throw err;
  }
  if (over()) {
    fs.rmSync(file, { force: true });
    return tooLarge(res);
  }
  sendJson(res, 201, { path: file });
}

const sessions = new Map();

// Tabs are named after their folder (or "claude · app" for a resumed conversation); a taken name gets the lowest free
// number, so closing "app 2" makes the next one "app 2" again.
function nextTitle(base) {
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

// Waits for the login shell to print its prompt and go quiet, so the command is not typed into
// a half-initialised shell (slow .zshrc, compinit questions).
function typeWhenIdle(proc, text) {
  let timer = null;
  const done = () => {
    clearTimeout(timer);
    clearTimeout(cap);
    sub.dispose();
    try { proc.write(text); } catch {}
  };
  const sub = proc.onData(() => {
    clearTimeout(timer);
    timer = setTimeout(done, 300);
  });
  const cap = setTimeout(done, 5000);
}

// Shells live in the terminal host, a small process of their own, so they keep running while Pocket Dev restarts for an
// update. If the host cannot start, terminals are plain child processes of this server and end with it.
let terminalHost = null;

function wireSession(session) {
  session.pty.onData((d) => {
    session.activeAt = Date.now();
    appendScrollback(session, d);
    broadcast(session, { t: 'out', d });
  });
  session.pty.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    broadcast(session, { t: 'exit', code: exitCode });
  });
}

async function connectTerminalHost() {
  if (process.env.POCKET_DEV_TERMINAL_HOST === 'off') return null;
  try {
    const host = await openTerminalHost(STATE_DIR);
    // A host that stops answering took its shells with it; their tabs show as exited instead of hanging.
    host.onClose(() => {
      for (const session of sessions.values()) {
        if (!session.remote || session.exitCode !== null) continue;
        session.exitCode = 1;
        broadcast(session, { t: 'exit', code: 1 });
      }
    });
    return host;
  } catch (err) {
    console.warn(`Terminals will end when Pocket Dev restarts: ${err.message}`);
    return null;
  }
}

// Shells that were already running when this server started (an update, a crash) come back as the same tabs, with
// their recent output.
async function adoptTerminals() {
  terminalHost = await connectTerminalHost();
  if (!terminalHost) return;
  for (const meta of await terminalHost.list()) {
    const { pty: proc, scrollback } = await terminalHost.adopt(meta);
    const session = {
      id: meta.id, title: meta.title, cwd: meta.cwd, pty: proc, remote: true, scrollback, clients: new Set(),
      exitCode: meta.exitCode, startedAt: meta.startedAt, activeAt: meta.activeAt,
    };
    wireSession(session);
    sessions.set(session.id, session);
  }
  if (sessions.size) console.log(`Reconnected ${sessions.size} terminal${sessions.size === 1 ? '' : 's'} that kept running.`);
}

// `command`, when given, is typed into the new shell once its prompt is up.
async function createSession(cwd, base = folderName(cwd), command) {
  const shell = process.env.SHELL || '/bin/zsh';
  // launchd and nohup start node without LANG, which makes ls print non-ASCII filenames as ???.
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'xterm-256color' };
  const id = crypto.randomBytes(6).toString('hex');
  const title = nextTitle(base);
  if (terminalHost?.closed) terminalHost = await connectTerminalHost();
  let proc = null;
  if (terminalHost) {
    try {
      proc = await terminalHost.create({ id, title, cwd, shell, env, cols: 80, rows: 24 });
    } catch (err) {
      console.warn(`Could not start the terminal in the host, starting it here instead: ${err.message}`);
    }
  }
  const remote = proc !== null;
  proc ??= pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
  const session = {
    id, title, cwd, pty: proc, remote, scrollback: '', clients: new Set(), exitCode: null, startedAt: Date.now(), activeAt: Date.now(),
  };
  wireSession(session);
  sessions.set(session.id, session);
  if (command) typeWhenIdle(proc, `${command}\r`);
  return session;
}

function killShell(session) {
  if (session.remote) return session.pty.kill();
  try {
    process.kill(-session.pty.pid, 'SIGHUP');
  } catch {
    try { session.pty.kill(); } catch {}
  }
}

function destroySession(session) {
  killShell(session);
  if (session.remote) terminalHost?.forget(session.id);
  for (const ws of session.clients) ws.close(1000, 'session closed');
  sessions.delete(session.id);
}

// Resume's take over moved this terminal's conversation elsewhere. The shell ends and the tab stays, saying why.
function endSession(id, note) {
  const session = sessions.get(id);
  if (!session || session.exitCode !== null) return false;
  const line = `\r\n\x1b[2m[${note}]\x1b[0m\r\n`;
  appendScrollback(session, line);
  broadcast(session, { t: 'out', d: line });
  killShell(session);
  return true;
}

// `persistent` tells the phone whether this terminal keeps running through an update.
const sessionView = ({ id, title, exitCode, cwd, startedAt, activeAt, remote }) => ({ id, title, exitCode, cwd, startedAt, activeAt, persistent: remote === true });

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
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }
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

// A forward listens on the Mac's LAN address, which changes with the network. Each one is open (listening on host),
// waiting (no network), or error (the bind on host failed); watchLanIp moves every forward when the address changes.
const forwardView = (port, { state, host, error }) => ({ port, state, url: state === 'open' ? `http://${host}:${port}` : null, error });
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

function stopListening(fwd) {
  fwd.server?.close();
  for (const s of fwd.sockets) s.destroy();
  fwd.server = null;
}

async function listenOn(fwd, port, host) {
  stopListening(fwd);
  Object.assign(fwd, { host, state: 'waiting', error: null });
  if (!host || fwd.closed) return;
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    fwd.sockets.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => fwd.sockets.delete(client));
    pipeToLocalhost(client, port, fwd.sockets);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    Object.assign(fwd, { state: 'error', error: forwardError(err, port, host) });
    return;
  }
  if (fwd.closed) return server.close();
  Object.assign(fwd, { server, state: 'open' });
}

// Moves are chained per forward so an address change during a bind cannot leave two listeners.
function moveForward(fwd, port, host) {
  fwd.moving = fwd.moving.then(() => listenOn(fwd, port, host));
  return fwd.moving;
}

async function openForward(port) {
  const existing = forwards.get(port);
  if (existing) return forwardView(port, existing);
  const fwd = { server: null, host: null, sockets: new Set(), state: 'waiting', error: null, closed: false, moving: Promise.resolve() };
  await moveForward(fwd, port, lanIp());
  if (fwd.state === 'error') throw new Error(fwd.error);
  forwards.set(port, fwd);
  return forwardView(port, fwd);
}

function closeForward(port) {
  const fwd = forwards.get(port);
  if (!fwd) return false;
  fwd.closed = true;
  stopListening(fwd);
  forwards.delete(port);
  return true;
}

function forwardError(err, port, host) {
  if (err.code === 'EADDRINUSE') {
    return `Port ${port} is already in use on ${host}. If your dev server listens on all interfaces (0.0.0.0), it is already reachable at http://${host}:${port} without a forward.`;
  }
  if (err.code === 'EACCES') return `Not allowed to listen on port ${port} (ports below 1024 need root).`;
  return `Could not open port ${port} on ${host}: ${err.message}`;
}

const IP_POLL_MS = Number(process.env.POCKET_DEV_IP_POLL_MS) || 10_000;
function watchLanIp() {
  let current = lanIp();
  setInterval(() => {
    const ip = lanIp();
    if (ip === current) return;
    console.log(`LAN address changed from ${current ?? 'none'} to ${ip ?? 'none'}.${ip ? ` Pocket Dev is now at http://${ip}:${PORT}` : ' Port forwards wait for a network.'}`);
    current = ip;
    for (const [port, fwd] of forwards) moveForward(fwd, port, ip);
  }, IP_POLL_MS).unref();
}

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function readJson(req) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(httpError(415, 'Send the body as JSON with content-type: application/json.'));
  }
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

// Forwarded dev servers on other ports of this IP are same-site, so their pages can send simple cross-origin requests
// (form posts, text/plain fetches) that carry the cookie. A custom header makes the browser ask first with a CORS
// preflight, which Pocket Dev never grants, so only Pocket Dev's own pages can change anything.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_HEADER = 'x-pocket-dev';

async function handleApi(req, res, url) {
  const [, , resource, key] = url.pathname.split('/');
  const route = `${req.method} ${resource}${key ? '/:key' : ''}`;
  if (MUTATING.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
    return sendJson(res, 403, { error: 'This page is older than the server. Reload Pocket Dev and try again.' });
  }
  if (MUTATING.has(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request refused.' });

  if (url.pathname === '/api/invitations/accept' && req.method === 'POST') {
    const r = collaborators.accept(req, await readJson(req));
    return sendJson(res, r.status, r.body, r.headers);
  }
  // This policy runs before auth-owned settings and phone-admin routes too.
  // Even an expired guest cookie must not fall through into an owner session.
  const guest = collaborators.guest(req);
  if (guest) {
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const r = collaborators.logout(req);
      return sendJson(res, r.status, r.body, r.headers);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, { status: guest.active ? 'active' : 'expired', role: guest.grant?.role || 'guest' });
    if (req.method === 'GET' && url.pathname === '/api/current-access') return sendJson(res, 200, collaborators.currentAccess(req));
    if (/^\/api\/files\/(places|list|download|zip|search|upload|mkdir|rename|trash)$/.test(url.pathname)) return handleFiles(req, res, url, collaborators.scope(req, res));
    if (resource === 'messages') return messages.handleApi(req, res);
    return sendJson(res, 403, { error: 'Your role does not allow this action.' });
  }

  const authReply = await auth.handleApi(req, url.pathname, () => readJson(req));
  if (authReply) return sendJson(res, authReply.status, authReply.body, authReply.headers);
  if (resource === 'local' && key === 'power') {
    if (!auth.isLocalRequest(req)) return sendJson(res, 403, { error: 'Only a script run on the Mac can use this.' });
    return handlePowerApi(req, res, url.pathname.split('/')[4], { readJson, sendJson, wss, sessions });
  }
  if (!auth.deviceFor(req)) return sendJson(res, 401, { error: 'Not logged in' });
  if (resource === 'collaborators') {
    if (!auth.isTrustedAdmin(req) && !(req.method === 'GET' && url.pathname === '/api/collaborators' && config.read().roleAccessEnabled !== true)) return sendJson(res, 403, { error: 'Only a reviewed Admin device may manage collaborators. Enable access from Admin on the Mac.' });
    const r = await collaborators.ownerApi(req.method, url.pathname, ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {});
    return sendJson(res, r.status, r.body);
  }
  const adminReply = await admin.phoneApi(req, url.pathname, () => readJson(req));
  if (adminReply) return sendJson(res, adminReply.status, adminReply.body);
  if (resource === 'git') {
    const { status, body } = await handleGit(req.method, url, () => readJson(req));
    return sendJson(res, status, body);
  }
  if (resource === 'history') return handleHistory(req, res, url.pathname);
  if (resource === 'apps') return handleApps(req, res, url);
  if (resource === 'power') return handlePowerApi(req, res, key, { readJson, sendJson, wss, sessions });
  if (resource === 'chat') return chatApi.handleApi(req, res, url.pathname);
  if (resource === 'files') return handleFiles(req, res, url);
  if (resource === 'messages') return messages.handleApi(req, res);

  switch (route) {
    case 'GET health':
      return sendJson(res, 200, await collectHealth());
    case 'GET screen': {
      if (config.read().screenView === false) return sendJson(res, 403, { error: 'Screen view is turned off. On the Mac, run: pocket-dev config set screenView true' });
      try {
        const jpeg = await captureScreen();
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, 'cache-control': 'no-store' });
        return res.end(jpeg);
      } catch (err) {
        return sendJson(res, 503, { error: err.message });
      }
    }
    case 'GET sessions':
      return sendJson(res, 200, [...sessions.values()].map(sessionView));
    case 'POST sessions': {
      const { cwd = HOME, command } = await readJson(req);
      const dir = resolveDir(cwd);
      if (!dir) return sendJson(res, 400, { error: `Not a folder: ${cwd}` });
      if (command !== undefined && !isShortcut(command)) return sendJson(res, 400, { error: 'command must be one line of 1 to 200 characters.' });
      const session = await createSession(dir, undefined, command);
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
        return sendJson(res, 409, { error: err.message });
      }
    }
    case 'DELETE forwards/:key':
      return closeForward(Number(key)) ? sendJson(res, 204) : sendJson(res, 404, { error: 'Not forwarded' });
    case 'GET info':
      return sendJson(res, 200, { lanIp: lanIp(), forwards: listForwards(), persistentTerminals: Boolean(terminalHost && !terminalHost.closed) });
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

const handleGit = createGitApi({ config });
const handleHistory = createHistoryApi({
  createSession, sessionView, sendJson, readJson, deviceFor: auth.deviceFor, log: auth.admin.log,
  own: {
    terminals: () => [...sessions.values()].filter((s) => s.exitCode === null).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, pid: s.pty.pid, activeAt: s.activeAt })),
    endTerminal: endSession,
    chats: () => chatApi.bound(),
    releaseChat: (id, note) => chatApi.release(id, note),
  },
});
const handleApps = createAppsApi({ sendJson });
const handleFiles = createFilesApi({ sendJson, readJson, config });

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html',
  '/vendor/xterm/xterm.js': 'vendor/xterm/xterm.js', '/vendor/xterm/xterm.css': 'vendor/xterm/xterm.css',
  '/vendor/xterm/addon-fit.js': 'vendor/xterm/addon-fit.js',
  '/git.js': 'git.js', '/graph.js': 'graph.js', '/git.css': 'git.css',
  '/history.js': 'history.js', '/history.css': 'history.css',
  '/settings.js': 'settings.js', '/settings.css': 'settings.css',
  '/apps.js': 'apps.js', '/apps.css': 'apps.css', '/screen.js': 'screen.js', '/screen.css': 'screen.css', '/health.js': 'health.js', '/health.css': 'health.css', '/macstatus.js': 'macstatus.js', '/macstatus.css': 'macstatus.css', '/power.js': 'power.js', '/service.js': 'service.js',
  '/chat.js': 'chat.js', '/chat.css': 'chat.css', '/files.js': 'files.js', '/files.css': 'files.css',
  '/connection.js': 'connection.js', '/messages.js': 'messages.js', '/messages.css': 'messages.css',
  '/collaborators.js': 'collaborators.js', '/collaborators.css': 'collaborators.css',
  '/invite': 'invite.html', '/invite.js': 'invite.js', '/guest.js': 'guest.js', '/guest.css': 'guest.css',
};
const PUBLIC_PAGES = new Set(['login.html', 'invite.html', 'invite.js', 'guest.css']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function servePage(req, res, pathname) {
  const guest = collaborators.guest(req);
  const file = guest && pathname === '/' ? 'guest.html' : PAGES[pathname];
  if (!file || req.method !== 'GET') return sendJson(res, 404, { error: 'Not found' });
  if (guest && !new Set(['guest.html', 'guest.js', 'guest.css', 'files.js', 'files.css', 'invite.html', 'invite.js', 'connection.js', 'messages.js', 'messages.css']).has(file)) return sendJson(res, 403, { error: 'Your role does not allow this page.' });
  if (!guest && !PUBLIC_PAGES.has(file) && !auth.deviceFor(req)) {
    if (!file.endsWith('.html')) return sendJson(res, 401, { error: 'Not logged in' });
    res.writeHead(302, { location: '/login.html' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
  fs.createReadStream(path.join(ROOT, 'public', file)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    return res.end(MISDIRECTED);
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' && url.searchParams.has('k')) {
      if (collaborators.guest(req)) return sendJson(res, 403, { error: 'Log out collaborator access before pairing an Admin device on the Mac.' });
      const { status, headers, body } = auth.redeemQrKey(req, url.searchParams.get('k'));
      res.writeHead(status, { 'cache-control': 'no-store', ...headers });
      res.end(body);
    } else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else servePage(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status ?? 400, { error: err.message });
  }
});

// Terminal and chat sockets share this server, so a disconnect, sleep or shutdown that closes wss.clients closes both.
const wss = new WebSocketServer({ noServer: true });
const chatApi = createChatApi({ sendJson, readJson, config, wss });

const rejectUpgrade = (socket, status, text) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};
const messages = createMessages({ auth, collaborators, config, wss, rejectUpgrade });

server.on('upgrade', (req, socket, head) => {
  if (!hostAllowed(req.headers.host)) return rejectUpgrade(socket, 421, 'Misdirected Request');
  if (new URL(req.url, 'http://localhost').pathname === '/ws/messages') return messages.handleUpgrade(req, socket, head);
  if (collaborators.guest(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  const { pathname } = new URL(req.url, 'http://localhost');
  const match = /^\/ws\/([0-9a-f]+)$/.exec(pathname);
  const device = auth.deviceFor(req);
  if (!device) return rejectUpgrade(socket, 401, 'Unauthorized');
  // SameSite=Strict should already block cross-site upgrades; the Origin check is the backstop.
  if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  const chatMatch = /^\/ws\/chat\/([0-9a-f]{12})$/.exec(pathname);
  if (chatMatch) return chatApi.handleUpgrade(req, socket, head, chatMatch[1], (ws) => auth.trackSocket(device, ws));
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

await adoptTerminals();
startPower(config);
watchLanIp();

const CHAT_STATUS = { running: 'running', 'waiting-permission': 'waiting for you (permission)', 'waiting-answer': 'waiting for you (question)' };
const AWAKE_LABELS = { off: 'Off', plugged: 'While plugged in', always: 'Always' };
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
// Listing apps runs osascript; the admin page polls, so one listing serves every poll for a few seconds.
const APPS_CACHE_MS = 10_000;
let appsCache = { at: 0, value: null };
async function cachedApps() {
  if (!appsCache.value || Date.now() - appsCache.at > APPS_CACHE_MS) appsCache = { at: Date.now(), value: appsSnapshot() };
  return appsCache.value;
}

// The admin page's live overview. A feature adds an entry here to show up there; see startAdmin in admin.js.
// A section without act() is read-only: it shows what is happening and points to the phone for changes.
const adminSections = {
  terminals: {
    title: 'Terminals',
    empty: 'No terminals open.',
    action: 'Close',
    warning: 'Anything running in it is killed.',
    lockdown: 'optional',
    list: () => [...sessions.values()].map((s) => ({
      id: s.id,
      label: s.title,
      details: [s.cwd, plural(s.clients.size, 'client'), ...(s.exitCode !== null ? [`exited ${s.exitCode}`] : [])],
      startedAt: s.startedAt,
      running: s.exitCode === null,
      persistent: s.remote === true,
    })),
    act: (id) => {
      const session = sessions.get(id);
      if (session) destroySession(session);
      return Boolean(session);
    },
  },
  ports: {
    title: 'Port forwards',
    empty: 'No ports forwarded.',
    action: 'Stop',
    warning: 'Phones lose access to it until you open the port again.',
    lockdown: 'always',
    list: () => listForwards().map((f) => ({ id: String(f.port), label: `:${f.port}`, details: [f.url ?? f.error ?? 'waiting for a network'] })),
    act: (id) => closeForward(Number(id)),
  },
  power: {
    title: 'Power',
    empty: 'No power information.',
    async list() {
      const p = await powerStatus();
      const battery = p.battery === null ? (p.onAC ? 'On power adapter' : 'No battery') : `Battery ${p.battery}%${p.charging ? ', charging' : p.onAC ? ', plugged in' : ''}`;
      return [{
        id: 'awake',
        label: `Keep awake: ${AWAKE_LABELS[p.awake]}${p.stayingAwake ? ' (holding the Mac awake)' : ''}`,
        details: [battery, p.lidClosed ? 'Lid closed' : 'Lid open', `Lid sleep ${p.lidSleepDisabled ? 'off' : 'on'}`],
      }];
    },
  },
  apps: {
    title: 'Open apps',
    empty: 'No open apps.',
    async list() {
      const { apps } = await cachedApps();
      return [{ id: 'count', label: plural(apps.length, 'app') + ' open', details: ['Quit or force quit them from the phone: Settings, Open apps'] }];
    },
  },
  chats: {
    title: 'Chats',
    empty: 'No chat is running or waiting.',
    action: 'Stop',
    warning: 'The turn stops; the chat stays and you can send the next message from the phone.',
    lockdown: 'optional',
    list: () => chatApi.active().map((c) => ({
      id: c.id,
      label: c.title || 'New chat',
      details: [c.tool === 'codex' ? 'Codex' : 'Claude', CHAT_STATUS[c.status], c.cwd],
      startedAt: c.runningSince ?? undefined,
    })),
    act: (id) => chatApi.stop(id),
  },
  conversations: handleHistory.openHere,
};

const access = createPhoneAccess({
  server, wss, port: PORT, config, log: auth.admin.log,
  onClose: () => tunnel.stop(),
  forwards: { ports: () => [...forwards.keys()], open: openForward, close: closeForward },
});
tunnel = createTunnel({ port: PORT, isConnected: () => access.view().connected, log: auth.admin.log });
process.once('exit', () => tunnel.dispose());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { tunnel.dispose(); process.exit(0); });
const admin = await startAdmin({ auth, collaborators, messages, access, tunnel, config, mainPort: PORT, urls, sections: adminSections }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
const opened = await access.start();
if (opened.error) {
  console.error(`${opened.error} Phone access stays off until then.`);
} else if (access.view().connected) {
  console.log(await terminalQr(auth.mintQrUrl()));
  const { lan, local } = urls();
  console.log(`Pocket Dev running at ${lan ?? local}`);
  if (lan) console.log(`Also at ${local} (${LOCAL_NOTE})`);
} else {
  console.log('Phone access is off. Press Connect on the admin page to let your phone in.');
}
console.log(auth.passwordLine);
if (access.view().connected) console.log(qrNote(QR_TTL_MIN));
console.log(admin.line);
if (!access.view().connected || !access.view().keepOpen) admin.openPage();
