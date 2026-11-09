import { spawn } from 'node:child_process';
import { findCloudflared } from './network.js';
import { platform } from './platform.js';

const INSTALL_HINT = { darwin: 'brew install cloudflared', win32: 'winget install Cloudflare.cloudflared' };
const NOT_INSTALLED = INSTALL_HINT[platform.platform]
  ? `cloudflared is not installed. On ${platform.host.this} run: ${INSTALL_HINT[platform.platform]}, then try again.`
  : 'cloudflared is not installed. Install it from developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads, then try again.';

// A Quick Tunnel gets a random trycloudflare.com address and is deliberately on demand: restarting Pocket Dev never
// publishes it automatically. A domain tunnel runs with the token from the Cloudflare dashboard, passed in the
// environment so it never shows in `ps`, and is reachable at the hostname the person gave that tunnel.
export function createTunnel({ port, isConnected, network, token, log = () => {}, spawnProcess = spawn,
  executable = findCloudflared, startupMs = 60_000, stopMs = 3000 }) {
  let child = null;
  let status = 'off';
  let kind = null;
  let url = null;
  let error = null;
  let timer;
  const view = () => ({ status, kind, url, error });
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
    log('remote-error', { kind, error: message });
  }

  const start = serial(() => {
    const { internet } = network();
    if (internet.kind === 'off') throw new Error(`Internet access is off. Turn it on in Admin on ${platform.host.the} first.`);
    if (!isConnected()) throw new Error('Connect phone access before starting remote access.');
    if (child) return view();
    const secret = internet.kind === 'domain' ? token() : null;
    if (internet.kind === 'domain' && !secret) throw new Error('No tunnel token is saved. Paste the token from the Cloudflare dashboard first.');
    status = 'starting';
    kind = internet.kind;
    url = null;
    error = null;
    const file = executable();
    if (!file) {
      status = 'error';
      error = NOT_INSTALLED;
      return view();
    }
    let proc;
    try {
      proc = spawnProcess(file, ['tunnel', '--no-autoupdate', ...(kind === 'domain' ? ['run'] : ['--url', `http://127.0.0.1:${port}`])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(secret && { TUNNEL_TOKEN: secret }) },
      });
    } catch (err) {
      status = 'error';
      error = err.message;
      return view();
    }
    child = proc;
    let registered = false;
    let found = kind === 'domain' ? `https://${internet.hostname}` : null;
    let lastLine = '';
    const read = () => {
      let pending = '';
      return (chunk) => {
        if (child !== proc) return;
        pending = (pending + chunk).slice(-16_384);
        // Keep a partial line: process output can split the hostname or registration message anywhere.
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (line.trim()) lastLine = line.trim().slice(0, 300);
          const quick = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=[\s/|]|$)/i.exec(line);
          if (quick) found = `https://${quick[1].toLowerCase()}`;
          if (line.includes('Registered tunnel connection')) registered = true;
          if (registered && found && status !== 'connected') {
            clearTimeout(timer);
            status = 'connected';
            url = found;
            log('remote-started', { kind, url });
          }
        }
      };
    };
    proc.stdout.on('data', read());
    proc.stderr.on('data', read());
    proc.once('error', (err) => fail(proc, err.code === 'ENOENT' ? NOT_INSTALLED : err.message));
    proc.once('exit', (code, signal) => fail(proc, `Remote access stopped (${signal || `exit ${code}`})${lastLine ? `: ${lastLine}` : ''}. Start it again${kind === 'quick' ? ' for a new link' : ''}.`));
    timer = setTimeout(() => fail(proc, `Could not connect to Cloudflare within 60 seconds. Check ${platform.host.the}’s internet connection and try again.`), startupMs).unref();
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
      log('remote-stopped', { kind });
    }
    kind = null;
    return view();
  });

  return { start, stop, view, dispose() { child?.kill(); } };
}
