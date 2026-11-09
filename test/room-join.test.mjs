import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom, reachableAddresses } from '../room.js';
import { startServer, freePort } from './helpers/server.mjs';

const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

// A room in this process, called through handleApi the way the server does, for rules that need a fake clock or no loopback allowance.
function local(t, { urls = {}, allowLoopback = false, clock = { t: 1_000_000 } } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-join-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const room = createRoom({ stateDir, config: {}, urls: () => urls, now: () => clock.t, allowLoopback: () => allowLoopback, every: () => () => {},
    fetchImpl: async () => { throw new Error('no network'); } });
  const call = async (method, name, body = {}, host = '127.0.0.1:7777') => {
    let out;
    const req = { method, url: `/api/room/${name}`, headers: { host, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } };
    await room.handleApi(req, {}, new URL(`http://x/api/room/${name}`), { readJson: async () => body, sendJson: (_r, status, data) => { out = { status, data }; }, loggedIn: true });
    return out;
  };
  return { room, call, clock };
}

test('invite codes are 8 characters from an unambiguous alphabet, shown ABCD-EFGH', async (t) => {
  const { call } = local(t, { urls: { lan: 'http://192.168.1.24:7777' } });
  await call('POST', 'create', {});
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const { data } = await call('POST', 'invite');
    assert.match(data.code, CODE);
    assert.equal(/[01OIL]/.test(data.code), false);
    assert.equal(data.expiresInSeconds, 600);
    seen.add(data.code);
  }
  assert.equal(seen.size, 40);
});

test('the invite carries an address other devices can reach, never loopback', async (t) => {
  const { call } = local(t, { urls: { lan: 'http://192.168.1.24:7777', local: 'http://mac.local:7777' } });
  await call('POST', 'create', {});
  const viaLoopback = (await call('POST', 'invite', {}, '127.0.0.1:7777')).data;
  assert.equal(viaLoopback.address, 'http://192.168.1.24:7777');
  assert.equal(viaLoopback.addresses.some((a) => /127\.0\.0\.1|localhost/.test(a)), false);
  assert.equal(viaLoopback.invite, `192.168.1.24:7777  ${viaLoopback.code}`);
  const viaLan = (await call('POST', 'invite', {}, '192.168.1.99:7777')).data;
  assert.equal(viaLan.address, 'http://192.168.1.99:7777', 'the address the request came in on comes first');
  assert.deepEqual(reachableAddresses({ req: { headers: { host: 'localhost:7777' } }, urls: { lan: null }, allowLoopback: false }), []);
  assert.deepEqual(reachableAddresses({ req: { headers: { host: 'mac.example.com', 'x-forwarded-proto': 'https' } }, urls: { lan: 'http://10.0.0.2:7777' } }), ['https://mac.example.com', 'http://10.0.0.2:7777']);
});

test('a device with no reachable address cannot make an invite, and the member address follows the same rule', async (t) => {
  const { call } = local(t, { urls: { lan: null } });
  const created = await call('POST', 'create', {});
  assert.equal(created.status, 400);
  assert.equal(created.data.code, 'no-address');
  assert.equal((await call('POST', 'create', { addresses: ['http://127.0.0.1:7777'] })).data.code, 'loopback');
  assert.equal((await call('POST', 'create', { addresses: ['http://localhost:7777'] })).status, 400);
  assert.equal((await call('POST', 'create', { addresses: ['http://[::1]:7777'] })).status, 400);
  assert.equal((await call('POST', 'create', { addresses: ['http://192.168.1.24:7777'] })).status, 200);
  assert.equal((await call('POST', 'invite', {}, '127.0.0.1:7777')).data.address, 'http://192.168.1.24:7777', 'falls back to the address stored for the host');
});

test('join refuses a loopback host or loopback own address before any request, unless the test opt-in is on', async (t) => {
  const { call } = local(t, { urls: { lan: 'http://192.168.1.50:7777' } });
  const toLoopback = await call('POST', 'join', { code: 'ABCD-EFGH', host: 'http://127.0.0.1:7777', level: 'admin' });
  assert.equal(toLoopback.status, 400);
  assert.match(toLoopback.data.error, /127\.0\.0\.1.*not the host/);
  const ownLoopback = await call('POST', 'join', { code: 'ABCD-EFGH', host: 'http://192.168.1.24:7777', addresses: ['http://localhost:7777'], level: 'admin' });
  assert.equal(ownLoopback.status, 400);
  assert.equal(ownLoopback.data.code, 'loopback');
  // With the opt-in, the same host passes validation and fails only because nothing answers.
  const open = local(t, { allowLoopback: true, urls: { lan: 'http://127.0.0.1:7777' } });
  const r = await open.call('POST', 'join', { code: 'ABCD-EFGH', host: 'http://127.0.0.1:7777', level: 'admin' });
  assert.equal(r.status, 502);
});

