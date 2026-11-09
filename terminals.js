import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platform } from './platform.js';

const HOST_FILE = fileURLToPath(new URL('./terminal-host.js', import.meta.url));
const PROTOCOL = 1;
const REQUEST_MS = 10_000;
const START_WAIT_MS = 6000;
const SOCKET_PATH_MAX = 90;

// A unix socket path is limited to about 100 characters; a long state folder falls back to a short name in the temp folder.
export function hostSocketPath(stateDir) {
  if (platform.platform === 'win32') return `\\\\.\\pipe\\pocket-dev-${crypto.createHash('sha1').update(stateDir).digest('hex').slice(0, 12)}`;
  const preferred = path.join(stateDir, 'terminals.sock');
  if (preferred.length <= SOCKET_PATH_MAX) return preferred;
  return path.join(os.tmpdir(), `pd-${crypto.createHash('sha1').update(stateDir).digest('hex').slice(0, 12)}.sock`);
}

// Stands in for a node-pty process: same write/resize/onData/onExit surface, but the shell lives in the terminal host.
class RemotePty {
  constructor(host, meta) {
    this.host = host;
    this.id = meta.id;
    this.pid = meta.pid;
    this.cols = meta.cols;
    this.rows = meta.rows;
    this.live = true;
    this.dataFns = new Set();
    this.exitFns = new Set();
  }

  onData(fn) { this.dataFns.add(fn); return { dispose: () => this.dataFns.delete(fn) }; }
  onExit(fn) { this.exitFns.add(fn); return { dispose: () => this.exitFns.delete(fn) }; }
  write(d) { this.host.send({ t: 'input', id: this.id, d }); }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.host.send({ t: 'resize', id: this.id, cols, rows });
  }
  kill() { this.host.send({ t: 'kill', id: this.id }); }
}

class HostClient {
  constructor(sock) {
    this.sock = sock;
    this.buffer = '';
    this.pending = new Map();
    this.ptys = new Map();
    this.closeFns = new Set();
    this.closed = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => this.read(chunk));
    sock.on('error', () => {});
    sock.on('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('The terminal host went away')); }
      this.pending.clear();
      for (const fn of this.closeFns) fn();
    });
  }

  onClose(fn) { this.closeFns.add(fn); }

  send(msg) {
    if (!this.closed) this.sock.write(`${JSON.stringify(msg)}\n`);
  }

  // Frames are handled in order and `onReply` runs the moment the answer arrives, so a terminal is registered
  // before the first byte of its output is read.
  request(msg, onReply = (m) => m) {
    return new Promise((resolve, reject) => {
      const rid = crypto.randomBytes(4).toString('hex');
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error(`The terminal host did not answer ${msg.t}`)); }, REQUEST_MS);
      this.pending.set(rid, { resolve, reject, timer, onReply });
      this.send({ ...msg, rid });
    });
  }

  read(chunk) {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf('\n'); nl !== -1; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      try { this.handle(JSON.parse(line)); } catch (err) { console.error(`Bad frame from the terminal host: ${err.message}`); }
    }
  }

  handle(msg) {
    if (msg.t === 'out') return void (this.ptys.get(msg.id)?.live && [...this.ptys.get(msg.id).dataFns].forEach((fn) => fn(msg.d)));
    if (msg.t === 'exit') return void this.ptys.get(msg.id)?.exitFns.forEach((fn) => fn({ exitCode: msg.code }));
    const entry = this.pending.get(msg.rid);
    if (!entry) return undefined;
    this.pending.delete(msg.rid);
    clearTimeout(entry.timer);
    if (msg.t === 'error') return entry.reject(new Error(msg.message));
    try { return entry.resolve(entry.onReply(msg)); } catch (err) { return entry.reject(err); }
  }

  list() { return this.request({ t: 'list' }, (m) => m.terminals); }

  // Starts a shell in the host and returns the stand-in for its pty.
  create(spec) {
    return this.request({ t: 'create', ...spec }, (m) => {
      const remote = new RemotePty(this, m);
      this.ptys.set(m.id, remote);
      return remote;
    });
  }

  // A terminal that was already running (before this Pocket Dev started). Output is held back until its saved
  // scrollback arrives, so nothing is shown twice, and everything after that is live.
  async adopt(meta) {
    const remote = new RemotePty(this, meta);
    remote.live = false;
    this.ptys.set(meta.id, remote);
    const scrollback = await this.request({ t: 'replay', id: meta.id }, (m) => {
      remote.live = true;
      return m.d;
    });
    return { pty: remote, scrollback };
  }

  forget(id) { this.ptys.delete(id); }
  shutdown() { return this.request({ t: 'shutdown' }).catch(() => {}); }
  close() { this.sock.destroy(); }
}

function attach(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.once('error', reject);
    sock.once('connect', async () => {
      const host = new HostClient(sock);
      try {
        const hello = await host.request({ t: 'hello' });
        if (hello.protocol !== PROTOCOL) throw Object.assign(new Error(`The terminal host speaks protocol ${hello.protocol}, this Pocket Dev needs ${PROTOCOL}`), { fatal: true });
        resolve(host);
      } catch (err) {
        sock.destroy();
        reject(err);
      }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startHost = (socketPath, stateDir) => spawn(process.execPath, [HOST_FILE, socketPath], { detached: true, stdio: 'ignore', cwd: stateDir }).unref();

// Nobody is listening yet: a unix socket that does not exist or refuses, or a Windows pipe that does not exist.
const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED']);

// Connects to the host, starting it if nothing listens. A host that was just started needs a moment before it
// listens, and a Windows pipe can also answer EBUSY or EPIPE between two clients, so a failed connect is retried with
// a growing pause (50 ms doubling to 400 ms) until `waitMs` has passed. A host that answers with the wrong protocol
// is not retried. `connect`, `start`, `pause` and `now` can be replaced in tests.
export async function connectToHost(socketPath, { connect = attach, start = () => {}, pause = sleep, now = Date.now, waitMs = START_WAIT_MS } = {}) {
  let lastError;
  try {
    return await connect(socketPath);
  } catch (err) {
    if (err.fatal) throw err;
    lastError = err;
    if (!err.code || NOT_LISTENING.has(err.code)) start();
  }
  const deadline = now() + waitMs;
  for (let delay = 50; now() < deadline; delay = Math.min(delay * 2, 400)) {
    await pause(delay);
    try { return await connect(socketPath); } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
    }
  }
  throw new Error(`The terminal host did not start: ${lastError?.message ?? 'no answer'}`);
}

// Connects to the terminal host for this state folder, starting it (detached, in its own session so a launchd restart
// of Pocket Dev does not take it down) if it is not running.
export function openTerminalHost(stateDir) {
  const socketPath = hostSocketPath(stateDir);
  return connectToHost(socketPath, { start: () => startHost(socketPath, stateDir) });
}
