import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

// Two real servers, each in its own throwaway HOME and state folder (startServer uses isolatedEnv).
async function pair(t) {
  const a = await startServer(t), b = await startServer(t);
  for (const s of [a, b]) {
    s.cookie = (await s.login()).cookie;
    s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
    s.file = () => path.join(s.stateDir, 'room.json');
    s.stored = () => JSON.parse(fs.readFileSync(s.file(), 'utf8'));
  }
  return { a, b };
}
const created = async (a) => (await a.api('POST', '/create', { name: 'Laptop', addresses: [a.base] })).data;
async function joined(a, b, access = { level: 'admin' }) {
  await created(a);
  const { data: { code } } = await a.api('POST', '/invite');
  const r = await b.api('POST', '/join', { code, host: a.base, name: 'Desktop', addresses: [b.base], ...access });
  return { code, r };
}

test('create makes a host room, stored 0600, and the device keeps its id', async (t) => {
  const { a } = await pair(t);
  const empty = (await a.api('GET', '')).data;
  assert.equal(empty.room, null);
  assert.match(empty.deviceId, /^[0-9a-f]{16}$/);
  const room = await created(a);
  assert.equal(room.deviceId, empty.deviceId);
  assert.equal(room.room.role, 'host');
  assert.equal(room.room.hostId, room.deviceId);
  assert.equal((fs.statSync(a.file()).mode & 0o777), 0o600);
  assert.equal((await a.api('POST', '/create', {})).status, 409, 'one device, one room');
});

test('room routes need the login and the x-pocket-dev header', async (t) => {
  const { a } = await pair(t);
  assert.equal((await a.request('GET', '/api/room')).status, 401);
  assert.equal((await a.request('POST', '/api/room/create', { cookie: a.cookie, body: {}, csrf: false })).status, 403);
});

test('invite, join: the code works once, the member gets the room and the host learns the member', async (t) => {
  const { a, b } = await pair(t);
  const { code, r } = await joined(a, b, { level: 'collaborator', folders: ['/srv/shared'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.room.role, 'member');
  const host = (await a.api('GET', '')).data.room;
  assert.equal(host.members.length, 2);
  const member = host.members.find((m) => m.role === 'member');
  assert.deepEqual([member.name, member.level, member.folders, member.addresses], ['Desktop', 'collaborator', ['/srv/shared'], [b.base]]);
  assert.equal(r.data.room.id, host.id);
  assert.equal(JSON.stringify(host).includes('Secret'), false, 'the view carries no secrets');
  const third = await startServer(t);
  third.cookie = (await third.login()).cookie;
  const again = await third.request('POST', '/api/room/join', { cookie: third.cookie, body: { code, host: a.base, addresses: [third.base], level: 'admin' } });
  assert.equal(again.status, 403, 'single use');
  assert.equal((await b.api('POST', '/join', { code: 'x', host: a.base, level: 'admin', addresses: [b.base] })).status, 409, 'already in a room');
});

test('a join needs a valid level, folders for a collaborator, and a live code', async (t) => {
  const { a, b } = await pair(t);
  await created(a);
  const { data: { code } } = await a.api('POST', '/invite');
  assert.equal((await b.api('POST', '/join', { code, host: a.base, addresses: [b.base], level: 'collaborator', folders: [] })).status, 400);
  assert.equal((await b.api('POST', '/join', { code: 'wrong', host: a.base, addresses: [b.base], level: 'admin' })).status, 403);
  assert.equal((await b.api('POST', '/join', { code, host: a.base, addresses: [b.base], level: 'admin' })).status, 200, 'a refused attempt did not use the code');
});

test('kick: the member loses the room secret at once and cannot ping the host', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  const { secretHash, memberSecret } = { ...a.stored().room.members[1], memberSecret: b.stored().room.memberSecret };
  assert.ok(secretHash && memberSecret);
  const bId = b.stored().deviceId;
  const r = await a.api('POST', '/kick', { deviceId: bId });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, true);
  assert.equal(r.data.room.members.length, 1);
  assert.equal(r.data.room.revoked[0].deviceId, bId);
  assert.equal(b.stored().room, null, 'the kicked device deleted the room and its secret');
  assert.equal(JSON.stringify(a.stored()).includes(secretHash), false);
  const ping = await a.request('POST', '/api/room/ping', { body: { roomId: r.data.room.id, from: bId, secret: memberSecret } });
  assert.equal(ping.status, 403);
  assert.match(ping.data.error, /removed/);
  assert.equal((await a.api('POST', '/kick', { deviceId: bId })).status, 404);
});

