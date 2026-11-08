import { spawn } from 'node:child_process';

// Quick Tunnels are deliberately on demand: restarting Pocket Dev never publishes it automatically.
export function createTunnel({ port, isConnected, log = () => {}, spawnProcess = spawn,
  executable = process.env.POCKET_DEV_CLOUDFLARED || '/opt/homebrew/bin/cloudflared', startupMs = 60_000, stopMs = 3000 }) {
  let child = null;
  let status = 'off';
  let url = null;
  let error = null;
  let timer;
  const view = () => ({ status, url, error });
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const result = queue.then(() => fn(...args));
    queue = result.catch(() => {});
    return result;
  };

  function fail(proc, message) {
    if (child !== proc) return;
    clearTimeout(timer);
    child = null;
    status = 'error';
    url = null;
    error = message;
    proc.kill();
    log('remote-error', { error: message });
  }

  const start = serial(() => {
    if (!isConnected()) throw new Error('Connect phone access before starting remote access.');
    if (child) return view();
    status = 'starting';
    url = null;
    error = null;
    let proc;
    try {
      proc = spawnProcess(executable, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = 'error';
      error = err.message;
      return view();
    }
    child = proc;
    let registered = false;
    const read = () => {
      let pending = '';
      return (chunk) => {
        if (child !== proc) return;
        pending = (pending + chunk).slice(-16_384);
        // Keep a partial line: process output can split the hostname or registration message anywhere.
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          const found = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=[\s/|]|$)/i.exec(line);
          if (found) url = `https://${found[1].toLowerCase()}`;
          if (line.includes('Registered tunnel connection')) registered = true;
          if (registered && url && status !== 'connected') {
            clearTimeout(timer);
            status = 'connected';
            log('remote-started', { url });
          }
        }
      };
    };
    proc.stdout.on('data', read());
    proc.stderr.on('data', read());
    proc.once('error', (err) => fail(proc, err.code === 'ENOENT'
      ? 'cloudflared is not installed. On this Mac run: brew install cloudflared, then try again.' : err.message));
    proc.once('exit', (code, signal) => fail(proc, `Remote access stopped (${signal || `exit ${code}`}). Start it again for a new link.`));
    timer = setTimeout(() => fail(proc, 'Could not connect to Cloudflare within 60 seconds. Check the Mac’s internet connection and try again.'), startupMs).unref();
    return view();
  });

  const stop = serial(async () => {
    const proc = child;
    child = null;
    clearTimeout(timer);
    status = 'off';
    url = null;
    error = null;
    if (proc) {
      await new Promise((resolve) => {
        const force = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, stopMs);
        proc.once('exit', () => { clearTimeout(force); resolve(); });
        proc.kill();
      });
      log('remote-stopped');
    }
    return view();
  });

  return { start, stop, view, dispose() { child?.kill(); } };
}
