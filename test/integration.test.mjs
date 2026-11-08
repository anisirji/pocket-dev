import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO = process.env.TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test('merged phone and admin server', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-test-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, 'Desktop'));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ password: 'test-password', awake: 'off', fileRoots: [home], maxDevices: 20 }));
  const port = await freePort(), adminPort = await freePort();
  const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;
  // These tests never sleep/shut down the Mac, quit apps, install services, or call models.
  const stub = path.join(root, 'read-only-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "No\\n"\n', { mode: 0o700 });
  // The screen route runs these instead of screencapture and sips: the first writes a tiny JPEG, the second copies it.
  const shot = path.join(root, 'screencapture-stub');
  fs.writeFileSync(shot, '#!/bin/sh\nfor last; do :; done\nprintf "\\377\\330\\377stub" > "$last"\n', { mode: 0o700 });
  const resize = path.join(root, 'sips-stub');
  fs.writeFileSync(resize, '#!/bin/sh\n[ "$1" = "-g" ] && { echo "pixelWidth: 800"; echo "pixelHeight: 600"; exit 0; }\nfor a; do case "$prev" in --out) out="$a";; esac; prev="$a"; done\nfor a; do [ -f "$a" ] && raw="$a"; done\ncp "$raw" "$out"\n', { mode: 0o700 });
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: {
    POCKET_DEV_SCREENCAPTURE: shot, POCKET_DEV_SIPS: resize,
    ...process.env, HOME: home, SHELL: '/bin/zsh', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: config,
    POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1', POCKET_DEV_CLAUDE: '/nonexistent/claude',
    POCKET_DEV_CODEX: '/nonexistent/codex', POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub, POCKET_DEV_TOP: stub, POCKET_DEV_MEMORY_PRESSURE: stub,
    POCKET_DEV_UPDATE_CHECK: stub, POCKET_DEV_OSASCRIPT: stub,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), pause(5000).then(() => proc.kill('SIGKILL'))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => { assert.equal(proc.exitCode, null, 'server exited during startup'); return logs.includes('Admin (this Mac only)'); });

  async function request(method, endpoint, { cookie, body, headers = {}, adminRequest = false, csrf = true } = {}) {
    if (headers.host) {
      return new Promise((resolve, reject) => {
        const req = http.request((adminRequest ? admin : base) + endpoint, { method, headers: { ...(cookie && { cookie }), ...headers } }, (res) => {
          res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject); req.end();
      });
    }
    const response = await fetch((adminRequest ? admin : base) + endpoint, {
      method, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { ...(cookie && { cookie }), ...(csrf && { [adminRequest ? 'x-pocket-admin' : 'x-pocket-dev']: '1' }),
        ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const local = (method, endpoint, body) => request(method, endpoint, { adminRequest: true, body });
  const login = () => request('POST', '/api/login', { body: { password: 'test-password' } });
  async function socket(endpoint, cookie, origin = base) {
    const ws = new WebSocket(base.replace('http', 'ws') + endpoint, { headers: { ...(cookie && { cookie }), origin } });
    sockets.add(ws);
    ws.closed = new Promise((resolve) => ws.once('close', resolve));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_, response) => { ws.terminate(); reject(new Error(`HTTP ${response.statusCode}`)); }); });
    return ws;
  }
  const apis = ['/api/sessions', '/api/folders', '/api/shortcuts', '/api/forwards', '/api/info', '/api/history', '/api/git/repos', '/api/settings', '/api/service', '/api/power', '/api/apps', '/api/chat', `/api/files/list?path=${encodeURIComponent(home)}`];
  const assets = ['/vendor/xterm/xterm.js', '/vendor/xterm/xterm.css', '/vendor/xterm/addon-fit.js', '/connection.js', '/git.js', '/graph.js', '/git.css', '/history.js', '/history.css', '/settings.js', '/settings.css', '/collaborators.js', '/collaborators.css', '/apps.js', '/apps.css', '/screen.js', '/screen.css', '/macstatus.js', '/macstatus.css', '/health.js', '/health.css', '/power.js', '/service.js', '/chat.js', '/chat.css', '/files.js', '/files.css'];
  await t.test('every feature requires authentication; private source stays private', async () => {
    assert.equal((await request('GET', '/')).status, 302);
    for (const endpoint of [...apis, ...assets]) assert.equal((await request('GET', endpoint)).status, 401, endpoint);
    for (const endpoint of ['/server.js', '/config.json', '/auth.js', '/admin.html', '/admin-client.js']) assert.equal((await request('GET', endpoint)).status, 404, endpoint);
    assert.equal((await request('GET', '/login.html')).status, 200);
    assert.equal((await request('GET', '/api/status')).status, 200);
  });
  const A = await login();
  assert.equal(A.status, 200);
  assert.match(A.cookie, /^pd_token=/);
  await t.test('logged-in pages can load every script and stylesheet, including bundled terminal assets', async () => {
    for (const endpoint of assets) {
      const res = await request('GET', endpoint, { cookie: A.cookie });
      assert.equal(res.status, 200, endpoint);
      assert.match(res.headers.get('content-type'), endpoint.endsWith('.css') ? /text\/css/ : /javascript/, endpoint);
    }
  });
  let chat, session;
  await t.test('restart needs a login and refuses when this copy is not the launchd service', async () => {
    assert.equal((await request('POST', '/api/service/restart', { body: {} })).status, 401);
    const svc = await request('GET', '/api/service', { cookie: A.cookie });
    assert.equal(svc.status, 200);
    assert.equal(typeof svc.data.updateReady, 'boolean');
    const refused = await request('POST', '/api/service/restart', { cookie: A.cookie, body: {} });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /not the background service/);
    await pause(600);
    assert.equal(proc.exitCode, null, 'a refused restart must not stop the server');
  });
  await t.test('power status carries the temperature block, empty when the Mac gives no reading', async () => {
    const power = await request('GET', '/api/power', { cookie: A.cookie });
    assert.equal(power.status, 200);
    assert.deepEqual(Object.keys(power.data.temperature).sort(), ['batteryC', 'thermal']);
    assert.equal(power.data.temperature.batteryC, null, 'the stubbed ioreg has no Temperature line');
    assert.equal(power.data.temperature.thermal, null, 'the stubbed osascript answers No, which is not a level');
  });
  await t.test('attached images show as thumbnails, and only files attached to that message can be read', async () => {
    const made = await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'codex', cwd: home } });
    const chatId = made.data.id;
    const photo = path.join(home, 'photo.png');
    const secret = path.join(home, 'secret.txt');
    fs.writeFileSync(photo, 'not really a png, but named like one');
    fs.writeFileSync(secret, 'top secret');
    const sent = await request('POST', `/api/chat/${chatId}/message`, { cookie: A.cookie, body: { text: 'look', attachments: [photo, secret] } });
    assert.equal(sent.status, 202);
    const msg = (await request('GET', `/api/chat/${chatId}`, { cookie: A.cookie })).data.events.find((e) => e.type === 'user-text');
    const get = (name, query = '', cookie = A.cookie) => fetch(`${base}/api/chat/${chatId}/attachment/${name}${query}`, { headers: { ...(cookie && { cookie }), 'x-pocket-dev': '1' } });
    const small = await get(`${msg.id}.0`);
    assert.equal(small.status, 200);
    assert.equal(small.headers.get('content-type'), 'image/jpeg', 'the small version is a JPEG');
    const full = await get(`${msg.id}.0`, '?full=1');
    assert.equal(full.headers.get('content-type'), 'image/png');
    assert.equal(await full.text(), 'not really a png, but named like one');
    assert.equal((await get(`${msg.id}.1`)).status, 404, 'a non-image attachment is never served');
    assert.equal((await get(`${msg.id}.2`)).status, 404, 'there is no third attachment');
    assert.equal((await get(`${msg.id}.0`, '', null)).status, 401);
    for (const bad of ['../x', '..%2F..%2Fconfig.json', 'abc.0', `${msg.id}`, `${msg.id}.0.png`, `ffffffffffff.0`]) assert.equal((await get(bad)).status, 404, bad);
    await request('DELETE', `/api/chat/${chatId}`, { cookie: A.cookie });
  });
  await t.test('health: behind login, with every part of the panel present even when readings are missing', async () => {
    assert.equal((await request('GET', '/api/health')).status, 401);
    const res = await request('GET', '/api/health', { cookie: A.cookie });
    assert.equal(res.status, 200);
    for (const key of ['status', 'issues', 'battery', 'temperature', 'limits', 'cpu', 'disk', 'power', 'mac', 'network', 'pocketDev']) assert.ok(key in res.data, key);
    assert.ok(['good', 'watch', 'attention'].includes(res.data.status));
    assert.equal(res.data.cpu.usedPercent, null, 'a stubbed top gives no reading, not zero');
    assert.equal(res.data.memory, null);
    assert.equal(res.data.pocketDev.version, '1.0.0');
  });
  await t.test('vitals: a light reading with limits and alerts, behind login', async () => {
    assert.equal((await request('GET', '/api/power/vitals')).status, 401);
    const vitals = await request('GET', '/api/power/vitals', { cookie: A.cookie });
    assert.equal(vitals.status, 200);
    assert.deepEqual(vitals.data.limits, { batteryPercent: 20, temperatureC: 40 });
    assert.deepEqual(Object.keys(vitals.data.temperature).sort(), ['batteryC', 'thermal']);
    assert.equal(vitals.data.temperature.thermal, null, 'the stubbed osascript answers No, which is not a level');
    assert.ok(Array.isArray(vitals.data.alerts));
  });
  await t.test('screen view: login required, a no-store JPEG, nothing left on disk, and a config switch', async () => {
    assert.equal((await request('GET', '/api/screen')).status, 401);
    const res = await fetch(`${base}/api/screen`, { headers: { cookie: A.cookie, 'x-pocket-dev': '1' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.deepEqual(fs.readdirSync(state).filter((f) => f.startsWith('screen-')), [], 'the capture folder is removed');
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
    fs.writeFileSync(config, JSON.stringify({ ...saved, screenView: false }));
    const off = await request('GET', '/api/screen', { cookie: A.cookie });
    assert.equal(off.status, 403);
    assert.match(off.data.error, /screenView true/);
    fs.writeFileSync(config, JSON.stringify(saved));
  });
  await t.test('permissions: Mac-only, setup status validated and saved, unknown ids refused', async () => {
    assert.equal((await request('GET', '/api/permissions', { cookie: A.cookie })).status, 404, 'a logged-in phone cannot reach it: the route exists only on the Mac admin port');
    assert.equal((await request('POST', '/api/permissions/automation/request', { cookie: A.cookie, body: {} })).status, 404);
    const list = await local('GET', '/api/permissions');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.items.map((i) => i.id), ['automation', 'accessibility', 'fullDisk', 'screenRecording', 'firewall', 'claude', 'codex', 'gh']);
    assert.ok(list.data.items.every((i) => ['granted', 'missing', 'waiting', 'not-needed', 'unknown'].includes(i.state)));
    assert.equal(list.data.setup, null);
    assert.equal((await local('POST', '/api/permissions/setup', { status: 'maybe' })).status, 400);
    assert.equal((await local('POST', '/api/permissions/setup', { status: 'skipped' })).status, 200);
    assert.equal((await local('GET', '/api/state')).data.permissionsSetup, 'skipped');
    assert.equal((await local('POST', '/api/permissions/nope/request', {})).status, 404);
  });
  await t.test('CSRF, content type, Host, admin proxy and Origin checks', async () => {
    assert.equal((await request('POST', '/api/sessions', { cookie: A.cookie, body: {}, csrf: false })).status, 403);
    assert.equal((await request('POST', '/api/sessions', { cookie: A.cookie, body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request('GET', '/api/chat', { cookie: A.cookie, headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await request('GET', '/', { adminRequest: true, headers: { host: `evil.example:${adminPort}` } })).status, 403);
    assert.equal((await request('GET', '/api/state', { adminRequest: true, headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403);
    assert.equal((await request('PUT', '/api/settings', { adminRequest: true, csrf: false, body: {} })).status, 403);
    assert.equal((await request('PUT', '/api/settings', { adminRequest: true, body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
    await assert.rejects(socket('/ws/chat/aaaaaaaaaaaa', undefined), /HTTP 401/);
  });
  await t.test('chat persistence follows isolated state; protected settings need confirmation', async () => {
    const created = await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'claude', cwd: home } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    chat = created.data;
    assert.ok(fs.existsSync(path.join(state, 'chats', `${chat.id}.json`)));
    assert.equal(fs.existsSync(path.join(home, '.pocket-dev', 'chats')), false);
    assert.equal((fs.statSync(path.join(state, 'chats', `${chat.id}.json`)).mode & 0o777), 0o600);
    assert.equal((await request('PATCH', `/api/chat/${chat.id}`, { cookie: A.cookie, body: { settings: { mode: 'bypassPermissions' } } })).status, 400);
    assert.equal((await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'claude', cwd: home, resume: { sessionId: '../../escape' } } })).status, 400);
    assert.equal((await request('POST', `/api/chat/${chat.id}/answer`, { cookie: A.cookie, body: { requestId: 'unknown', decision: 'allow' } })).status, 400);
    assert.equal((await request('GET', `/api/chat/${chat.id}`, { cookie: A.cookie })).data.capabilities.queueEdit, true);
    const noLongerQueued = await request('PATCH', `/api/chat/${chat.id}/queue`, { cookie: A.cookie, body: { eventId: 'already-picked-up', text: 'Revised text', expectedText: 'Original text' } });
    assert.equal(noLongerQueued.status, 404);
    assert.equal(noLongerQueued.data.code, 'QUEUE_MESSAGE_GONE', 'the real Save endpoint must distinguish a picked-up message from a missing route');
  });
  await t.test('an unavailable Codex binary falls back without hanging Chat options', async () => {
    const options = await request('GET', '/api/chat/options', { cookie: A.cookie });
    assert.equal(options.status, 200);
    assert.ok(options.data.tools.codex.settings.find((s) => s.key === 'model').choices.length);
    const created = await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'codex', cwd: home } });
    assert.equal(created.status, 201);
  });
  await t.test('retrying a chat message after a lost response accepts it once and persists the receipt', async () => {
    const created = await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'codex', cwd: home } });
    const id = created.data.id;
    const endpoint = `/api/chat/${id}/message`;
    const body = { text: 'retry-safe message', clientMessageId: 'retry-fixture-0123456789' };
    const responses = await Promise.all([request('POST', endpoint, { cookie: A.cookie, body }), request('POST', endpoint, { cookie: A.cookie, body })]);
    assert.deepEqual(responses.map((r) => r.status), [202, 202]);
    const snapshot = await request('GET', `/api/chat/${id}`, { cookie: A.cookie });
    assert.equal(snapshot.data.events.filter((e) => e.type === 'user-text' && e.text === body.text).length, 1);
    assert.equal((await request('POST', endpoint, { cookie: A.cookie, body: { ...body, text: 'different' } })).status, 409);
    assert.equal((await request('POST', endpoint, { cookie: A.cookie, body: { ...body, clientMessageId: 'bad' } })).status, 400);
    const saved = JSON.parse(fs.readFileSync(path.join(state, 'chats', `${id}.json`), 'utf8'));
    assert.equal(saved.acceptedInputs.filter((r) => r.id === body.clientMessageId).length, 1);
    // The configured Codex executable is deliberately absent: no model is called.
    await request('DELETE', `/api/chat/${id}`, { cookie: A.cookie });
  });
  await t.test('browser heartbeats receive replies on chat sockets', async () => {
    const ws = await socket(`/ws/chat/${chat.id}`, A.cookie);
    const pong = new Promise((resolve) => {
      ws.on('message', (raw) => { if (JSON.parse(raw).t === 'pong') resolve(); });
    });
    ws.send(JSON.stringify({ t: 'ping' }));
    await Promise.race([pong, pause(2000).then(() => assert.fail('chat heartbeat not answered'))]);
    ws.close();
  });
  await t.test('new terminal commands run once; Unicode works with an inherited C.UTF-8 locale', async () => {
    const file = path.join(home, 'command-result');
    const created = await request('POST', '/api/sessions', { cookie: A.cookie, body: { cwd: home, command: `printf 'a\\u202fb|%s\\n' "$LANG" >> '${file}'` } });
    assert.equal(created.status, 201);
    session = created.data;
    await until(() => fs.existsSync(file));
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\u202fb|en_US.UTF-8\n');
    await socket(`/ws/${session.id}`, A.cookie);
    await pause(400);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2, 'attaching must not rerun command');
    await assert.rejects(socket(`/ws/${session.id}`, A.cookie, 'http://evil.example'), /HTTP 403/);
  });
  await t.test('the terminal list reports each terminal\'s folder and last output for the Tabs sheet', async () => {
    const list = await request('GET', '/api/sessions', { cookie: A.cookie });
    const mine = list.data.find((x) => x.id === session.id);
    assert.equal(mine.cwd, home);
    assert.ok(Number.isInteger(mine.startedAt) && Number.isInteger(mine.activeAt));
    assert.ok(mine.activeAt >= mine.startedAt, 'output moves activeAt forward');
  });
  await t.test('browser heartbeats work even after the terminal process exits', async () => {
    const ws = await socket(`/ws/${session.id}`, A.cookie);
    const pong = new Promise((resolve) => {
      ws.on('message', (raw) => { if (JSON.parse(raw).t === 'pong') resolve(); });
    });
    ws.send(JSON.stringify({ t: 'ping' }));
    await Promise.race([pong, pause(2000).then(() => assert.fail('terminal heartbeat not answered'))]);
    ws.close();
  });
  await t.test('Files enforces roots, preserves uploads, and sandboxes HTML', async () => {
    const upload = (content) => fetch(`${base}/api/files/upload?dir=${encodeURIComponent(home)}&name=note.html`, { method: 'POST', headers: { cookie: A.cookie, 'x-pocket-dev': '1' }, body: content });
    assert.equal((await upload('<script>alert(1)</script>')).status, 201);
    assert.equal((await upload('second')).status, 201);
    assert.equal(fs.readFileSync(path.join(home, 'note.html'), 'utf8'), '<script>alert(1)</script>');
    assert.equal(fs.readFileSync(path.join(home, 'note (1).html'), 'utf8'), 'second');
    const inline = await request('GET', `/api/files/download?path=${encodeURIComponent(path.join(home, 'note.html'))}&inline=1`, { cookie: A.cookie });
    assert.equal(inline.status, 200);
    assert.match(inline.headers.get('content-type'), /^text\/plain/);
    assert.match(inline.headers.get('content-security-policy'), /sandbox/);
    fs.symlinkSync('/etc', path.join(home, 'outside'));
    assert.equal((await request('GET', `/api/files/list?path=${encodeURIComponent(path.join(home, 'outside'))}`, { cookie: A.cookie })).status, 403);
    assert.equal((await request('POST', '/api/files/rename', { cookie: A.cookie, body: { path: path.join(home, 'note.html'), newName: 'note (1).html' } })).status, 409);
    assert.equal((await request('POST', '/api/files/rename', { cookie: A.cookie, body: { path: path.join(home, 'Desktop'), newName: 'Renamed' } })).status, 200);
    assert.ok(fs.existsSync(path.join(home, 'Renamed')));
  });
  await t.test('blocking a device closes chat sockets and denies every feature', async () => {
    const ws = await socket(`/ws/chat/${chat.id}`, A.cookie);
    const settings = await request('GET', '/api/settings', { cookie: A.cookie });
    const id = settings.data.currentDeviceId;
    assert.equal((await local('POST', `/api/devices/${id}/block`, {})).status, 200);
    await Promise.race([ws.closed, pause(3000).then(() => assert.fail('blocked chat socket stayed open'))]);
    for (const endpoint of [...apis, ...assets]) assert.ok([401, 403].includes((await request('GET', endpoint, { cookie: A.cookie })).status), endpoint);
    await assert.rejects(socket(`/ws/chat/${chat.id}`, A.cookie), /HTTP 401/);
    assert.equal((await local('POST', `/api/devices/${id}/unblock`, {})).status, 200);
    assert.equal((await request('GET', '/api/chat', { cookie: A.cookie })).status, 200);
  });
  await t.test('pending devices cannot use APIs, scripts or sockets; approval restores access', async () => {
    assert.equal((await local('PUT', '/api/settings', { requireApproval: true })).status, 200);
    const B = await login();
    assert.equal(B.data.pending, true);
    for (const endpoint of [...apis, ...assets]) assert.ok([401, 403].includes((await request('GET', endpoint, { cookie: B.cookie })).status), endpoint);
    await assert.rejects(socket(`/ws/chat/${chat.id}`, B.cookie), /HTTP 401/);
    const s = await local('GET', '/api/state');
    const pending = s.data.devices.find((d) => d.status === 'pending');
    assert.ok(pending);
    assert.equal((await local('POST', `/api/devices/${pending.id}/approve`, {})).status, 200);
    assert.equal((await request('GET', '/api/chat', { cookie: B.cookie })).status, 200);
  });
  await t.test('admin sharing keeps password approval; login QR grants one-time access', async () => {
    const share = await local('POST', '/api/qr', { kind: 'share' });
    assert.equal(share.status, 200);
    assert.match(share.data.svg, /<svg/);
    const address = (await local('GET', '/api/state')).data.urls.lan;
    assert.equal(share.data.url, address);
    assert.equal(new URL(share.data.url).search, '', 'a share link must not contain login credentials');
    assert.equal(share.data.expiresAt, undefined, 'share links are reusable addresses');
    const landing = await request('GET', '/');
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get('location'), '/login.html');
    const waiting = await login();
    assert.equal(waiting.data.pending, true, 'sharing leaves password approval enabled');
    assert.equal((await request('POST', '/api/qr', { cookie: A.cookie, body: { kind: 'share' } })).status, 404, 'QR generation stays on the Mac admin listener');
    assert.equal((await local('POST', '/api/qr', { kind: 'unknown' })).status, 400);
    assert.equal((await request('POST', '/api/qr', { adminRequest: true, body: { kind: 'share' }, csrf: false })).status, 403);
    const qr = await local('POST', '/api/qr', { kind: 'login' });
    assert.equal(qr.status, 200);
    assert.match(qr.data.svg, /<svg/);
    assert.ok(qr.data.expiresAt > Date.now());
    assert.ok(qr.data.expiresAt <= Date.now() + qr.data.expiresInMin * 60_000);
    const link = new URL(qr.data.url);
    assert.equal(link.origin, address);
    assert.match(link.searchParams.get('k'), /^[a-f0-9]{64}$/);
    const redeemed = await request('GET', link.pathname + link.search);
    assert.equal(redeemed.status, 200);
    assert.match(redeemed.cookie, /^pd_token=/);
    assert.equal((await request('GET', '/api/status', { cookie: redeemed.cookie })).data.status, 'active', 'QR login skips password approval');
    const reused = await request('GET', link.pathname + link.search);
    assert.equal(reused.status, 302);
    assert.equal(reused.headers.get('location'), '/login.html?e=qr');
    assert.equal(reused.cookie, undefined, 'a QR login is single-use');
    const legacy = await local('POST', '/api/qr', {});
    assert.equal(legacy.status, 200, 'existing login QR callers keep working');
    assert.ok(new URL(legacy.data.url).searchParams.has('k'));
  });
  await t.test('collaborator invitations enforce roles, folders, migration, expiry boundaries and revocation', async () => {
    const repo = path.join(home, 'project'), other = path.join(home, 'other-project'), extra = path.join(home, 'project-assets');
    for (const dir of [repo, other, extra]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'README.md'), 'Shared project');
    fs.writeFileSync(path.join(repo, '.env'), 'PRIVATE=secret');
    fs.writeFileSync(path.join(repo, '.git', 'config'), 'private git configuration');
    fs.writeFileSync(path.join(other, 'secret.txt'), 'Other project');
    fs.writeFileSync(path.join(extra, 'asset.txt'), 'Shared asset');
    fs.symlinkSync(other, path.join(repo, 'outside'));
    const settings = await request('GET', '/api/settings', { cookie: A.cookie });
    const currentId = settings.data.currentDeviceId;
    const draft = { label: 'Reviewer', role: 'viewer', repository: repo, extraFolders: [{ path: extra, mode: 'read' }], ai: false, duration: 86400 };
    assert.equal((await local('POST', '/api/collaborators', draft)).status, 409, 'invites require an explicit Mac migration');
    assert.equal((await request('POST', '/api/collaborators/enable', { cookie: A.cookie, body: { adminDeviceIds: [currentId] } })).status, 403);
    assert.equal((await local('POST', '/api/collaborators/enable', { adminDeviceIds: [] })).status, 400);
    assert.equal((await local('POST', '/api/collaborators/enable', { adminDeviceIds: [currentId] })).status, 200);
    const migrated = (await local('GET', '/api/state')).data;
    assert.equal(migrated.devices.find((d) => d.id === currentId).role, 'admin');
    assert.ok(migrated.devices.filter((d) => d.id !== currentId && d.status !== 'blocked').every((d) => d.status === 'pending'));
    assert.equal((await request('POST', '/api/settings/qr-key', { cookie: A.cookie, body: {} })).status, 403, 'Admin pairing stays Mac-local');
    const passwordLogin = await login();
    assert.equal(passwordLogin.data.pending, true, 'the password never bypasses local Admin review');
    const created = await request('POST', '/api/collaborators', { cookie: A.cookie, body: draft });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const grantId = created.data.id;
    const invite = await request('POST', `/api/collaborators/${grantId}/invite`, { cookie: A.cookie, body: {} });
    assert.equal(invite.status, 200);
    const link = new URL(invite.data.url), token = new URLSearchParams(link.hash.slice(1)).get('token');
    assert.equal(link.search, '', 'tokens use the URL fragment, never the HTTP path');
    const preview = await request('GET', link.pathname);
    assert.equal(preview.status, 200);
    assert.equal(preview.cookie, undefined);
    assert.equal(preview.data.includes(repo), false, 'link previews expose no private folder information');
    assert.equal((await request('POST', '/api/invitations/accept', { cookie: A.cookie, body: { token } })).status, 409, 'never merge an owner and guest session');
    assert.equal((await request('POST', '/api/invitations/accept', { body: { token }, csrf: false })).status, 403);
    const accepted = await request('POST', '/api/invitations/accept', { body: { token } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    const G = accepted.cookie;
    assert.match(G, /^pd_collaborator=/);
    assert.equal((await request('POST', '/api/invitations/accept', { body: { token } })).status, 410, 'one-use invitation');
    const access = await request('GET', '/api/current-access', { cookie: G });
    assert.equal(access.data.role, 'viewer');
    assert.equal(access.data.ai, false);
    const listed = await request('GET', `/api/files/list?path=${encodeURIComponent(repo)}&showHidden=1`, { cookie: G });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.readOnly, true);
    assert.deepEqual(listed.data.entries.filter((e) => e.name.startsWith('.')).map((e) => e.name), []);
    assert.equal((await request('GET', `/api/files/download?path=${encodeURIComponent(path.join(extra, 'asset.txt'))}`, { cookie: G })).data, 'Shared asset');
    for (const forbidden of [path.join(other, 'secret.txt'), path.join(repo, '.git', 'config'), path.join(repo, '.env'), path.join(repo, 'outside', 'secret.txt')]) {
      assert.equal((await request('GET', `/api/files/download?path=${encodeURIComponent(forbidden)}`, { cookie: G })).status, 403, forbidden);
    }
    assert.equal((await request('POST', '/api/files/mkdir', { cookie: G, body: { dir: repo, name: 'denied' } })).status, 403);
    for (const endpoint of ['/api/chat', '/api/sessions', '/api/history', '/api/settings', '/api/power', '/api/apps', '/api/collaborators', '/api/files/pin']) {
      assert.equal((await request('GET', endpoint, { cookie: G })).status, 403, endpoint);
    }
    assert.equal((await request('POST', '/api/settings/password', { cookie: G, body: { current: 'test-password', next: 'changed-password' } })).status, 403);
    await assert.rejects(socket(`/ws/chat/${chat.id}`, G), /HTTP 403/);
    assert.equal((await request('GET', '/chat.js', { cookie: G })).status, 403);
    assert.match((await request('GET', '/', { cookie: G })).data, /Shared project/);
    assert.equal((await request('GET', '/', { cookie: `${G}; ${A.cookie}` })).data.includes('Shared project'), true, 'guest credentials never fall through to owner capabilities');
    // Concurrent owner and guest requests must use immutable request-local roots.
    const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => request('GET', `/api/files/list?path=${encodeURIComponent(i % 2 ? repo : home)}`, { cookie: i % 2 ? G : A.cookie })));
    assert.ok(parallel.every((r) => r.status === 200));
    assert.equal((await request('GET', `/api/files/list?path=${encodeURIComponent(home)}`, { cookie: G })).status, 403);
    // A Developer gets writable copies and read-only assets, never host AI.
    const developer = await request('POST', '/api/collaborators', { cookie: A.cookie, body: { ...draft, label: 'Developer', role: 'developer' } });
    assert.equal(developer.status, 201, JSON.stringify(developer.data));
    assert.ok(fs.existsSync(path.join(developer.data.workspace, 'project', 'README.md')));
    assert.equal(fs.existsSync(path.join(developer.data.workspace, 'project', '.env')), false);
    assert.equal(fs.existsSync(path.join(developer.data.workspace, 'project', 'outside')), false);
    const devInvite = await request('POST', `/api/collaborators/${developer.data.id}/invite`, { cookie: A.cookie, body: {} });
    const devToken = new URLSearchParams(new URL(devInvite.data.url).hash.slice(1)).get('token');
    const D = (await request('POST', '/api/invitations/accept', { body: { token: devToken } })).cookie;
    const project = path.join(developer.data.workspace, 'project');
    assert.equal((await request('POST', '/api/files/mkdir', { cookie: D, body: { dir: project, name: 'allowed' } })).status, 201);
    assert.equal(fs.existsSync(path.join(repo, 'allowed')), false);
    assert.equal((await request('POST', '/api/files/mkdir', { cookie: D, body: { dir: extra, name: 'denied' } })).status, 403);
    assert.equal((await request('POST', '/api/chat', { cookie: D, body: { tool: 'codex', cwd: repo } })).status, 403);
    assert.equal((await request('PATCH', `/api/collaborators/${developer.data.id}`, { cookie: A.cookie, body: { ...draft, role: 'developer', ai: true } })).status, 409);
    const oldInvite = await request('POST', `/api/collaborators/${grantId}/invite`, { cookie: A.cookie, body: {} });
    assert.equal((await request('DELETE', `/api/collaborators/${grantId}`, { cookie: A.cookie })).status, 204);
    assert.equal((await request('GET', `/api/files/list?path=${encodeURIComponent(repo)}`, { cookie: G })).status, 403);
    assert.equal((await request('GET', '/api/settings', { cookie: `${G}; ${A.cookie}` })).status, 403);
    assert.equal((await request('POST', '/api/invitations/accept', { body: { token: new URLSearchParams(new URL(oldInvite.data.url).hash.slice(1)).get('token') } })).status, 410);
    assert.equal((await request('PATCH', `/api/collaborators/${grantId}`, { cookie: A.cookie, body: draft })).status, 200);
    assert.equal((await request('GET', '/api/current-access', { cookie: G })).status, 403, 'revoked tokens never revive when a grant is reused');
    const stored = fs.readFileSync(path.join(state, 'collaborators.json'), 'utf8');
    assert.equal(stored.includes(token), false);
    assert.equal(fs.readFileSync(path.join(state, 'security.log'), 'utf8').includes(token), false);
  });
  await t.test('lockdown closes chat and terminal sockets, disconnects phones, and keeps admin available', async () => {
    const ws = await socket(`/ws/chat/${chat.id}`, A.cookie);
    assert.equal((await local('POST', '/api/lockdown', { also: [] })).status, 200);
    await Promise.race([ws.closed, pause(3000).then(() => assert.fail('lockdown left chat socket open'))]);
    assert.equal((await local('GET', '/api/state')).data.access.connected, false);
    for (const kind of ['share', 'login']) assert.equal((await local('POST', '/api/qr', { kind })).status, 409, `refuse unusable ${kind} codes while disconnected`);
    await assert.rejects(fetch(`${base}/api/chat`, { signal: AbortSignal.timeout(1000) }));
    assert.equal((await local('PUT', '/api/access', { connected: true })).status, 200);
    assert.equal((await request('GET', '/api/chat', { cookie: A.cookie })).status, 401);
  });
});
