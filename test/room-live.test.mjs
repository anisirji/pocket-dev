import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, until, pause } from './helpers/server.mjs';

// Real servers with a 250 ms room timer, each in its own throwaway HOME and state folder.
const env = { POCKET_DEV_ROOM_PING_MS: '250' };
async function device(t) {
  const s = await startServer(t, { env });
  s.cookie = (await s.login()).cookie;
  wire(s);
  return s;
}
function wire(s) {
  s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
  s.stored = () => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'room.json'), 'utf8'));
  s.members = async () => (await s.api('GET', '')).data.room?.members;
  s.member = async (id) => (await s.members())?.find((m) => m.deviceId === id);
  s.stop = async () => { s.proc.kill('SIGTERM'); await new Promise((resolve) => s.proc.once('exit', resolve)); };
}
async function restart(t, s) {
  const again = await startServer(t, { env, reuse: s });
  again.cookie = s.cookie;
  wire(again);
  return again;
}
async function join(host, guest, access = { level: 'admin' }, name = 'Guest') {
  const { data: { code } } = await host.api('POST', '/invite');
  const r = await guest.api('POST', '/join', { code, host: host.base, name, addresses: [guest.base], ...access });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return guest.stored().deviceId;
}
const hostRoom = async (a) => (await a.api('POST', '/create', { name: 'Host', addresses: [a.base] })).data;

test('liveness: members get status and lastSeen; a dead device shows offline and recovers when it returns', async (t) => {
  const a = await device(t), b = await device(t);
  await hostRoom(a);
  const bId = await join(a, b);
  await until(async () => (await a.member(bId)).status === 'online' && (await a.member(bId)).lastSeen);
  const host = (await a.members()).find((m) => m.role === 'host');
  assert.equal(host.status, 'online');
  assert.ok(host.lastSeen);
  assert.equal((await a.api('GET', '?live=1')).data.room.members.find((m) => m.deviceId === bId).online, true, '?live=1 still answers');
  await until(async () => (await b.member(a.stored().deviceId)).status === 'online');
  const seenBefore = (await a.member(bId)).lastSeen;

  await b.stop();
  await until(async () => (await a.member(bId)).status === 'offline', 5000);
  assert.equal((await a.member(bId)).lastSeen >= seenBefore, true, 'lastSeen is kept while offline');

  const back = await restart(t, b);
  await until(async () => (await a.member(bId)).status === 'online', 5000);
  assert.ok((await a.member(bId)).lastSeen > seenBefore);
  assert.equal((await back.members()).length, 2, 'the returning device kept its room');
});

test('liveness: a member sees the host go offline and other members go offline through the host', async (t) => {
  const a = await device(t), b = await device(t), c = await device(t);
  await hostRoom(a);
  const aId = a.stored().deviceId;
  const bId = await join(a, b), cId = await join(a, c);
  await until(async () => (await b.member(cId))?.status === 'online' && (await b.member(aId))?.status === 'online');
  await c.stop();
  await until(async () => (await b.member(cId)).status === 'offline', 5000);
  await a.stop();
  await until(async () => (await b.member(aId)).status === 'offline', 5000);
  assert.equal((await b.member(bId)).status, 'online', 'a device is always online to itself');
});

test('a device without a room reports no members and the timer does nothing', async (t) => {
  const a = await device(t);
  await pause(600);
  assert.equal((await a.api('GET', '')).data.room, null);
});

test('retry: a kick for a device that is offline is queued and arrives when it returns', async (t) => {
  const a = await device(t), b = await device(t);
  await hostRoom(a);
  const bId = await join(a, b);
  await until(async () => (await a.member(bId)).status === 'online');
  await b.stop();
  const kicked = await a.api('POST', '/kick', { deviceId: bId });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.data.notified, false);
  assert.equal(kicked.data.room.members.length, 1);
  assert.equal(a.stored().outbox.length, 1, 'the kick waits in the outbox');
  assert.equal(a.stored().outbox[0].body.type, 'kicked');
  assert.ok(b.stored().room, 'the dead device still believes it is in the room');

  const back = await restart(t, b);
  await until(() => back.stored().room === null, 5000);
  await until(() => a.stored().outbox.length === 0, 5000);
});