test('a wrong, an expired and a used code are told apart; case, hyphen and spaces do not matter; single use', async (t) => {
  const clock = { t: 1_000_000 };
  const { call } = local(t, { urls: { lan: 'http://192.168.1.24:7777' }, allowLoopback: true, clock });
  await call('POST', 'create', {});
  const accept = (code, id = 'dev1') => call('POST', 'accept', { code, deviceId: id, name: 'Phone', addresses: ['http://192.168.1.60:7777'], hostSecret: 'x'.repeat(40), level: 'admin' });
  const { code } = (await call('POST', 'invite')).data;
  assert.equal((await accept('ZZZZ-ZZZZ')).data.code, 'wrong-code');
  const typed = ` ${code.slice(0, 4).toLowerCase()} ${code.slice(5).toLowerCase()} `;
  assert.equal((await accept(typed)).status, 200);
  const again = await accept(code, 'dev2');
  assert.equal(again.status, 403);
  assert.equal(again.data.code, 'used-code');
  const old = (await call('POST', 'invite')).data.code;
  clock.t += 10 * 60_000 + 1;
  const late = await accept(old, 'dev3');
  assert.equal(late.status, 403);
  assert.equal(late.data.code, 'expired-code');
});

test('a wrong short code locks the guesser out after the limit', async (t) => {
  const a = await startServer(t);
  a.cookie = (await a.login()).cookie;
  await a.request('POST', '/api/room/create', { cookie: a.cookie, body: { addresses: [a.base] } });
  const { data: { code } } = await a.request('POST', '/api/room/invite', { cookie: a.cookie, body: {} });
  const guess = (n) => a.request('POST', '/api/room/accept', { body: { code: `AAAA-${String(n).padStart(4, '2')}`.replace(/[01OIL]/g, '2'), deviceId: 'guesser', name: 'x', addresses: [a.base], hostSecret: 'x'.repeat(40), level: 'admin' } });
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await guess(i)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(403));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  const right = await a.request('POST', '/api/room/accept', { body: { code, deviceId: 'guesser', name: 'x', addresses: [a.base], hostSecret: 'x'.repeat(40), level: 'admin' } });
  assert.equal(right.status, 429, 'even the right code is refused while locked');
});

async function pair(t) {
  const a = await startServer(t), b = await startServer(t);
  for (const s of [a, b]) {
    s.cookie = (await s.login()).cookie;
    s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
  }
  return { a, b };
}

test('a join to an address nothing answers on says which address was tried', async (t) => {
  const { a, b } = await pair(t);
  const dead = `http://127.0.0.1:${await freePort()}`;
  const r = await b.api('POST', '/join', { code: 'ABCD-EFGH', host: dead, addresses: [b.base], level: 'admin' });
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'unreachable');
  assert.ok(r.data.error.includes(dead), r.data.error);
});

test('after a join the host calls the joiner back; a joiner it cannot reach is told so, and can fix its address', async (t) => {
  const { a, b } = await pair(t);
  await a.api('POST', '/create', { name: 'Host', addresses: [a.base] });
  const good = (await a.api('POST', '/invite')).data;
  assert.match(good.code, CODE);
  const dead = `http://127.0.0.1:${await freePort()}`;
  const r = await b.api('POST', '/join', { code: good.code.toLowerCase().replace('-', ' '), host: a.base, addresses: [dead], name: 'Desktop', level: 'admin' });
  assert.equal(r.status, 200, 'the join itself succeeds');
  assert.equal(r.data.room.role, 'member');
  assert.equal(r.data.callback.ok, false);
  assert.deepEqual(r.data.callback.tried, [dead]);
  const fixed = await b.api('POST', '/address', { addresses: [b.base] });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.data.callback.ok, true);
  assert.equal(fixed.data.callback.address, b.base);
  const members = (await a.api('GET', '')).data.room.members;
  assert.deepEqual(members.find((m) => m.name === 'Desktop').addresses, [b.base]);
});

test('a normal join reports a working callback, and GET /api/room carries the addresses this device would advertise', async (t) => {
  const { a, b } = await pair(t);
  await a.api('POST', '/create', { name: 'Host', addresses: [a.base] });
  const { code } = (await a.api('POST', '/invite')).data;
  const r = await b.api('POST', '/join', { code, host: a.base, name: 'Desktop', addresses: [b.base], level: 'admin' });
  assert.equal(r.data.callback.ok, true);
  const view = (await b.api('GET', '')).data;
  assert.ok(Array.isArray(view.advertised) && view.advertised.length > 0);
});
