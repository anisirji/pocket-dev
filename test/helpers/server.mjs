import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Starts a real Pocket Dev server in a throwaway HOME and state folder, with stubs for everything that would touch
// this Mac: power commands, model binaries, and cloudflared. Shared by the internet-access and approval suites.
export const REPO = process.env.TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOSTNAME = 'pocket.example.test';
export const TOKEN = 'eyJhIjoiMDEyMzQ1Njc4OSIsInQiOiJmYWtlLXR1bm5lbC10b2tlbiIsInMiOiJzZWNyZXQifQ';
export const PHONE_IP = '203.0.113.5';
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(50); }
  assert.fail('Condition timed out');
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export const lanAddress = () => Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;

// Answers like Cloudflare's trace endpoint, with the phone's address as this Mac's public address.
export async function traceServer(t, ip = PHONE_IP) {
  const server = http.createServer((req, res) => { server.hits++; res.end(`fl=1f1\nh=1.1.1.1\nip=${ip}\nts=1\n`); });
  server.hits = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/cdn-cgi/trace`, server };
}

// A stand-in for cloudflared: records how it was started, prints what cloudflared prints, and waits to be killed.
// A token that ends in "bad" fails the way an unauthorized tunnel does, and every Quick link start gets a new hostname.
function fakeCloudflared(root) {
  const file = path.join(root, 'cloudflared');
  fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$@" > "$POCKET_DEV_FAKE_CF/argv"
env > "$POCKET_DEV_FAKE_CF/env"
case "$TUNNEL_TOKEN" in *bad) echo "ERR Unauthorized: Failed to get tunnel" >&2; exit 1;; esac
case "$*" in *--url*) n=$(($(cat "$POCKET_DEV_FAKE_CF/starts" 2>/dev/null || echo 0) + 1)); echo "$n" > "$POCKET_DEV_FAKE_CF/starts"; echo "INF |  https://quick-fixture-$n.trycloudflare.com  |" >&2;; esac
echo "INF Registered tunnel connection connIndex=0" >&2
exec sleep 300
`, { mode: 0o700 });
  return file;
}

export async function startServer(t, { network, devices, token, lanIpFile = true, traceUrl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-internet-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state'), record = path.join(root, 'cloudflared-record');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, 'Desktop'));
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(record);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ password: 'test-password', awake: 'off', fileRoots: [home], maxDevices: 20, ...(network && { network }) }));
  if (devices) fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ devices }));
  if (token) fs.writeFileSync(path.join(state, 'tunnel-token'), `${token}\n`, { mode: 0o600 });
  const lanIp = path.join(root, 'lan-ip');
  fs.writeFileSync(lanIp, '127.0.0.1');
  const port = await freePort(), adminPort = await freePort();
  const stub = path.join(root, 'read-only-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "No\\n"\n', { mode: 0o700 });
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: {
    ...process.env, HOME: home, SHELL: '/bin/zsh', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: config,
    POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1', POCKET_DEV_CLAUDE: '/nonexistent/claude',
    POCKET_DEV_CODEX: '/nonexistent/codex', POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub, POCKET_DEV_TOP: stub, POCKET_DEV_MEMORY_PRESSURE: stub,
    POCKET_DEV_UPDATE_CHECK: stub, POCKET_DEV_OSASCRIPT: stub, POCKET_DEV_TERMINAL_HOST: 'off',
    POCKET_DEV_CLOUDFLARED: fakeCloudflared(root), POCKET_DEV_FAKE_CF: record,
    POCKET_DEV_TRACE_URL: traceUrl ?? 'http://127.0.0.1:9/trace', POCKET_DEV_HANDOFF_TTL_MS: '1500',
    ...(lanIpFile && { POCKET_DEV_LAN_IP_FILE: lanIp }),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  t.after(async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), pause(5000).then(() => proc.kill('SIGKILL'))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => { assert.equal(proc.exitCode, null, `server exited during startup:\n${logs}`); return logs.includes('Admin (this Mac only)'); });
  const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;

  // `via: 'tunnel'` sends what the connector on the Mac would: a loopback connection carrying the proxy headers.
  // http.request, not fetch, because fetch refuses to send a chosen Host header.
  function request(method, endpoint, { cookie, body, headers = {}, adminRequest = false, csrf = true, via } = {}) {
    const tunnel = via === 'tunnel' ? { host: HOSTNAME, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP } : {};
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request((adminRequest ? admin : base) + endpoint, { method, timeout: 10000, headers: {
        ...(cookie && { cookie }), ...(csrf && { [adminRequest ? 'x-pocket-admin' : 'x-pocket-dev']: '1' }),
        ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...tunnel, ...headers,
      } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let data; try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: res.statusCode, data, headers: new Headers(res.headers), cookie: res.headers['set-cookie']?.[0].split(';')[0] });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.end(payload);
    });
  }
  const local = (method, endpoint, body) => request(method, endpoint, { adminRequest: true, body });
  const login = (options) => request('POST', '/api/login', { body: { password: 'test-password' }, ...options });
  const current = () => local('GET', '/api/state').then((r) => r.data);
  const tunnelStatus = (status) => until(async () => (await current()).network.tunnel.status === status);
  const recorded = (name) => fs.readFileSync(path.join(record, name), 'utf8');
  return { root, home, stateDir: state, port, base, admin, proc, logs: () => logs, request, local, login, status: current, tunnelStatus, recorded, record, config, lanIp };
}
