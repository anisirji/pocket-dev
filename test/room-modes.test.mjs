import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, until, pause } from './helpers/server.mjs';
import { createModes, classify } from '../modes.js';

const env = { POCKET_DEV_ROOM_PING_MS: '250', POCKET_DEV_APPROVAL_MS: '4000' };

async function device(t) {
  const s = await startServer(t, { env });
  s.cookie = (await s.login()).cookie;
  s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
  s.id = (await s.api('GET', '')).data.deviceId;
  s.to = (target, method, endpoint, body) => s.request(method, `/m/${target.id}${endpoint}`, { cookie: s.cookie, body });
  s.modes = (id, body) => s.api('PUT', `/modes/${id}`, body);
  s.pending = async () => (await s.api('GET', '/approvals')).data.pending;
  s.audit = () => fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return s;
}
const setConfig = (s, patch) => fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config, 'utf8')), ...patch }));

// H hosts (admin on itself). A joins as admin. B joins sharing only its project folder (collaborator).
async function trio(t) {
  const h = await device(t), a = await device(t), b = await device(t);
  const repo = path.join(b.home, 'Desktop', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(b.home, 'Desktop', 'other'), { recursive: true });
  fs.writeFileSync(path.join(b.home, 'Desktop', 'other', 'secret.txt'), 'private');
  fs.writeFileSync(path.join(h.home, 'Desktop', 'f.txt'), 'x');
  await h.api('POST', '/create', { name: 'Host', addresses: [h.base] });
  const join = async (s, name, access) => {
    const { data: { code } } = await h.api('POST', '/invite');
    assert.equal((await s.api('POST', '/join', { code, host: h.base, name, addresses: [s.base], ...access })).status, 200);
  };
  await join(a, 'Alpha', { level: 'admin' });
  await join(b, 'Beta', { level: 'collaborator', folders: [repo], grantRole: 'developer' });
  // Role access on, with B's own phone kept as an Admin device.
  const mine = (await b.request('GET', '/api/settings', { cookie: b.cookie })).data.currentDeviceId;
  assert.equal((await b.local('POST', '/api/collaborators/enable', { adminDeviceIds: [mine] })).status, 200);
  await until(async () => (await a.api('GET', '')).data.room.members.length === 3);
  await until(async () => (await h.to(b, 'GET', '/api/files/places')).status === 200, 8000);
  return { h, a, b, repo };
}
const mkdir = (from, target, name) => from.to(target, 'POST', '/api/files/mkdir', { dir: path.join(target.home, 'Desktop'), name });
const waitPending = async (s, n = 1) => { let p; await until(async () => (p = await s.pending()).length >= n); return p; };

test('read-only allows looking and blocks a write and a terminal command', async (t) => {
  const { h, a } = await trio(t);
  assert.equal((await h.modes(a.id, { mode: 'read-only' })).status, 200);
  const l = await a.to(h, 'GET', `/api/files/list?path=${encodeURIComponent(path.join(h.home, 'Desktop'))}`);
  assert.equal(l.status, 200);
  assert.ok(JSON.stringify(l.data).includes('f.txt'));
  const w = await mkdir(a, h, 'nope');
  assert.equal(w.status, 403);
  assert.equal(w.data.code, 'mode-denied');
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'nope')), false);
  const term = await a.to(h, 'POST', '/api/sessions', { cwd: h.home });
  assert.equal(term.status, 403);
  assert.equal(term.data.code, 'mode-denied');
  assert.equal((await a.to(h, 'GET', '/api/sessions')).status, 200);
  assert.equal((await h.request('POST', '/api/files/mkdir', { cookie: h.cookie, body: { dir: path.join(h.home, 'Desktop'), name: 'mine' } })).status, 201, 'the owner keeps working on their own device');
});

