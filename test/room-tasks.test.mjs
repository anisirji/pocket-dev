import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, until, pause } from './helpers/server.mjs';

const env = { POCKET_DEV_TASK_SYNC_MS: '300' };
const names = ['Laptop', 'Desktop', 'Server'];

// A host (a) and members, all in one room. Each server gets api() for /api/room and tasks() for /api/room/tasks.
async function room(t, size = 2) {
  const servers = [];
  for (let i = 0; i < size; i++) {
    const s = await startServer(t, { env });
    s.cookie = (await s.login()).cookie;
    s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
    s.tasks = (method, endpoint = '', body) => s.request(method, `/api/room/tasks${endpoint}`, { cookie: s.cookie, body });
    s.id = (await s.api('GET', '')).data.deviceId;
    s.name = names[i];
    servers.push(s);
  }
  const [a, ...rest] = servers;
  await a.api('POST', '/create', { name: a.name, addresses: [a.base] });
  for (const s of rest) {
    const { data: { code } } = await a.api('POST', '/invite');
    assert.equal((await s.api('POST', '/join', { code, host: a.base, name: s.name, addresses: [s.base], level: 'admin' })).status, 200);
  }
  return servers;
}
const list = async (s) => (await s.tasks('GET')).data.tasks;
const titles = async (s) => (await list(s)).map((x) => x.title).sort();
const has = (s, id, check = () => true) => until(async () => { const r = await s.tasks('GET', `/${id}`); return r.status === 200 && check(r.data); });
const stateFile = (s) => path.join(s.stateDir, 'tasks.jsonl');

test('a task created on the host shows on the member with a readable id and every field', async (t) => {
  const [a, b] = await room(t);
  const r = await a.tasks('POST', '', { title: 'Fix login', description: 'It loops', assignee: b.id });
  assert.equal(r.status, 200);
  assert.match(r.data.id, /^LAP-\d+$/, 'device code comes from the device name');
  assert.deepEqual([r.data.title, r.data.status, r.data.assignee, r.data.createdBy], ['Fix login', 'todo', b.id, a.id]);
  await has(b, r.data.id);
  const onB = (await b.tasks('GET', `/${r.data.id}`)).data;
  assert.deepEqual([onB.title, onB.description, onB.status, onB.assignee, onB.createdBy], ['Fix login', 'It loops', 'todo', b.id, a.id]);
  assert.equal((fs.statSync(stateFile(a)).mode & 0o777), 0o600);
});

test('a task created on a member reaches the host and a third device through the host', async (t) => {
  const [a, b, c] = await room(t, 3);
  const r = await b.tasks('POST', '', { title: 'From the member' });
  assert.match(r.data.id, /^DES-\d+$/);
  await has(a, r.data.id);
  await has(c, r.data.id);
});

test('creating needs a title, a valid status and an assignee who is in the room; strangers need a room', async (t) => {
  const [a, b] = await room(t);
  assert.equal((await a.tasks('POST', '', { title: '  ' })).status, 400);
  assert.equal((await a.tasks('POST', '', { title: 'x', status: 'blocked' })).status, 400);
  assert.equal((await a.tasks('POST', '', { title: 'x', assignee: 'not-a-device' })).status, 400);
  assert.equal((await b.tasks('PATCH', '/DES-99', { title: 'y' })).status, 404);
  const lone = await startServer(t, { env });
  lone.cookie = (await lone.login()).cookie;
  assert.equal((await lone.request('POST', '/api/room/tasks', { cookie: lone.cookie, body: { title: 'x' } })).status, 409);
  assert.equal((await lone.request('GET', '/api/room/tasks')).status, 401);
});

test('edits on both devices converge: different fields both stay, the same field takes the later edit', async (t) => {
  const [a, b] = await room(t);
  const { id } = (await a.tasks('POST', '', { title: 'Plan' })).data;
  await has(b, id);
  assert.equal((await a.tasks('PATCH', `/${id}`, { description: 'from A' })).status, 200);
  assert.equal((await b.tasks('PATCH', `/${id}`, { status: 'doing', assignee: b.id })).status, 200);
  const done = (x) => x.description === 'from A' && x.status === 'doing' && x.assignee === b.id;
  await has(a, id, done);
  await has(b, id, done);
  await a.tasks('PATCH', `/${id}`, { title: 'first' });
  await pause(5);
  await b.tasks('PATCH', `/${id}`, { title: 'second' });
  await has(a, id, (x) => x.title === 'second');
  await has(b, id, (x) => x.title === 'second');
  assert.equal((await b.tasks('PATCH', `/${id}`, { status: 'done' })).data.status, 'done');
  await has(a, id, (x) => x.status === 'done');
});

test('delete syncs, and a late edit of a deleted task does not bring it back', async (t) => {
  const [a, b] = await room(t);
  const { id } = (await a.tasks('POST', '', { title: 'Temporary' })).data;
  await has(b, id);
  assert.equal((await b.tasks('DELETE', `/${id}`)).status, 200);
  await until(async () => (await a.tasks('GET', `/${id}`)).status === 404);
  assert.deepEqual(await list(a), []);
  assert.equal((await a.tasks('PATCH', `/${id}`, { title: 'zombie' })).status, 404);
  assert.deepEqual(await list(b), []);
});