test('retry: a member list for an offline member is queued, replaced by a newer one, and sent fresh', async (t) => {
  const a = await device(t), b = await device(t), c = await device(t), d = await device(t);
  await hostRoom(a);
  const bId = await join(a, b), cId = await join(a, c);
  await until(async () => (await a.member(bId)).status === 'online');
  await c.stop();
  const dId = await join(a, d);
  await until(() => a.stored().outbox.some((i) => i.deviceId === cId), 3000);
  await a.api('POST', '/kick', { deviceId: dId });
  await until(async () => (await a.members()).length === 3);
  assert.equal(a.stored().outbox.filter((i) => i.deviceId === cId && i.body.type === 'members').length, 1, 'one list per device');
  const back = await restart(t, c);
  await until(async () => (await back.members())?.length === 3 && !(await back.members()).some((m) => m.deviceId === dId), 5000);
  await until(() => a.stored().outbox.length === 0, 5000);
});

test('retry: a member that leaves while the host is down tells it when the host returns', async (t) => {
  const a = await device(t), b = await device(t);
  await hostRoom(a);
  const bId = await join(a, b);
  await a.stop();
  assert.equal((await b.api('POST', '/leave')).data.room, null);
  assert.equal(b.stored().outbox.length, 1);
  const back = await restart(t, a);
  await until(async () => (await back.members()).length === 1, 5000);
  assert.equal((await back.api('GET', '')).data.room.revoked[0].reason, 'left');
  assert.equal(b.stored().outbox.length, 0, 'the delivered leave left the outbox');
  assert.equal((await back.api('GET', '')).data.room.revoked[0].deviceId, bId);
});

// A Git project and a plain folder inside the device's own HOME, so collaborators.js accepts them.
function projects(s) {
  const repo = path.join(s.home, 'Desktop', 'proj'), extra = path.join(s.home, 'Desktop', 'notes');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
  fs.mkdirSync(extra, { recursive: true });
  return { repo, extra };
}
const grantsOn = async (s) => (await s.request('GET', '/api/collaborators', { cookie: s.cookie })).data.collaborators;
const live = (list) => list.filter((g) => !g.revoked);

test('access: a collaborator level becomes a grant per other member; admin becomes trust; leaving and kicks revoke everywhere', async (t) => {
  const a = await device(t), b = await device(t), c = await device(t);
  const { repo, extra } = projects(b);
  await hostRoom(a);
  const aId = a.stored().deviceId;
  const bId = await join(a, b, { level: 'collaborator', folders: [repo, extra], grantRole: 'viewer' }, 'Desk');
  assert.equal(b.stored().room.members.length, 2);
  let onB = live(await grantsOn(b));
  assert.equal(onB.length, 1, 'one grant for the host, made at join');
  assert.deepEqual([onB[0].room.deviceId, onB[0].role, onB[0].label, onB[0].expiresAt, onB[0].status], [aId, 'viewer', 'Host', null, 'inactive']);
  assert.deepEqual(onB[0].roots.map((r) => [r.readOnly]), [[true], [true]]);
  assert.equal(onB[0].extraFolders.length, 1);
  assert.deepEqual((await a.api('GET', '')).data.room.trustedAdmins, [bId], 'the host is admin level, so its member is trusted on it');
  assert.deepEqual((await b.api('GET', '')).data.room.trustedAdmins, [], 'b gave collaborator access, not admin');

  const cId = await join(a, c);
  assert.deepEqual((await c.api('GET', '')).data.room.trustedAdmins.sort(), [aId, bId].sort(), 'c is full admin on c: both others are trusted there');
  assert.equal((await grantsOn(c)).length, 0, 'admin level makes no grants');
  await until(async () => live(await grantsOn(b)).length === 2, 5000);
  assert.deepEqual(live(await grantsOn(b)).map((g) => g.room.deviceId).sort(), [aId, cId].sort(), 'b learned about c from the host');

  await a.api('POST', '/kick', { deviceId: cId });
  await until(async () => live(await grantsOn(b)).length === 1, 5000);
  assert.equal((await grantsOn(b)).find((g) => g.room.deviceId === cId).status, 'revoked');
  await until(() => c.stored().room === null, 5000);
  assert.deepEqual((await c.api('GET', '')).data.room, null);

  await b.api('POST', '/leave');
  assert.equal(live(await grantsOn(b)).length, 0, 'leaving revokes the grants on the leaving device at once');
  assert.equal((await b.members()), undefined);
});

