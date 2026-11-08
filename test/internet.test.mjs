import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = process.env.TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTNAME = 'pocket.example.test';
const TOKEN = 'eyJhIjoiMDEyMzQ1Njc4OSIsInQiOiJmYWtlLXR1bm5lbC10b2tlbiIsInMiOiJzZWNyZXQifQ';
const PHONE_IP = '203.0.113.5';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) {
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
const lanAddress = () => Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;

// Answers like Cloudflare's trace endpoint, with the phone's address as this Mac's public address.
async function traceServer(t, ip = PHONE_IP) {
  const server = http.createServer((req, res) => { server.hits++; res.end(`fl=1f1\nh=1.1.1.1\nip=${ip}\nts=1\n`); });
  server.hits = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/cdn-cgi/trace`, server };
}

// A stand-in for cloudflared: records how it was started, prints what cloudflared prints, and waits to be killed.
// A token that ends in "bad" fails the way an unauthorized tunnel does.
function fakeCloudflared(root) {
  const file = path.join(root, 'cloudflared');
  fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$@" > "$POCKET_DEV_FAKE_CF/argv"
env > "$POCKET_DEV_FAKE_CF/env"
case "$TUNNEL_TOKEN" in *bad) echo "ERR Unauthorized: Failed to get tunnel" >&2; exit 1;; esac
case "$*" in *--url*) echo "INF |  https://quick-fixture-words.trycloudflare.com  |" >&2;; esac
echo "INF Registered tunnel connection connIndex=0" >&2
exec sleep 300
`, { mode: 0o700 });
  return file;
}

async function startServer(t, { network, devices, token, lanIpFile = true, traceUrl } = {}) {
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

test('internet access off by default: nothing new answers, no tunnel starts, no outbound lookups', { timeout: 60000 }, async (t) => {
  const trace = await traceServer(t);
  const s = await startServer(t, { traceUrl: trace.url });
  const A = await s.login();
  assert.equal((await s.request('GET', '/api/connection', { cookie: A.cookie })).status, 404);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: A.cookie, body: {} })).status, 404);
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } })).status, 404);
  const landing = await s.request('GET', '/?h=0123456789abcdef');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/login.html', 'a handoff link is an ordinary page request while the feature is off');
  const refused = await s.local('PUT', '/api/remote', { on: true });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Internet access is off/);
  const st = await s.status();
  assert.deepEqual(st.network, { wifi: true, internet: { kind: 'off', hostname: null }, hasToken: false, cloudflared: st.network.cloudflared, tunnel: { status: 'off', kind: null, url: null, error: null } });
  assert.equal(st.urls.remote, null);
  assert.equal(fs.existsSync(path.join(s.record, 'argv')), false, 'cloudflared never ran');
  assert.equal(trace.server.hits, 0, 'no public-address lookup while internet access is off');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 421, 'no tunnel hostname is accepted');
});

test('Wi-Fi access off binds loopback only, so the Mac is reached through the tunnel alone', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { wifi: false, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  assert.equal((await s.request('GET', '/api/status')).status, 200);
  const lan = lanAddress();
  if (lan) {
    await assert.rejects(fetch(`http://${lan}:${s.port}/api/status`, { signal: AbortSignal.timeout(3000) }), 'the LAN address must refuse');
  }
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.equal(st.network.wifi, false);
  assert.equal(st.urls.lan, null);
  assert.equal(st.urls.mdns, null);
  assert.equal((await s.local('POST', '/api/qr', { kind: 'share' })).data.url, `https://${HOSTNAME}`);
  assert.doesNotMatch(s.logs(), /running at http/, 'no LAN address is announced');
  assert.match(s.logs(), new RegExp(`Internet link: https://${HOSTNAME}`));
  const lockout = await s.local('PUT', '/api/network', { internet: { kind: 'off' } });
  assert.equal(lockout.status, 400);
  assert.match(lockout.data.error, /Turn on internet access before/);
  const D = await s.login({ via: 'tunnel' });
  const refused = await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {}, via: 'tunnel' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /Wi-Fi access is off/);
});