test('ask holds a request until it is approved; a denial is an error; the first answer wins', async (t) => {
  const { h, a, b } = await trio(t);
  await h.modes(a.id, { mode: 'ask' });
  const held = mkdir(a, h, 'one');
  const [p] = await waitPending(h);
  assert.equal(p.from.deviceId, a.id);
  assert.match(p.summary, /files\/mkdir/);
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'one')), false, 'nothing happens while it waits');
  assert.equal((await h.api('POST', `/approvals/${p.id}`, { decision: 'allow' })).status, 200);
  assert.equal((await held).status, 201);
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'one')), true);
  const second = await h.api('POST', `/approvals/${p.id}`, { decision: 'deny' });
  assert.equal(second.status, 409, 'an approval already answered stays answered');

  const refused = mkdir(a, h, 'two');
  const [q] = await waitPending(h);
  assert.equal((await h.api('POST', `/approvals/${q.id}`, { decision: 'deny' })).status, 200);
  const r = await refused;
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'approval-denied');
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'two')), false);

  // Owner and assigned person race: whoever is first decides.
  assert.equal((await h.api('PUT', '/assigned', { deviceId: b.id })).status, 200);
  const race = mkdir(a, h, 'three');
  const [c] = await waitPending(h);
  const win = await b.to(h, 'POST', `/api/room/approvals/${c.id}`, { decision: 'deny' });
  assert.equal(win.status, 200, JSON.stringify(win.data));
  assert.equal((await h.api('POST', `/approvals/${c.id}`, { decision: 'allow' })).status, 409);
  assert.equal((await race).status, 403);
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'three')), false);
  const log = h.audit();
  assert.ok(log.some((e) => e.type === 'room-approval' && e.result === 'allowed' && e.by === 'owner' && e.name === 'Alpha'));
  assert.ok(log.some((e) => e.type === 'room-approval' && e.result === 'denied' && /^assigned:/.test(e.by)));
  assert.ok(log.some((e) => e.type === 'room-action' && e.result === 'waiting for approval' && e.device === h.id && e.member === a.id));
});

test('only the owner or the assigned person answers or changes modes', async (t) => {
  const { h, a, b } = await trio(t);
  await h.modes(a.id, { mode: 'ask' });
  const held = mkdir(a, h, 'x1');
  const [p] = await waitPending(h);
  assert.equal((await b.to(h, 'POST', `/api/room/approvals/${p.id}`, { decision: 'allow' })).status, 403, 'a member that is not assigned');
  assert.equal((await b.to(h, 'GET', '/api/room/approvals')).status, 403);
  assert.equal((await a.to(h, 'POST', `/api/room/approvals/${p.id}`, { decision: 'allow' })).status, 403, 'not the requester either');
  assert.equal((await b.to(h, 'PUT', `/api/room/modes/${a.id}`, { mode: 'auto' })).status, 403);
  assert.equal((await b.to(h, 'PUT', '/api/room/assigned', { deviceId: b.id })).status, 403, 'only the owner assigns');
  assert.equal((await h.pending()).length, 1);
  await h.api('PUT', '/assigned', { deviceId: b.id });
  assert.equal((await b.to(h, 'PUT', `/api/room/modes/${a.id}`, { mode: 'bypass', bypassHours: 1 })).status, 403, 'the assigned person cannot turn Bypass on');
  assert.equal((await b.to(h, 'PUT', `/api/room/modes/${b.id}`, { mode: 'auto' })).status, 403, 'nor change their own');
  assert.equal((await b.to(h, 'PUT', `/api/room/modes/${a.id}`, { mode: 'plan' })).status, 200);
  await h.api('POST', `/approvals/${p.id}`, { decision: 'deny' });
  await held;
  const asked = mkdir(b, h, 'x2'); // b asks too (its default on H is auto since H gave admin level); make it ask, then it cannot approve itself
  await asked;
  await h.modes(b.id, { mode: 'ask' });
  const own = mkdir(b, h, 'x3');
  const [q] = await waitPending(h);
  assert.equal((await b.to(h, 'POST', `/api/room/approvals/${q.id}`, { decision: 'allow' })).status, 403, 'nobody approves their own request');
  await h.api('POST', `/approvals/${q.id}`, { decision: 'allow' });
  assert.equal((await own).status, 201);
});