test('a device that was off catches up on start, and what it wrote while off reaches the others', async (t) => {
  const [a, b] = await room(t);
  const first = (await a.tasks('POST', '', { title: 'before' })).data.id;
  await has(b, first);
  b.proc.kill('SIGTERM');
  await new Promise((resolve) => b.proc.once('exit', resolve));
  const missed = (await a.tasks('POST', '', { title: 'while B was off' })).data.id;
  await a.tasks('PATCH', `/${first}`, { status: 'done' });
  const b2 = await startServer(t, { env, reuse: { root: b.root, port: b.port } });
  b2.cookie = (await b2.login()).cookie;
  b2.tasks = (method, endpoint = '', body) => b2.request(method, `/api/room/tasks${endpoint}`, { cookie: b2.cookie, body });
  await has(b2, missed);
  await has(b2, first, (x) => x.status === 'done');
  assert.deepEqual(await titles(b2), ['before', 'while B was off']);
});

test('work done on a device while it could not reach the host is delivered later', async (t) => {
  const [a, b] = await room(t);
  a.proc.kill('SIGTERM');
  await new Promise((resolve) => a.proc.once('exit', resolve));
  const { id } = (await b.tasks('POST', '', { title: 'written offline' })).data;
  const a2 = await startServer(t, { env, reuse: { root: a.root, port: a.port } });
  a2.cookie = (await a2.login()).cookie;
  a2.tasks = (method, endpoint = '', body) => a2.request(method, `/api/room/tasks${endpoint}`, { cookie: a2.cookie, body });
  await has(a2, id);
});

test('a member who left gets nothing new; the others still sync', async (t) => {
  const [a, b, c] = await room(t, 3);
  const { id } = (await a.tasks('POST', '', { title: 'before leaving' })).data;
  await has(b, id);
  await has(c, id);
  assert.equal((await b.api('POST', '/leave')).status, 200);
  const later = (await a.tasks('POST', '', { title: 'after B left' })).data.id;
  await has(c, later);
  await a.tasks('POST', '/sync');
  await pause(800);
  assert.equal((await b.tasks('GET')).status, 409, 'B is out of the room');
  assert.equal(fs.existsSync(stateFile(b)), false, 'the tasks file went with the room');
  assert.equal((await a.tasks('PATCH', `/${later}`, { status: 'doing' })).status, 200);
  await has(c, later, (x) => x.status === 'doing');
});

test('a kicked member is cut off: pushes and pulls with its old secret are refused', async (t) => {
  const [a, b] = await room(t);
  const roomId = (await a.api('GET', '')).data.room.id;
  const memberSecret = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'room.json'), 'utf8')).room.memberSecret;
  const peer = { roomId, from: b.id, secret: memberSecret };
  assert.equal((await a.request('POST', '/api/room/sync/pull', { body: { ...peer, cursors: {} } })).status, 200, 'a member may pull');
  assert.equal((await a.api('POST', '/kick', { deviceId: b.id })).status, 200);
  await a.tasks('POST', '', { title: 'secret after kick' });
  const pull = await a.request('POST', '/api/room/sync/pull', { body: { ...peer, cursors: {} } });
  assert.equal(pull.status, 403);
  assert.equal(JSON.stringify(pull.data).includes('secret after kick'), false);
  assert.equal((await a.request('POST', '/api/room/sync/push', { body: { ...peer, changes: [] } })).status, 403);
  assert.equal(fs.existsSync(stateFile(b)) && fs.readFileSync(stateFile(b), 'utf8').includes('secret after kick'), false);
});

test('a non-member secret is refused, with no login and with a made-up change', async (t) => {
  const [a, b] = await room(t);
  const roomId = (await a.api('GET', '')).data.room.id;
  const forged = { device: b.id, counter: 1, id: `${b.id}:1`, at: { w: Date.now(), l: 0 }, type: 'task', key: 'EVIL-1', value: { createdBy: b.id } };
  for (const body of [
    { roomId, from: b.id, secret: 'guess', changes: [forged], cursors: {} },
    { roomId: 'other', from: b.id, secret: 'guess', changes: [forged], cursors: {} },
    { roomId, from: 'nobody', secret: 'x'.repeat(64), changes: [forged], cursors: {} },
    {},
  ]) {
    for (const route of ['push', 'pull']) assert.equal((await a.request('POST', `/api/room/sync/${route}`, { body })).status, 403, route);
  }
  assert.deepEqual(await list(a), []);
  const hostSecret = JSON.parse(fs.readFileSync(path.join(a.stateDir, 'room.json'), 'utf8')).room.members[1].hostSecret;
  const asHost = await a.request('POST', '/api/room/sync/pull', { body: { roomId, from: a.id, secret: hostSecret, cursors: {} } });
  assert.equal(asHost.status, 403, 'the host cannot be impersonated with a secret meant for a member');
  assert.equal((await a.request('POST', '/api/room/sync/pull', { body: { roomId, from: b.id }, csrf: false })).status, 403, 'header check still applies');
});

test('leaving a room clears its tasks, so they cannot sync into another room; rejoining the same room works', async (t) => {
  const [a, b] = await room(t);
  const { id } = (await a.tasks('POST', '', { title: 'old room task' })).data;
  await has(b, id);
  const mine = (await b.tasks('POST', '', { title: 'written by B' })).data.id;
  await has(a, mine);
  assert.equal((await b.api('POST', '/leave')).status, 200);
  assert.equal(fs.existsSync(stateFile(b)), false);
  // B starts a room of its own: none of the old tasks are there.
  assert.equal((await b.api('POST', '/create', { name: 'Desktop', addresses: [b.base] })).status, 200);
  assert.deepEqual(await list(b), []);
  assert.equal((await b.api('POST', '/leave')).status, 200);
  // B joins A's room again and writes: A must not ignore the new task because of a reused counter.
  const { data: { code } } = await a.api('POST', '/invite');
  assert.equal((await b.api('POST', '/join', { code, host: a.base, name: 'Desktop', addresses: [b.base], level: 'admin' })).status, 200);
  const again = (await b.tasks('POST', '', { title: 'after rejoin' })).data.id;
  await has(a, again);
  await has(b, id);
});