test('handoff: a Wi-Fi cookie for the same device, minted through the tunnel and usable once, on the Wi-Fi address only', { timeout: 90000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  await s.tunnelStatus('connected');
  const D = await s.login({ via: 'tunnel' });
  assert.equal(D.status, 200);
  assert.match(D.headers.get('set-cookie'), /; Secure/, 'the internet cookie is https-only');
  const deviceId = (await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).data.currentDeviceId;
  const devices = async (cookie, via) => (await s.request('GET', '/api/settings', { cookie, via })).data.devices;
  const mint = async () => {
    const r = await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {}, via: 'tunnel' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const link = new URL(r.data.url);
    assert.equal(link.origin, s.base, 'the link uses the Wi-Fi address');
    assert.match(link.searchParams.get('h'), /^[a-f0-9]{64}$/);
    return link.search;
  };
  const redeem = (search, options) => s.request('GET', `/${search}`, options);
  const refused = (r, why) => {
    assert.equal(r.status, 302, why);
    assert.equal(r.headers.get('location'), '/login.html?e=handoff', why);
    assert.equal(r.cookie, undefined, why);
  };

  assert.equal((await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {} })).status, 403, 'only offered through the tunnel');
  assert.equal((await s.request('POST', '/api/handoff', { body: {}, via: 'tunnel' })).status, 401);
  const leaked = await mint();
  refused(await redeem(leaked, { via: 'tunnel' }), 'a token replayed through the tunnel is refused');
  refused(await redeem(leaked), 'and spent');
  refused(await redeem(await mint(), { headers: { host: `localhost:${s.port}` } }), 'only the Wi-Fi address or .local name may redeem');
  refused(await redeem('?h=' + 'f'.repeat(64)), 'an unknown token');
  const expiring = await mint();
  await pause(1700);
  refused(await redeem(expiring), 'an expired token');

  const search = await mint();
  const landed = await redeem(search);
  assert.equal(landed.status, 200);
  assert.match(landed.data, /location\.replace\("\/" \+ location\.hash\)/, 'the bounce keeps the fragment that names the terminal or chat');
  assert.match(landed.cookie, /^pd_token=/);
  assert.doesNotMatch(landed.headers.get('set-cookie'), /; Secure/, 'the Wi-Fi cookie must work over http');
  const L = landed.cookie;
  refused(await redeem(search), 'single use');
  assert.notEqual(L, D.cookie);
  assert.equal((await s.request('GET', '/api/settings', { cookie: L })).data.currentDeviceId, deviceId, 'the same device on both addresses');
  assert.deepEqual((await devices(L)).map((d) => d.id), [deviceId], 'one device, not two');

  // At the device limit a handoff still succeeds and nobody is logged out.
  assert.equal((await s.local('PUT', '/api/settings', { maxDevices: 1 })).status, 200);
  const again = await redeem(await mint(), { cookie: L });
  assert.equal(again.status, 200);
  assert.equal((await devices(again.cookie)).length, 1);
  assert.equal((await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).status, 200, 'the internet cookie still works');
  assert.equal((await s.request('GET', '/api/settings', { cookie: L })).status, 401, 'the Wi-Fi cookie sent with the redeem was replaced, not kept as a third login');
  const log = (await s.local('GET', '/api/log')).data;
  assert.equal(log.some((e) => e.type === 'device-revoked'), false, 'no eviction');
  assert.deepEqual([...new Set(log.filter((e) => e.type.startsWith('handoff')).map((e) => e.type))].sort(), ['handoff-created', 'handoff-failed', 'handoff-redeemed']);
  const secrets = [search, leaked, expiring].map((q) => q.slice(3));
  const everything = JSON.stringify(log) + fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8') + s.logs();
  assert.ok(secrets.every((token) => !everything.includes(token)), 'handoff tokens never reach a log');

  // Revoking the device ends both cookies.
  assert.equal((await s.request('DELETE', `/api/devices/${deviceId}`, { cookie: again.cookie })).status, 204);
  assert.equal((await s.request('GET', '/api/settings', { cookie: again.cookie })).status, 401);
  assert.equal((await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).status, 401);

  // A collaborator session is never an owner device, so it cannot ask for a handoff.
  const A = await s.login();
  const adminId = (await s.request('GET', '/api/settings', { cookie: A.cookie })).data.currentDeviceId;
  const repo = path.join(s.home, 'project');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.equal((await s.local('PUT', '/api/settings', { maxDevices: 5 })).status, 200);
  assert.equal((await s.local('POST', '/api/collaborators/enable', { adminDeviceIds: [adminId] })).status, 200);
  const grant = await s.request('POST', '/api/collaborators', { cookie: A.cookie, body: { label: 'Reviewer', role: 'viewer', repository: repo, extraFolders: [], ai: false, duration: 3600 } });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  const invite = await s.request('POST', `/api/collaborators/${grant.data.id}/invite`, { cookie: A.cookie, body: {} });
  const token = new URLSearchParams(new URL(invite.data.url).hash.slice(1)).get('token');
  const G = (await s.request('POST', '/api/invitations/accept', { body: { token }, via: 'tunnel' })).cookie;
  assert.match(G, /^pd_collaborator=/);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: G, body: {}, via: 'tunnel' })).status, 403);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: `${G}; ${A.cookie}`, body: {}, via: 'tunnel' })).status, 403, 'a guest cookie never falls through to the owner');
});

