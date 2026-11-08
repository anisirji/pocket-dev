const HEARTBEAT_TIMEOUT_MS = Number(process.env.POCKET_DEV_HEARTBEAT_TIMEOUT_MS) || 30_000;
const HEARTBEAT_EVERY_MS = Math.min(10_000, Math.round(HEARTBEAT_TIMEOUT_MS / 3));

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const savedAccess = (a) => ({ connected: a?.connected !== false, keepOpen: a?.keepOpen !== false });

// `lsof -F pc` prints p<pid> and c<command> lines for each listener.
async function portOwner(port) {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc']);
    const pid = /^p(\d+)$/m.exec(stdout)?.[1];
    const command = /^c(.+)$/m.exec(stdout)?.[1];
    return pid ? ` by ${command ?? 'a process'} (pid ${pid})` : '';
  } catch {
    return '';
  }
}

async function listenError(err, port) {
  if (err.code === 'EADDRINUSE') return `Port ${port} is in use${await portOwner(port)}. Quit it, then press Connect to try again.`;
  if (err.code === 'EACCES') return `Not allowed to listen on port ${port}.`;
  return `Could not open port ${port}: ${err.message}`;
}

// Phone access is the listener on 0.0.0.0:<port>. Disconnected means that port is closed, so nothing on the network
// reaches Pocket Dev; terminals keep running. With keepOpen off, access lasts only while the admin page sends heartbeats.
// `forwards` reopens the port forwards that were open at the last disconnect. `onOpen` runs once the port is open
// (the domain tunnel starts there) and `onClose` before it closes.
export function createPhoneAccess({ server, wss, port, host = '0.0.0.0', config, forwards, log, onOpen = async () => {}, onClose = async () => {} }) {
  const saved = savedAccess(config.read().access);
  let connected = false;
  let keepOpen = saved.keepOpen;
  let lastError = null;
  let lastBeat = Date.now();
  let reopen = [];
  const conns = new Set();
  server.on('connection', (socket) => {
    conns.add(socket);
    socket.on('close', () => conns.delete(socket));
  });

  // Connect and Disconnect can arrive together (a double click, the CLI, the heartbeat timer); run them one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  function persist() {
    config.update({ access: { connected, keepOpen } });
  }

  const open = serial(async (by) => {
    if (connected) return { ok: true };
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
    } catch (err) {
      lastError = await listenError(err, port);
      return { error: lastError };
    }
    connected = true;
    lastError = null;
    lastBeat = Date.now();
    for (const p of reopen) await forwards.open(p).catch(() => {});
    reopen = [];
    persist();
    log('access-connected', { by, port });
    await onOpen().catch(() => {});
    return { ok: true };
  });

  const close = serial(async (by) => {
    if (!connected) return { ok: true };
    connected = false;
    await onClose();
    reopen = forwards.ports();
    for (const p of reopen) forwards.close(p);
    const closed = new Promise((resolve) => server.close(resolve));
    for (const ws of wss.clients) ws.terminate();
    for (const socket of conns) socket.destroy();
    await closed;
    persist();
    log('access-disconnected', { by, port });
    return { ok: true };
  });

  setInterval(() => {
    if (connected && !keepOpen && Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) close('heartbeat');
  }, Math.min(5000, HEARTBEAT_EVERY_MS)).unref();

  return {
    open,
    close,
    // With keepOpen off, a restart starts disconnected: nobody has the admin page open yet.
    start: () => (saved.connected && saved.keepOpen ? open('startup') : Promise.resolve({ ok: true })),
    heartbeat() {
      lastBeat = Date.now();
    },
    setKeepOpen(on, by) {
      if (on === keepOpen) return;
      keepOpen = on;
      lastBeat = Date.now();
      persist();
      log('keep-open-changed', { on, by });
    },
    // Lockdown stops forwards for good, including the ones a later Connect would reopen.
    forgetForwards() {
      reopen = [];
    },
    view: () => ({ connected, keepOpen, port, error: lastError, heartbeatEveryMs: HEARTBEAT_EVERY_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS }),
  };
}