test('access: a grant follows the room entry across a kick while the device is offline', async (t) => {
  const a = await device(t), b = await device(t), c = await device(t);
  const { repo } = projects(b);
  await hostRoom(a);
  await join(a, b, { level: 'collaborator', folders: [repo], grantRole: 'developer' }, 'Desk');
  const cId = await join(a, c);
  await until(async () => live(await grantsOn(b)).length === 2, 5000);
  const dev = live(await grantsOn(b))[0];
  assert.equal(dev.role, 'developer');
  assert.ok(dev.workspace && fs.existsSync(dev.workspace), 'a developer gets a project copy');
  await b.stop();
  await a.api('POST', '/kick', { deviceId: cId });
  const back = await restart(t, b);
  await until(async () => live(await grantsOn(back)).length === 1, 5000);
  assert.equal((await grantsOn(back)).find((g) => g.room.deviceId === cId).revoked, true, 'b learned of the kick when it came back');
});

test('access: bad roles and too many folders are refused; a folder that cannot be shared is reported and makes no grant', async (t) => {
  const a = await device(t), b = await device(t);
  const { repo } = projects(b);
  await hostRoom(a);
  const { data: { code } } = await a.api('POST', '/invite');
  const body = (extra) => ({ code, host: a.base, addresses: [b.base], level: 'collaborator', ...extra });
  assert.equal((await b.api('POST', '/join', body({ folders: [repo], grantRole: 'admin' }))).status, 400);
  assert.equal((await b.api('POST', '/join', body({ folders: Array(7).fill(repo) }))).status, 400, 'one repository and five extra folders at most');
  const bId = await join(a, b, { level: 'collaborator', folders: ['/nonexistent/place'] }, 'Desk');
  assert.ok((await b.api('GET', '')).data.room.accessErrors, 'a folder that cannot be shared is reported, not silently ignored');
  assert.equal(live(await grantsOn(b)).length, 0);
  await a.api('POST', '/kick', { deviceId: bId });
  await until(() => b.stored().room === null, 5000);
});

// In process, with a fake clock, a fake timer and a fake network: no real waiting.
import os from 'node:os';
import { createRoom } from '../room.js';
function inProcess(t, name, net, clock, timers) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-unit-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const origin = `http://${name}.test`;
  const room = createRoom({ stateDir, config: {}, urls: () => ({ local: origin }), now: () => clock.t, intervalMs: 1000,
    every: (fn) => { timers.push(fn); return () => {}; },
    fetchImpl: async (url, { body, signal }) => {
      const u = new URL(url), target = net[new URL(u.origin).hostname.split('.')[0]];
      if (!target || target.down) throw new Error('unreachable');
      let status = 0, payload;
      await target.room.handleApi({ method: 'POST', headers: { 'content-type': 'x' }, url: u.pathname }, {}, u,
        { readJson: async () => JSON.parse(body), sendJson: (_, s, d) => { status = s; payload = d; }, loggedIn: false });
      return { status, json: async () => payload };
    } });
  const call = async (route, body = {}, method = 'POST') => {
    let out;
    await room.handleApi({ method, headers: { 'content-type': 'x' } }, {}, new URL(`http://x/api/room/${route}`), { readJson: async () => body, sendJson: (_, s, d) => { out = { status: s, data: d }; }, loggedIn: true });
    return out;
  };
  net[name] = { room };
  return { room, call, origin, net: net[name] };
}

test('fake clock and timer: offline after a missed ping, back on the next, and silence alone ages a device out', async (t) => {
  const clock = { t: 1_000_000 }, timers = [], net = {};
  const a = inProcess(t, 'a', net, clock, timers), b = inProcess(t, 'b', net, clock, timers);
  await a.call('create', { name: 'A', addresses: [a.origin] });
  const { data: { code } } = await a.call('invite');
  assert.equal((await b.call('join', { code, host: a.origin, addresses: [b.origin], level: 'admin' })).status, 200);
  const bId = b.room.deviceId();
  const status = async () => (await a.call('', {}, 'GET')).data.room.members.find((m) => m.deviceId === bId);
  await a.room.tick();
  assert.deepEqual([(await status()).status, (await status()).lastSeen], ['online', clock.t]);
  b.net.down = true;
  clock.t += 1000;
  await a.room.tick();
  assert.equal((await status()).status, 'offline', 'a failed ping shows at once');
  assert.equal((await status()).lastSeen, clock.t - 1000);
  b.net.down = false;
  clock.t += 1000;
  await a.room.tick();
  assert.deepEqual([(await status()).status, (await status()).lastSeen], ['online', clock.t]);
  clock.t += 3500;
  assert.equal((await status()).status, 'offline', 'no answer for two intervals and the grace');
  assert.equal(timers.length, 2, 'each room registered one timer');
});
