import { spawn } from 'node:child_process';
import readline from 'node:readline';
import WebSocket from 'ws';

// A connection to the shared daemon, or to a private stdio server on older Codex installs.
// Closing a daemon connection must never stop the daemon or its other clients' work.
class CodexRpc {
  constructor(write, close) {
    this.send = write;
    this.disconnect = close;
    this.calls = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  write(message) {
    if (!this.closed) this.send(message);
  }

  call(method, params = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('The Codex connection closed. Send your message again to reconnect.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Codex did not answer ${method} within ${timeoutMs / 1000} seconds.`));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (err) { this.calls.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  receive(line) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) {
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message ?? 'Codex error'));
      else call.resolve(message.result);
    } else this.onMessage?.(message);
  }

  close(error = new Error('The Codex connection closed.'), unexpected = false) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.calls.values()) { clearTimeout(timer); reject(error); }
    this.calls.clear();
    this.disconnect();
    if (unexpected) this.onGone?.(error);
  }
}

async function socketConnection(socketPath) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 2000 });
  const rpc = new CodexRpc((message) => socket.send(JSON.stringify(message)), () => socket.terminate());
  socket.on('message', (data) => rpc.receive(data));
  socket.on('error', (err) => rpc.close(err, true));
  socket.on('close', () => rpc.close(new Error('The shared Codex server disconnected. Send your message again to reconnect.'), true));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  rpc.shared = true;
  return rpc;
}

function stdioConnection(bin, env) {
  if (!bin) throw new Error('codex is not installed (not found on PATH or in ~/.local/bin).');
  const proc = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new CodexRpc((message) => proc.stdin.write(`${JSON.stringify(message)}\n`), () => proc.kill());
  let stderr = '';
  proc.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => rpc.receive(line));
  proc.on('error', (err) => rpc.close(new Error(`Could not start codex app-server: ${err.message}`), true));
  proc.stdin.on('error', (err) => rpc.close(err, true));
  proc.on('exit', (code) => rpc.close(new Error(`codex app-server exited (${code ?? 'signal'})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`), true));
  rpc.shared = false;
  return rpc;
}

export async function connectCodexRpc({ bin, env, socketPath }) {
  let rpc;
  if (socketPath) {
    try { rpc = await socketConnection(socketPath); }
    catch (err) {
      // No daemon (including a stale socket) is normal on older installs. Other failures
      // should be visible rather than silently starting a competing writer.
      if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) throw err;
    }
  }
  rpc ??= stdioConnection(bin, env);
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'pocket-dev', title: 'Pocket Dev', version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, 15_000);
    rpc.write({ method: 'initialized' });
    return rpc;
  } catch (err) { rpc.close(); throw err; }
}
