// Holds the terminals' shells in a process of their own, so they keep running while Pocket Dev restarts for an update.
// server.js starts this detached and talks to it over a unix socket (see terminals.js). Run as:
//   node terminal-host.js <socket path>
// It changes rarely on purpose: replacing it ends the shells it holds.
import net from 'node:net';
import fs from 'node:fs';
import pty from 'node-pty';

export const PROTOCOL = 1;
const SCROLLBACK_MAX = 500_000;
const IDLE_EXIT_MS = Number(process.env.POCKET_DEV_HOST_IDLE_MS) || 10 * 60_000;
const isDim = (n) => Number.isInteger(n) && n >= 10 && n <= 500;

function main(socketPath) {
  const terminals = new Map();
  let client = null;
  let lastSeen = Date.now();

  const send = (msg) => {
    if (client && !client.destroyed) client.write(`${JSON.stringify(msg)}\n`);
  };
  const meta = (t) => ({ id: t.id, title: t.title, cwd: t.cwd, startedAt: t.startedAt, activeAt: t.activeAt, exitCode: t.exitCode, cols: t.cols, rows: t.rows, pid: t.proc.pid });

  // Cut at a line boundary so a replay rarely starts inside an escape sequence.
  function append(t, chunk) {
    let buf = t.scrollback + chunk;
    if (buf.length > SCROLLBACK_MAX) {
      const start = buf.length - SCROLLBACK_MAX;
      const nl = buf.indexOf('\n', start);
      buf = buf.slice(nl === -1 ? start : nl + 1);
    }
    t.scrollback = buf;
  }

  function quit() {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  }

  function killTerminal(t) {
    try { process.kill(-t.proc.pid, 'SIGHUP'); } catch { try { t.proc.kill(); } catch {} }
    terminals.delete(t.id);
  }

  function create({ rid, id, title, cwd, shell, env, cols, rows }) {
    const valid = /^[0-9a-f]{12}$/.test(id) && !terminals.has(id) && typeof shell === 'string' && shell.startsWith('/')
      && typeof cwd === 'string' && typeof title === 'string' && env && typeof env === 'object' && isDim(cols) && isDim(rows);
    if (!valid) return send({ t: 'error', rid, message: 'Bad create request' });
    let proc;
    try {
      proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env });
    } catch (err) {
      return send({ t: 'error', rid, message: err.message });
    }
    const t = { id, title, cwd, proc, cols, rows, scrollback: '', exitCode: null, startedAt: Date.now(), activeAt: Date.now() };
    terminals.set(id, t);
    proc.onData((d) => {
      t.activeAt = Date.now();
      append(t, d);
      send({ t: 'out', id, d });
    });
    proc.onExit(({ exitCode }) => {
      t.exitCode = exitCode;
      send({ t: 'exit', id, code: exitCode });
    });
    send({ t: 'created', rid, ...meta(t) });
  }

  function handle(msg) {
    const t = terminals.get(msg.id);
    switch (msg.t) {
      case 'hello': return send({ t: 'hello', rid: msg.rid, protocol: PROTOCOL, pid: process.pid });
      case 'list': return send({ t: 'list', rid: msg.rid, terminals: [...terminals.values()].map(meta) });
      case 'replay': return t ? send({ t: 'replay', rid: msg.rid, id: t.id, d: t.scrollback }) : send({ t: 'error', rid: msg.rid, message: 'No such terminal' });
      case 'create': return create(msg);
      case 'input':
        if (t && t.exitCode === null && typeof msg.d === 'string') try { t.proc.write(msg.d); } catch {}
        return undefined;
      case 'resize':
        if (t && t.exitCode === null && isDim(msg.cols) && isDim(msg.rows)) {
          t.cols = msg.cols;
          t.rows = msg.rows;
          try { t.proc.resize(msg.cols, msg.rows); } catch {}
        }
        return undefined;
      case 'kill':
        if (t) killTerminal(t);
        return send({ t: 'killed', rid: msg.rid, id: msg.id });
      case 'shutdown':
        for (const term of [...terminals.values()]) killTerminal(term);
        send({ t: 'bye', rid: msg.rid });
        return setTimeout(quit, 50);
      default: return undefined;
    }
  }

  const server = net.createServer((sock) => {
    // One Pocket Dev server at a time: a newly started one replaces the one that is going away.
    client?.destroy();
    client = sock;
    lastSeen = Date.now();
    sock.setEncoding('utf8');
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try { handle(JSON.parse(line)); } catch (err) { console.error(`bad message: ${err.message}`); }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (client === sock) client = null;
      lastSeen = Date.now();
    });
  });

  process.umask(0o077);
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));

  // With nothing running and nobody connected for a while, the host has no reason to stay.
  setInterval(() => {
    if (!terminals.size && !client && Date.now() - lastSeen > IDLE_EXIT_MS) quit();
  }, 30_000).unref();

  const stop = () => {
    for (const t of [...terminals.values()]) killTerminal(t);
    quit();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (err) => console.error(`host error: ${err.stack}`));
}

// Another host already answering on this socket means this one is not needed.
const [socketPath] = process.argv.slice(2);
if (!socketPath) {
  console.error('usage: node terminal-host.js <socket path>');
  process.exit(2);
}
const probe = net.connect(socketPath);
probe.once('connect', () => process.exit(0));
probe.once('error', () => {
  fs.rmSync(socketPath, { force: true });
  main(socketPath);
});