test('leave: the member drops the room and the host removes it from the list', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  const memberSecret = b.stored().room.memberSecret;
  const left = await b.api('POST', '/leave');
  assert.equal(left.status, 200);
  assert.equal(left.data.room, null);
  assert.equal(b.stored().room, null);
  const host = (await a.api('GET', '')).data.room;
  assert.equal(host.members.length, 1);
  assert.equal(host.revoked[0].reason, 'left');
  const ping = await a.request('POST', '/api/room/ping', { body: { roomId: host.id, from: b.stored().deviceId, secret: memberSecret } });
  assert.equal(ping.status, 403);
  assert.equal((await b.api('POST', '/leave')).status, 409);
  assert.equal((await a.api('POST', '/leave')).data.room, null, 'a host alone can close its room');
});

test('a host with members cannot leave until it hands over', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  assert.equal((await a.api('POST', '/leave')).status, 409);
});

test('handover: the new host controls, the old host becomes a member, the old host cannot kick', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  const aId = a.stored().deviceId, bId = b.stored().deviceId;
  const r = await a.api('POST', '/handover', { deviceId: bId });
  assert.equal(r.status, 200);
  assert.equal(r.data.room.role, 'member');
  assert.equal(r.data.room.hostId, bId);
  const nb = (await b.api('GET', '')).data.room;
  assert.deepEqual([nb.role, nb.hostId], ['host', bId]);
  assert.equal((await a.api('POST', '/kick', { deviceId: bId })).status, 403);
  assert.equal((await a.api('POST', '/invite')).status, 403);
  assert.equal((await b.api('POST', '/invite')).status, 200);
  assert.equal((await a.api('GET', '?live=1')).data.room.members.find((m) => m.deviceId === bId).online, true);
  const kicked = await b.api('POST', '/kick', { deviceId: aId });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.data.notified, true, 'the new host reaches the old host with the secret from the handover');
  assert.equal(a.stored().room, null);
});

test('a member cannot kick, invite, hand over or tell another member anything', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  const aId = a.stored().deviceId, roomId = b.stored().room.id;
  for (const [route, body] of [['/kick', { deviceId: aId }], ['/invite', {}], ['/handover', { deviceId: aId }]]) {
    assert.equal((await b.api('POST', route, body)).status, 403, route);
  }
  assert.equal((await b.api('GET', '')).data.room.members.length, 2);
  const secret = b.stored().room.memberSecret;
  const forged = await b.request('POST', '/api/room/notify', { body: { roomId, from: aId, secret, type: 'kicked' } });
  assert.equal(forged.status, 403, 'the member secret does not make a host');
  assert.ok(b.stored().room);
  const toHost = await a.request('POST', '/api/room/notify', { body: { roomId, from: b.stored().deviceId, secret, type: 'kicked' } });
  assert.equal(toHost.status, 403, 'a member can only leave, not act on the host');
});

test('ping: peers prove themselves, strangers are refused, and GET ?live=1 reports who answers', async (t) => {
  const { a, b } = await pair(t);
  await joined(a, b);
  const roomId = a.stored().room.id;
  assert.equal((await a.request('POST', '/api/room/ping', { body: { roomId, from: b.stored().deviceId, secret: 'nope' } })).status, 403);
  const ok = await a.request('POST', '/api/room/ping', { body: { roomId, from: b.stored().deviceId, secret: b.stored().room.memberSecret } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal((await a.api('GET', '?live=1')).data.room.members.find((m) => m.role === 'member').online, true);
  assert.equal((await b.api('GET', '?live=1')).data.room.members.find((m) => m.role === 'host').online, true);
  b.proc.kill('SIGTERM');
  await new Promise((resolve) => b.proc.once('exit', resolve));
  assert.equal((await a.api('GET', '?live=1')).data.room.members.find((m) => m.role === 'member').online, false);
});