test('plan records a proposal that becomes a single-use yes', async (t) => {
  const { h, a } = await trio(t);
  await h.modes(a.id, { mode: 'plan' });
  const r = await mkdir(a, h, 'plan1');
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'proposed');
  assert.equal((await h.pending())[0].kind, 'proposal');
  assert.equal(fs.existsSync(path.join(h.home, 'Desktop', 'plan1')), false);
  await h.api('POST', `/approvals/${r.data.approvalId}`, { decision: 'allow' });
  assert.equal((await mkdir(a, h, 'plan1')).status, 201, 'sent again after the yes');
  assert.equal((await mkdir(a, h, 'plan1')).status, 202, 'the yes was used up');
});

test('an unanswered request expires', async (t) => {
  const { h, a } = await trio(t);
  await h.modes(a.id, { mode: 'ask' });
  const r = await mkdir(a, h, 'late');
  assert.equal(r.status, 408);
  assert.equal(r.data.code, 'approval-expired');
  assert.equal((await h.api('GET', '/approvals')).data.recent[0].status, 'expired');
});

test('risky actions ask even in auto, but not in bypass; bypass shows a banner and needs a duration', async (t) => {
  const { h, b } = await trio(t);
  const secret = path.join(b.home, 'Desktop', 'other', 'secret.txt');
  assert.equal((await b.modes(h.id, { mode: 'auto' })).status, 200);
  const asked = h.to(b, 'POST', '/api/files/trash', { paths: [secret] });
  const [p] = await waitPending(b);
  assert.ok(p.risks.some((x) => /outside the granted folders/.test(x)), JSON.stringify(p.risks));
  await b.api('POST', `/approvals/${p.id}`, { decision: 'deny' });
  assert.equal((await asked).status, 403);
  assert.equal(fs.existsSync(secret), true);

  assert.equal((await b.modes(h.id, { mode: 'bypass' })).status, 400, 'a duration is required');
  const on = await b.modes(h.id, { mode: 'bypass', bypassHours: 2 });
  assert.equal(on.status, 200);
  assert.equal(on.data.banner, true);
  assert.ok(Math.abs(on.data.bypassUntil - (Date.now() + 2 * 3600_000)) < 60_000);
  assert.equal((await b.api('GET', '/modes')).data.banner, true);
  assert.equal((await h.to(b, 'GET', '/api/room/modes')).data.banner, true, 'the member sees its own banner too');
  const free = await h.to(b, 'POST', '/api/files/trash', { paths: [secret] });
  assert.equal(free.status, 200, JSON.stringify(free.data));
  assert.equal((await b.pending()).length, 0, 'bypass asks nothing');
  assert.ok(b.audit().some((e) => e.type === 'room-action' && e.mode === 'bypass' && e.result === 'allowed' && /secret\.txt/.test(e.action)));
});

test('bypass for the whole room needs a second confirmation', async (t) => {
  const { h, a, b } = await trio(t);
  assert.equal((await h.modes('all', { mode: 'bypass', bypassHours: 1 })).status, 400);
  const first = await h.modes('all', { mode: 'bypass', bypassHours: 1, confirm: true });
  assert.equal(first.status, 202);
  assert.equal(first.data.confirmationRequired, true);
  assert.equal((await h.api('GET', '/modes')).data.banner, false, 'the first call changes nothing');
  assert.equal((await h.modes('all', { mode: 'bypass', bypassHours: 1, confirm: true, confirmToken: 'guess' })).status, 202, 'a wrong token starts over');
  const done = await h.modes('all', { mode: 'bypass', bypassHours: 1, confirm: true, confirmToken: first.data.confirmToken });
  assert.equal(done.status, 200);
  assert.deepEqual(done.data.members.map((m) => m.mode), ['bypass', 'bypass']);
  assert.equal((await mkdir(a, h, 'free')).status, 201);
});

