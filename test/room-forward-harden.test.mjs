import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { until, freePort } from './helpers/server.mjs';
import { device, trio, listing, setConfig } from './helpers/forward-trio.mjs';
import { createForward } from '../forward.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.mjs');
const wsBase = (s) => s.base.replace('http', 'ws');
const heldBy = (s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'room.json'), 'utf8')).room;

// A socket whose opening and closing can be awaited. `closed` resolves with the close code.
function open(url, headers) {
  const ws = new WebSocket(url, { headers });
  ws.messages = [];
  ws.on('message', (raw) => { try { ws.messages.push(JSON.parse(raw)); } catch { /* not json */ } });
  ws.closed = new Promise((resolve) => ws.once('close', resolve));
  ws.on('error', () => {});
  return new Promise((resolve, reject) => { ws.once('open', () => resolve(ws)); ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`))); ws.once('error', reject); });
}
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))]);
// What the host presents when it vouches for `from` on a member: the host's own secret for that member.
const asHost = (h, target, from) => { const m = heldBy(h).members.find((x) => x.deviceId === target.id); return { 'x-room-id': heldBy(h).id, 'x-room-sender': h.id, 'x-room-secret': m.hostSecret, 'x-room-from': from.id }; };

test('a member that leaves closes the terminal it had open through the front device', async (t) => {
  const { h, a } = await trio(t);
  const made = await a.to(h, 'POST', '/api/sessions', { cwd: h.home });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const ws = await open(`${wsBase(a)}/m/${h.id}/ws/${made.data.id}`, { cookie: a.cookie, origin: a.base });
  t.after(() => ws.terminate());
  ws.send(JSON.stringify({ t: 'in', d: 'echo up-$((1+1))\n' }));
  await until(() => ws.messages.some((m) => m.t === 'out' && m.d.includes('up-2')), 8000);
  assert.equal((await a.api('POST', '/leave')).status, 200);
  await within(ws.closed, 3000, 'the front socket closing');
});

test('a kick closes sockets the member holds on the host and, through the host, on another member', async (t) => {
  const { h, a, b } = await trio(t);
  const made = await h.request('POST', '/api/sessions', { cookie: h.cookie, body: { cwd: h.home } });
  const held = heldBy(a);
  const direct = { 'x-room-id': held.id, 'x-room-sender': a.id, 'x-room-from': a.id, 'x-room-secret': held.memberSecret };
  // The same kind of connection A's front device makes: to the host, and from the host to B on A's behalf.
  const onHost = await open(`${wsBase(h)}/ws/${made.data.id}`, { ...direct, origin: h.base });
  const onBeta = await open(`${wsBase(b)}/ws/messages`, { ...asHost(h, b, a), origin: b.base });
  await until(() => onBeta.messages.some((m) => m.t === 'hello'), 5000);
  // A browser of A working on B through the host.
  const viaHost = await open(`${wsBase(a)}/m/${b.id}/ws/messages`, { cookie: a.cookie, origin: a.base });
  await until(() => viaHost.messages.some((m) => m.t === 'hello'), 5000);
  [onHost, onBeta, viaHost].forEach((ws) => t.after(() => ws.terminate()));
  assert.equal((await h.api('POST', '/kick', { deviceId: a.id })).status, 200);
  await within(onHost.closed, 3000, 'the host closing the socket of the kicked member');
  await within(viaHost.closed, 3000, 'the front socket of the kicked member closing');
  await within(onBeta.closed, 5000, 'the other member closing the socket opened for the kicked member');
});

test('a handover closes sockets that went through the old host', async (t) => {
  const { h, a, b } = await trio(t);
  const ws = await open(`${wsBase(a)}/m/${b.id}/ws/messages`, { cookie: a.cookie, origin: a.base });
  t.after(() => ws.terminate());
  await until(() => ws.messages.some((m) => m.t === 'hello'), 5000);
  assert.equal((await h.api('POST', '/handover', { deviceId: a.id })).status, 200);
  await within(ws.closed, 3000, 'the socket closing after the host changed');
});

test('a redirect to a path on the target stays on the target; absolute and other-site ones are untouched', async (t) => {
  const target = http.createServer((req, res) => { res.writeHead(302, { location: decodeURIComponent(req.url.slice(1)) }); res.end(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const own = `http://127.0.0.1:${target.address().port}`;
  const room = { deviceId: () => 'front', route: () => ({ roomId: 'r', sender: 'front', deviceId: 'abcd', name: 'T', addresses: [own], secret: 's', relayTo: null }) };
  const forward = createForward({ room, auth: { deviceFor: () => ({ id: 'd' }) }, collaborators: { guest: () => null }, sendJson: (res, status) => { res.writeHead(status); res.end(); } });
  const front = http.createServer((req, res) => forward.http(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  const locate = async (location) => (await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/${encodeURIComponent(location)}`, { redirect: 'manual' })).headers.get('location');
  assert.equal(await locate('/login?next=%2Fa'), '/m/abcd/login?next=%2Fa');
  assert.equal(await locate('/'), '/m/abcd/');
  for (const same of ['/m/abcd/already', '//other.example/x', 'https://other.example/x', `${own}/absolute`, 'relative/path', '?q=1']) assert.equal(await locate(same), same, same);
});

test('a chat socket works through a forward, in both directions between admin level devices', async (t) => {
  const { h, a, b } = await trio(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  for (const [front, target] of [[a, h], [h, a]]) {
    const created = await front.to(target, 'POST', '/api/chat', { tool: 'claude', cwd: target.home });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const ws = await open(`${wsBase(front)}/m/${target.id}/ws/chat/${created.data.id}`, { cookie: front.cookie, origin: front.base });
    t.after(() => ws.terminate());
    assert.equal((await front.to(target, 'POST', `/api/chat/${created.data.id}/message`, { text: 'hello there' })).status, 202);
    await until(() => JSON.stringify(ws.messages).includes('first answer'), 8000);
    const own = await target.request('GET', `/api/chat/${created.data.id}`, { cookie: target.cookie });
    assert.equal(own.status, 200, 'the chat lives on the target');
  }
  assert.equal((await a.to(b, 'POST', '/api/chat', { tool: 'claude', cwd: b.home })).status, 403, 'a collaborator level device has no chat');
  await assert.rejects(open(`${wsBase(a)}/m/${b.id}/ws/chat/aaaaaaaaaaaa`, { cookie: a.cookie, origin: a.base }), /refused 40[34]/);
});

test('a messages socket works through a forward, on the host and on a member', async (t) => {
  const { h, a, b } = await trio(t);
  for (const target of [h, b]) {
    const ws = await open(`${wsBase(a)}/m/${target.id}/ws/messages`, { cookie: a.cookie, origin: a.base });
    t.after(() => ws.terminate());
    await until(() => ws.messages.some((m) => m.t === 'hello'), 5000);
    ws.send(JSON.stringify({ t: 'ping' }));
    await until(() => ws.messages.some((m) => m.t === 'pong'), 3000);
  }
  await assert.rejects(open(`${wsBase(a)}/m/${h.id}/ws/messages`, { cookie: a.cookie, origin: 'http://evil.example' }), /refused 403/);
});

test('a member reaches another member through the host, with role access on at the target', async (t) => {
  const { h, a, b, repo } = await trio(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  // Role access: each phone stays an Admin device, everything else would have to be approved.
  setConfig(b, { roleAccessEnabled: false }); // the trio turned it on; B's phone has to be kept as Admin like the others
  for (const s of [h, a, b]) {
    const me = (await s.request('GET', '/api/settings', { cookie: s.cookie })).data.currentDeviceId;
    assert.equal((await s.local('POST', '/api/collaborators/enable', { adminDeviceIds: [me] })).status, 200);
  }
  // B, whose owner shares only one folder, works on A (admin level) through the host.
  assert.equal((await b.to(a, 'GET', '/api/sessions')).status, 200, 'A gave admin level to every member');
  assert.equal((await listing(b, a, a.home)).status, 200);
  const made = await b.to(a, 'POST', '/api/sessions', { cwd: a.home });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const term = await open(`${wsBase(b)}/m/${a.id}/ws/${made.data.id}`, { cookie: b.cookie, origin: b.base });
  t.after(() => term.terminate());
  term.send(JSON.stringify({ t: 'in', d: 'echo via-$((3+4))-host\n' }));
  await until(() => term.messages.some((m) => m.t === 'out' && m.d.includes('via-7-host')), 8000);
  const chat = await b.to(a, 'POST', '/api/chat', { tool: 'claude', cwd: a.home });
  assert.equal(chat.status, 201, JSON.stringify(chat.data));
  const ws = await open(`${wsBase(b)}/m/${a.id}/ws/chat/${chat.data.id}`, { cookie: b.cookie, origin: b.base });
  t.after(() => ws.terminate());
  assert.equal((await b.to(a, 'POST', `/api/chat/${chat.data.id}/message`, { text: 'hi' })).status, 202);
  await until(() => JSON.stringify(ws.messages).includes('first answer'), 8000);
  // The other way: A (admin level on its own device, collaborator rank on B) reaches B and is limited by B.
  assert.equal((await listing(a, b, repo)).status, 200);
  assert.equal((await a.to(b, 'GET', '/api/sessions')).status, 403);
  // A phone that role access left waiting is not a front door.
  const waiting = (await b.login()).cookie;
  assert.equal((await b.request('GET', `/m/${a.id}/api/sessions`, { cookie: waiting })).status, 401);
});

test('when the host is down a member still serves itself, says so for the others, and lists them offline', async (t) => {
  // B was seen a moment ago, so only its dependence on the host can make it offline (its age would need seconds).
  const { h, a, b } = await trio(t, { env: { POCKET_DEV_ROOM_PING_MS: '1500' } });
  await until(async () => (await a.api('GET', '')).data.room.members.find((m) => m.deviceId === b.id).lastSeen, 8000);
  h.proc.kill('SIGTERM');
  await new Promise((r) => h.proc.once('exit', r));
  assert.equal((await a.request('GET', '/api/status', { cookie: a.cookie })).status, 200, 'its own device keeps working');
  const started = Date.now();
  for (const target of [b, h]) {
    const down = await a.to(target, 'GET', '/api/files/places');
    assert.equal(down.status, 502, JSON.stringify(down.data));
    assert.equal(down.data.deviceId, target.id);
    assert.match(down.data.error, /Host.*not reachable/);
  }
  assert.ok(Date.now() - started < 4000, 'a refused connection answers at once');
  assert.match((await a.to(b, 'GET', '/api/files/places')).data.error, /Beta/, 'and says which device cannot be reached');
  const list = (await a.api('GET', '/devices?live=1')).data.devices;
  const by = Object.fromEntries(list.map((d) => [d.deviceId, d]));
  assert.equal(by[a.id].online, true);
  assert.equal(by[h.id].online, false);
  assert.equal(by[b.id].online, false, 'B is only reachable through the host');
  assert.equal(by[b.id].path, 'host');
  assert.equal((await a.api('GET', '/devices')).data.devices.find((d) => d.deviceId === b.id).online, false, 'the plain list agrees');
});

test('a target that accepts the connection and never answers gives a 502 after the limit, not a hang', async (t) => {
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => { silent.closeAllConnections(); silent.close(); });
  const room = { deviceId: () => 'front', route: () => ({ roomId: 'r', sender: 'front', deviceId: 'abcd', name: 'Quiet', addresses: [`http://127.0.0.1:${silent.address().port}`], secret: 's', relayTo: null }) };
  const forward = createForward({ room, auth: { deviceFor: () => ({ id: 'd' }) }, collaborators: { guest: () => null }, answerMs: 300,
    sendJson: (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } });
  const front = http.createServer((req, res) => forward.http(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/api/x`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Quiet did not answer/);
  assert.ok(Date.now() - started < 3000);
  // A slow upload is not cut short by that limit: the clock starts after the body was handed over.
  const sending = Date.now();
  const slow = await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/api/up`, { method: 'POST', headers: { 'x-pocket-dev': '1' }, signal: AbortSignal.timeout(5000),
    duplex: 'half', body: new ReadableStream({ async start(c) { for (let i = 0; i < 4; i++) { c.enqueue(new Uint8Array(10)); await new Promise((r) => setTimeout(r, 200)); } c.close(); } }) });
  assert.equal(slow.status, 502, 'only after the body was sent and nothing came back');
  assert.ok(Date.now() - sending >= 1000, 'the 800 ms upload finished before the 300 ms limit counted');
});

test('wrong room secrets are limited on forwarded requests, the peer routes and sync, and a correct one is refused while locked', async (t) => {
  const { h, a } = await trio(t);
  const held = heldBy(a);
  const guess = (secret, sender = a.id) => h.request('GET', '/api/sessions', { headers: { 'x-room-id': held.id, 'x-room-sender': sender, 'x-room-from': sender, 'x-room-secret': secret } });
  assert.equal((await guess(held.memberSecret)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await guess('f'.repeat(64))).status, 403);
  const locked = await guess('f'.repeat(64));
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Too many/);
  assert.equal((await guess(held.memberSecret)).status, 429, 'the lock covers the right secret too, as with the login');
  assert.equal((await guess('f'.repeat(64), 'someone-else')).status, 403, 'another claimed device is counted on its own');

  assert.equal((await h.request('GET', '/api/sessions', { cookie: h.cookie })).status, 200, 'the owner\'s own login is not affected');
});

test('wrong secrets on the peer routes and wrong join codes are limited, and so is an address that keeps changing the name it claims', async (t) => {
  const { h, a } = await trio(t);
  const held = heldBy(a);
  const peer = (route, body) => h.request('POST', route, { body });
  for (const [route, extra] of [['/api/room/ping', {}], ['/api/room/notify', { type: 'members' }], ['/api/room/sync/tasks/pull', {}]]) {
    const body = { roomId: held.id, from: `guesser-${route}`, secret: 'e'.repeat(64), ...extra };
    for (let i = 0; i < 10; i++) assert.equal((await peer(route, body)).status, 403, `${route} #${i}`);
    assert.equal((await peer(route, body)).status, 429, route);
  }
  // Join codes are guessed the same way (the claimed device is the joiner).
  const join = (code) => peer('/api/room/accept', { code, deviceId: 'joiner', hostSecret: 'x'.repeat(40), name: 'J', addresses: ['http://127.0.0.1:1'], level: 'admin' });
  for (let i = 0; i < 10; i++) assert.equal((await join(`wrong${i}`)).status, 403);
  assert.equal((await join('wrong')).status, 429);
  // 40 failures from one address under ever new names lock the address, whoever it claims to be.
  const fresh = (i) => peer('/api/room/ping', { roomId: held.id, from: `rotating-${i}`, secret: 'd'.repeat(64) });
  let status;
  for (let i = 0; i < 60 && status !== 429; i++) status = (await fresh(i)).status;
  assert.equal(status, 429);
  assert.equal((await peer('/api/room/ping', { roomId: held.id, from: a.id, secret: held.memberSecret })).status, 429, 'even the real member, from this address');
});

test('an oversized body on a peer route is refused with a reason', async (t) => {
  const { h, a } = await trio(t);
  const held = heldBy(a);
  const big = { roomId: held.id, from: a.id, secret: held.memberSecret, changes: [{ pad: 'x'.repeat(200_000) }] };
  for (const route of ['/api/room/notify', '/api/room/sync/tasks/push', '/api/room/ping']) {
    const res = await h.request('POST', route, { body: big });
    assert.equal(res.status, 413, route);
    assert.match(res.data.error, /too large/);
  }
  assert.equal((await h.request('POST', '/api/room/ping', { body: { roomId: held.id, from: a.id, secret: held.memberSecret } })).status, 200, 'the server is fine afterwards');
});