test('domain tunnel: token in the environment only, never in argv, responses or logs; the hostname is served', { timeout: 60000 }, async (t) => {
  const trace = await traceServer(t);
  const s = await startServer(t, { network: { wifi: true, internet: { kind: 'quick' } }, traceUrl: trace.url });
  const A = await s.login();
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN } })).status, 403, 'a phone cannot widen access');
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME } })).status, 400, 'a domain needs its token');
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: 'pocket' }, token: TOKEN })).status, 400);
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: 'has spaces in it' })).status, 400);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'tunnel-token')), false, 'a refused save writes nothing');
  const saved = await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.hasToken, true);
  assert.equal(fs.statSync(path.join(s.stateDir, 'tunnel-token')).mode & 0o777, 0o600);
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.deepEqual(st.network.internet, { kind: 'domain', hostname: HOSTNAME });
  assert.equal(st.network.tunnel.url, `https://${HOSTNAME}`);
  assert.equal(st.urls.remote, `https://${HOSTNAME}`);
  assert.equal(JSON.parse(fs.readFileSync(s.config, 'utf8')).network.internet.hostname, HOSTNAME);
  assert.equal(s.recorded('argv').trim().split('\n').join(' '), 'tunnel --no-autoupdate run');
  assert.match(s.recorded('env'), new RegExp(`^TUNNEL_TOKEN=${TOKEN}$`, 'm'));
  const everything = JSON.stringify(st) + JSON.stringify((await s.local('GET', '/api/log')).data) + fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8') + s.logs() + fs.readFileSync(s.config, 'utf8');
  assert.equal(everything.includes(TOKEN), false, 'the token never appears in a response, a log or config.json');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 200, 'the domain hostname is accepted on https');
  assert.equal((await s.request('GET', '/api/status', { headers: { host: `${HOSTNAME}:443` } })).status, 200);
  assert.equal((await s.request('GET', '/api/status', { headers: { host: `${HOSTNAME}:8080` } })).status, 421);
  const share = await s.local('POST', '/api/qr', { kind: 'share' });
  assert.equal(share.data.url, `https://${HOSTNAME}`, 'sharing defaults to the internet address');
  assert.equal(new URL((await s.local('POST', '/api/qr', { kind: 'login' })).data.url).origin, `https://${HOSTNAME}`);
  // A bad token is reported with cloudflared's own words.
  const bad = await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: `${TOKEN}bad` });
  assert.equal(bad.status, 200);
  await s.tunnelStatus('error');
  assert.match((await s.status()).network.tunnel.error, /Unauthorized: Failed to get tunnel/);
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN })).status, 200);
  await s.tunnelStatus('connected');
  // Disconnect stops the link; Connect brings the domain link back on its own.
  assert.equal((await s.local('PUT', '/api/access', { connected: false })).status, 200);
  assert.equal((await s.status()).network.tunnel.status, 'off');
  assert.equal((await s.local('PUT', '/api/access', { connected: true })).status, 200);
  await s.tunnelStatus('connected');
  // A phone may turn internet access off, and nothing new answers afterwards.
  const off = await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.internet.kind, 'off');
  assert.equal(off.data.tunnel.status, 'off');
  assert.equal(off.data.hasToken, true, 'the token stays for the next time');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 421);
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } })).status, 404);
});

