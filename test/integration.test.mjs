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
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: {
    ...process.env, HOME: home, SHELL: '/bin/zsh', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: config,
    POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1', POCKET_DEV_CLAUDE: '/nonexistent/claude',
    POCKET_DEV_CODEX: '/nonexistent/codex', POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub,
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
  const assets = ['/git.js', '/graph.js', '/git.css', '/history.js', '/history.css', '/settings.js', '/settings.css', '/apps.js', '/apps.css', '/power.js', '/service.js', '/chat.js', '/chat.css', '/files.js', '/files.css'];
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
  let chat, session;
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
  });
  await t.test('an unavailable Codex binary falls back without hanging Chat options', async () => {
    const options = await request('GET', '/api/chat/options', { cookie: A.cookie });
    assert.equal(options.status, 200);
    assert.ok(options.data.tools.codex.settings.find((s) => s.key === 'model').choices.length);
    const created = await request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'codex', cwd: home } });
    assert.equal(created.status, 201);
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
  await t.test('lockdown closes chat and terminal sockets, disconnects phones, and keeps admin available', async () => {
    const ws = await socket(`/ws/chat/${chat.id}`, A.cookie);
    assert.equal((await local('POST', '/api/lockdown', { also: [] })).status, 200);
    await Promise.race([ws.closed, pause(3000).then(() => assert.fail('lockdown left chat socket open'))]);
    assert.equal((await local('GET', '/api/state')).data.access.connected, false);
    await assert.rejects(fetch(`${base}/api/chat`, { signal: AbortSignal.timeout(1000) }));
    assert.equal((await local('PUT', '/api/access', { connected: true })).status, 200);
    assert.equal((await request('GET', '/api/chat', { cookie: A.cookie })).status, 401);
  });
});