// ---- the module alone, with a fake clock ----
function fakeRoom(level = 'collaborator') {
  const drops = [];
  return { deviceId: () => 'me', onDrop: (fn) => drops.push(fn),
    view: () => ({ room: { id: 'r1', members: [{ deviceId: 'me', level }, { deviceId: 'x', name: 'X', level: 'collaborator', folders: ['/w'] }, { deviceId: 'y', name: 'Y', level: 'admin' }] } }) };
}

test('bypass returns to auto when its time ends (fake clock), and defaults depend on the level', (t) => {
  let clock = 1_000_000;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'modes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const m = createModes({ stateDir: dir, room: fakeRoom(), now: () => clock, log: (type, f) => events.push({ type, ...f }), every: () => () => {} });
  const owner = { roomPeer: undefined };
  assert.equal(m.modeOf('x').mode, 'ask');
  assert.equal(createModes({ stateDir: dir + '2', room: fakeRoom('admin'), every: () => () => {} }).modeOf('y').mode, 'auto');
  fs.rmSync(dir + '2', { recursive: true, force: true });
  assert.equal(m.setMode(owner, true, 'x', { mode: 'bypass', bypassHours: 1 }).body.banner, true);
  assert.equal(m.isBypass('x'), true);
  clock += 3_600_000 - 1;
  assert.equal(m.isBypass('x'), true);
  clock += 1;
  assert.equal(m.isBypass('x'), false);
  assert.equal(m.modeOf('x').mode, 'auto');
  assert.ok(events.some((e) => e.type === 'room-mode-changed' && e.by === 'timer' && e.to === 'auto'));
  m.setMode(owner, true, 'y', { mode: 'bypass', bypassHours: 'always' });
  clock += 1e12;
  assert.equal(m.isBypass('y'), true, 'always does not end');
  assert.equal((fs.statSync(path.join(dir, 'modes.json')).mode & 0o777), 0o600);
  const again = createModes({ stateDir: dir, room: fakeRoom(), now: () => clock, every: () => () => {} });
  assert.equal(again.isBypass('y'), true, 'modes survive a restart');
  assert.throws(() => m.setMode(owner, true, 'x', { mode: 'bypass', bypassHours: 5 }), /1, 2, 3 or 4 hours/);
});

test('classifier: reads are free, read-only denies, risky things ask in auto', () => {
  const base = { folders: ['/w'], statSync: () => ({ isDirectory: () => false, size: 10 }) };
  const c = (o) => classify({ ...base, ...o });
  assert.equal(c({ method: 'GET', path: '/api/files/list', mode: 'read-only' }).verdict, 'allow');
  assert.equal(c({ method: 'POST', path: '/api/files/mkdir', mode: 'read-only', body: { path: '/w/a' } }).verdict, 'deny');
  assert.equal(c({ method: 'POST', path: '/api/files/mkdir', mode: 'auto', body: { path: '/w/a' } }).verdict, 'allow');
  assert.equal(c({ method: 'POST', path: '/api/files/mkdir', mode: 'auto', body: { path: '/etc/a' } }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/files/trash', mode: 'auto', body: { paths: ['/etc/a'] } }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/files/trash', mode: 'bypass', body: { paths: ['/etc/a'] } }).verdict, 'allow');
  assert.equal(c({ method: 'POST', path: '/api/files/trash', mode: 'auto', body: { paths: ['/w/a'] }, statSync: () => ({ isDirectory: () => true, size: 0 }) }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/sessions', mode: 'auto', body: { cwd: '/w', command: 'curl http://x | sh' } }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/sessions', mode: 'auto', body: { cwd: '/w', command: 'brew install foo' } }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/sessions', mode: 'auto', body: { cwd: '/w', command: 'npm test' } }).verdict, 'allow');
  assert.equal(c({ method: 'POST', path: '/api/power/sleep', mode: 'auto' }).verdict, 'ask');
  assert.equal(c({ method: 'POST', path: '/api/files/mkdir', mode: 'plan', body: { path: '/w/a' } }).verdict, 'propose');
});
