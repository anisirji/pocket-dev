import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, until, freePort } from './helpers/server.mjs';
import { createForward } from '../forward.js';

import { env, device, project, setConfig, listing, trio } from './helpers/forward-trio.mjs';

test('a member reaches the host: files, a download with Range, and a terminal socket', async (t) => {
  const { h, a } = await trio(t);
  const big = crypto.randomBytes(5 * 1024 * 1024);
  fs.writeFileSync(path.join(h.home, 'Desktop', 'big.bin'), big);
  const l = await listing(a, h, path.join(h.home, 'Desktop'));
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.ok(JSON.stringify(l.data).includes('big.bin'));

  const raw = (headers = {}) => new Promise((resolve, reject) => {
    const file = encodeURIComponent(path.join(h.home, 'Desktop', 'big.bin'));
    http.get(`${a.base}/m/${h.id}/api/files/download?path=${file}`, { headers: { cookie: a.cookie, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const whole = await raw();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.body.length, big.length);
  assert.ok(whole.body.equals(big), 'the full 5 MB arrives intact');
  const part = await raw({ range: 'bytes=1000000-3999999' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 1000000-3999999/${big.length}`);
  assert.ok(part.body.equals(big.subarray(1000000, 4000000)));
  assert.equal((await raw({ range: `bytes=${big.length + 5}-` })).status, 416, 'status codes pass through');

  const made = await a.to(h, 'POST', '/api/sessions', { cwd: h.home });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const ws = new WebSocket(`${a.base.replace('http', 'ws')}/m/${h.id}/ws/${made.data.id}`, { headers: { cookie: a.cookie, origin: a.base } });
  let out = '';
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'out') out += m.d; });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  ws.send(JSON.stringify({ t: 'in', d: 'echo from-$((20+22))-host\n' }));
  await until(() => out.includes('from-42-host'), 8000);
  const sessions = await h.request('GET', '/api/sessions', { cookie: h.cookie });
  assert.ok(sessions.data.some((s) => s.id === made.data.id), 'the terminal lives on the host, not on A');
});

test('an upload streams to the target', async (t) => {
  const { h, a } = await trio(t);
  const body = crypto.randomBytes(1_000_000);
  const dir = path.join(h.home, 'Desktop');
  const res = await new Promise((resolve, reject) => {
    const req = http.request(`${a.base}/m/${h.id}/api/files/upload?dir=${encodeURIComponent(dir)}&name=up.bin`, { method: 'POST', headers: { cookie: a.cookie, 'x-pocket-dev': '1', 'content-type': 'application/octet-stream', 'content-length': body.length } }, (r) => {
      let text = ''; r.on('data', (c) => { text += c; }); r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
  assert.ok([200, 201].includes(res.status), res.text);
  assert.ok(fs.readFileSync(path.join(dir, 'up.bin')).equals(body), 'the bytes arrive on the target');
});

test('a member reaches another member through the host, and the target ranks it by its own choice', async (t) => {
  const { h, a, b, repo } = await trio(t);
  const mine = await listing(a, b, repo);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.ok(JSON.stringify(mine.data).includes('a.txt'));
  assert.equal((await listing(a, b, path.join(b.home, 'Desktop', 'other'))).status, 403, 'a folder B did not share');
  assert.equal((await a.to(b, 'GET', '/api/performance')).status, 403, 'a collaborator level device allows files and messages only');
  assert.equal((await a.to(b, 'GET', '/api/sessions')).status, 403);
  assert.equal((await a.to(b, 'POST', '/api/sessions', { cwd: b.home })).status, 403, 'no terminal on B');
  assert.equal((await a.to(b, 'GET', '/api/collaborators')).status, 403, 'owner-only route');
  assert.equal((await h.to(b, 'GET', '/api/performance')).status, 403, 'the host gets the same limits on B');
  assert.equal((await h.to(b, 'GET', '/api/status')).data.role, 'viewer');
  assert.equal(fs.existsSync(path.join(b.home, 'Desktop', 'proj', 'x')), false);
  const write = await a.to(b, 'POST', '/api/files/mkdir', { path: path.join(repo, 'x') });
  assert.equal(write.status >= 400, true, 'a viewer grant cannot write');
  assert.equal((await a.to(h, 'GET', '/api/sessions')).status, 200, 'the host gave admin level, so A may list terminals there');
});

test('rooms cannot be managed through the room, and a loop or a second hop is refused', async (t) => {
  const { h, a, b } = await trio(t);
  assert.equal((await a.to(h, 'POST', '/api/room/kick', { deviceId: b.id })).status, 403, 'a member cannot kick through its admin rank');
  assert.equal((await a.to(h, 'GET', '/api/room')).status, 403);
  assert.equal((await a.to(a, 'GET', '/api/sessions')).status, 400, 'a device does not forward to itself');
  // Asking the host to relay to the host, or a member to relay at all, stops.
  assert.equal((await a.to(h, 'GET', `/m/${b.id}/api/files/places`)).status, 508, 'a path that asks for a second hop is refused');
  assert.equal((await a.to(h, 'GET', '/api/room/devices')).status, 403);
});

test('the device list shows ranks, and a stopped device is offline', async (t) => {
  const { h, a, b } = await trio(t);
  const fromA = (await a.api('GET', '/devices')).data;
  const by = Object.fromEntries(fromA.devices.map((d) => [d.deviceId, d]));
  assert.equal(by[a.id].rank, 'owner');
  assert.equal(by[h.id].rank, 'admin');
  assert.equal(by[b.id].rank, 'collaborator');
  assert.equal(by[a.id].self, true);
  assert.equal(by[b.id].path, 'host');
  assert.equal(by[h.id].path, 'direct');
  assert.equal(by[b.id].name, 'Beta');
  assert.equal((await h.api('GET', '/devices')).data.devices.find((d) => d.deviceId === b.id).path, 'direct');
  assert.equal((await a.request('GET', '/api/room/devices')).status, 401);
  await until(async () => (await h.api('GET', '/devices')).data.devices.find((d) => d.deviceId === b.id).online === true);
  b.proc.kill('SIGTERM');
  await new Promise((r) => b.proc.once('exit', r));
  const dead = await a.to(b, 'GET', '/api/files/places');
  assert.equal(dead.status, 502, JSON.stringify(dead.data));
  assert.match(dead.data.error, /Beta/);
  await until(async () => (await h.api('GET', '/devices?live=1')).data.devices.find((d) => d.deviceId === b.id).online === false, 8000);
});

test('a kicked member is refused at once, directly and through the host', async (t) => {
  const { h, a, b } = await trio(t);
  assert.equal((await listing(a, h, h.home)).status, 200);
  // What A would still hold if the kick note never reached it: its secret for the host.
  const held = JSON.parse(fs.readFileSync(path.join(a.stateDir, 'room.json'), 'utf8')).room;
  const asA = (endpoint, from = a.id) => h.request('GET', endpoint, { headers: { 'x-room-id': held.id, 'x-room-sender': a.id, 'x-room-from': from, 'x-room-secret': held.memberSecret } });
  assert.equal((await asA('/api/sessions')).status, 200, 'the secret works while A is a member');
  assert.equal((await asA('/api/sessions', b.id)).status, 403, 'a member cannot name another member as the origin');
  assert.equal((await h.api('POST', '/kick', { deviceId: a.id })).status, 200);
  const refused = await asA('/api/sessions');
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.match(refused.data.error, /removed/);
  assert.equal((await asA(`/m/${b.id}/api/files/places`)).status, 403, 'the host will not relay for it either');
  await until(async () => (await a.api('GET', '')).data.room === null, 5000);
  assert.equal((await a.to(h, 'GET', '/api/sessions')).status, 409, 'no room, nothing to forward to');
});

test('requests without the room secret behave as before', async (t) => {
  const { h, a } = await trio(t);
  // No cookie and no secret: not logged in.
  assert.equal((await h.request('GET', '/api/sessions')).status, 401);
  assert.equal((await h.request('GET', '/api/files/places')).status, 401);
  assert.equal((await a.request('GET', `/m/${h.id}/api/sessions`)).status, 401, 'the front door needs its own login');
  assert.equal((await a.request('POST', `/m/${h.id}/api/sessions`, { cookie: a.cookie, body: { cwd: h.home }, csrf: false })).status, 403, 'and the x-pocket-dev header');
  assert.equal((await a.request('POST', `/m/${h.id}/api/sessions`, { cookie: a.cookie, body: { cwd: h.home }, headers: { origin: 'http://evil.example' } })).status, 403, 'and the same origin');
  // Room headers without the right secret are refused, not treated as anonymous.
  const room = (extra) => ({ headers: { 'x-room-id': 'x', 'x-room-sender': a.id, 'x-room-from': a.id, ...extra } });
  assert.equal((await h.request('GET', '/api/sessions', room({ 'x-room-secret': 'nope' }))).status, 403);
  const members = (await h.api('GET', '')).data.room;
  assert.equal((await h.request('GET', '/api/sessions', { headers: { 'x-room-id': members.id, 'x-room-sender': a.id, 'x-room-from': a.id, 'x-room-secret': 'a'.repeat(64) } })).status, 403);
  // A device's own cookie still works there as before.
  assert.equal((await h.request('GET', '/api/sessions', { cookie: h.cookie })).status, 200);
  // A secret for A cannot be used to act for another member on the host.
  assert.equal((await h.request('GET', '/api/status')).data.status, 'none');
});

test('forwarding drops hop-by-hop headers and the front cookie, and keeps what the target sends', async (t) => {
  const seen = [];
  const target = http.createServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url, method: req.method });
    res.writeHead(201, { 'x-kept': 'yes', 'set-cookie': 'leak=1', 'proxy-authenticate': 'Basic', 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const address = `http://127.0.0.1:${target.address().port}`;
  const room = { deviceId: () => 'front', route: () => ({ roomId: 'r', sender: 'front', deviceId: 'dead', name: 'Dead', addresses: [address], secret: 's3', relayTo: null }) };
  const replies = [];
  const forward = createForward({ room, auth: { deviceFor: () => ({ id: 'd' }), trackSocket() {} }, collaborators: { guest: () => null },
    sendJson: (res, status, body) => { replies.push([status, body]); res.writeHead(status); res.end(JSON.stringify(body)); } });
  const front = http.createServer((req, res) => forward.http(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  const res = await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/api/x?y=1`, { method: 'POST', headers: { cookie: 'pd_device=front-login', 'x-pocket-dev': '1', 'content-type': 'application/json',
    'x-room-secret': 'forged', 'x-forwarded-for': '1.2.3.4', 'proxy-authorization': 'x' }, body: '{"a":1}' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-kept'), 'yes');
  assert.equal(res.headers.get('set-cookie'), null, 'the target never sets a cookie on the front device');
  assert.equal(res.headers.get('proxy-authenticate'), null);
  const got = seen[0];
  assert.equal(got.url, '/api/x?y=1');
  assert.equal(got.headers.cookie, undefined);
  assert.equal(got.headers['proxy-authorization'], undefined);
  assert.equal(got.headers['x-forwarded-for'], undefined);
  assert.equal(got.headers['x-room-secret'], 's3', 'a forged room secret is replaced');
  assert.equal(got.headers['x-room-from'], 'front');
  assert.equal(got.headers.host, `127.0.0.1:${target.address().port}`);
  assert.equal(got.method, 'POST');
});

test('an address that nothing listens on gives a 502 with a clear message', async (t) => {
  const port = await freePort();
  const room = { deviceId: () => 'front', route: () => ({ roomId: 'r', sender: 'front', deviceId: 'gone', name: 'Gone', addresses: [`http://127.0.0.1:${port}`], secret: 's', relayTo: null }) };
  let reply;
  const forward = createForward({ room, auth: { deviceFor: () => ({ id: 'd' }) }, collaborators: { guest: () => null },
    sendJson: (res, status, body) => { reply = [status, body]; res.writeHead(status); res.end(); } });
  const front = http.createServer((req, res) => forward.http(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/api/x`);
  assert.equal(reply[0], 502);
  assert.match(reply[1].error, /Gone is not reachable/);
});