test('a devices file from before multi-address cookies still logs its devices in', { timeout: 60000 }, async (t) => {
  const oldToken = 'a'.repeat(64), olderToken = 'b'.repeat(64);
  const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const s = await startServer(t, { devices: [
    { tokenHash: hash(oldToken), id: 'old00001', name: 'Old phone', ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', createdAt: 1700000000000, lastSeen: 1700000000000, ip: '192.168.1.9', via: 'password', status: 'active' },
    { tokenHash: hash(olderToken), id: 'old00002', name: 'Older phone', createdAt: 1690000000000, lastSeen: 1690000000000, ip: '192.168.1.8', via: 'qr' },
  ] });
  for (const token of [oldToken, olderToken]) assert.equal((await s.request('GET', '/api/settings', { cookie: `pd_token=${token}` })).status, 200, 'every old cookie still works');
  const settings = (await s.request('GET', '/api/settings', { cookie: `pd_token=${oldToken}` })).data;
  assert.deepEqual(settings.devices.map((d) => d.id).sort(), ['old00001', 'old00002']);
  assert.equal(settings.currentDeviceId, 'old00001');
  assert.equal(JSON.stringify(settings).includes(hash(oldToken)), false, 'cookie hashes never leave the server');
  assert.equal((await s.request('DELETE', '/api/devices/old00002', { cookie: `pd_token=${oldToken}` })).status, 204);
  assert.equal((await s.request('GET', '/api/settings', { cookie: `pd_token=${olderToken}` })).status, 401);
  const saved = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'devices.json'), 'utf8')).devices;
  assert.deepEqual(saved.map((d) => [d.id, d.tokenHash, d.tokenHashes]), [['old00001', hash(oldToken), [hash(oldToken)]]], 'saved in both shapes');
});

test('Quick link: on demand from Admin, a random address, and off again', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'quick' } } });
  assert.equal((await s.status()).network.tunnel.status, 'off', 'a restart never publishes a Quick link');
  const on = await s.local('PUT', '/api/remote', { on: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.equal(st.network.tunnel.url, 'https://quick-fixture-words.trycloudflare.com');
  assert.equal(st.urls.remote, st.network.tunnel.url);
  assert.equal(s.recorded('argv').trim().split('\n').slice(0, 3).join(' '), 'tunnel --no-autoupdate --url');
  assert.doesNotMatch(s.recorded('env'), /^TUNNEL_TOKEN=/m);
  assert.equal((await s.request('GET', '/api/status', { headers: { host: 'quick-fixture-words.trycloudflare.com' } })).status, 200);
  // The CLI talks to the running server through its admin page.
  const cli = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), 'internet', ...args], { env: { ...process.env, POCKET_DEV_STATE_DIR: s.stateDir, POCKET_DEV_CONFIG: s.config }, encoding: 'utf8', input: '' });
  assert.match(cli('status').stdout, /Link: connected at https:\/\/quick-fixture-words\.trycloudflare\.com/);
  const offAgain = await s.local('PUT', '/api/remote', { on: false });
  assert.equal(offAgain.data.status, 'off');
  assert.equal((await s.request('GET', '/api/status', { headers: { host: 'quick-fixture-words.trycloudflare.com' } })).status, 421);
  const viaCli = cli('off');
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.match(viaCli.stdout, /Internet access: off/);
  assert.equal((await s.status()).network.internet.kind, 'off');
  const changed = (await s.local('GET', '/api/log?filter=changes')).data.find((e) => e.type === 'network-changed');
  assert.equal(changed.by, 'cli');
});
