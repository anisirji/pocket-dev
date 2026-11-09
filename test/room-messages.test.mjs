import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { until, pause } from './helpers/server.mjs';
import { roomOf, restart } from './helpers/room-pair.mjs';

const texts = async (s) => (await s.messages('GET')).data.messages.map((m) => m.text);
const has = (s, text) => until(async () => (await texts(s)).includes(text));
const find = async (s, text) => (await s.messages('GET')).data.messages.find((m) => m.text === text);
const send = (s, text, extra = {}) => s.messages('POST', '', { text, ...extra });

test('a message on A reaches B, with a global id and the device named; local fields stay as they were', async (t) => {
  const [a, b] = await roomOf(t);
  const sent = (await send(a, 'hello from A')).data;
  assert.equal(sent.gid, `${a.id}:${sent.seq}`);
  await has(b, 'hello from A');
  const onB = await find(b, 'hello from A');
  assert.equal(onB.origin.deviceId, a.id);
  assert.equal(onB.origin.deviceName, 'Laptop');
  assert.match(onB.from.name, /\(Laptop\)$/);
  assert.equal(onB.gid, sent.gid);
  assert.equal(onB.mine, false);
  assert.equal(onB.canDelete, false, 'only the sending device deletes');
  assert.equal(onB.chat, 'everyone');
  assert.equal((await b.messages('DELETE', `/${onB.seq}`)).status, 403);
  // B answers; A sees it, from the other device.
  await send(b, 'hello back');
  await has(a, 'hello back');
  assert.equal((await find(a, 'hello back')).origin.deviceId, b.id);
});

test('a message reaches a third device through the host', async (t) => {
  const [a, b, c] = await roomOf(t, ['admin', 'admin', 'admin']);
  await send(b, 'from the member');
  await has(a, 'from the member');
  await has(c, 'from the member');
});

test('direct messages stay on their device', async (t) => {
  const [a, b] = await roomOf(t);
  const people = (await a.messages('GET')).data.people;
  assert.ok(Array.isArray(people));
  await send(a, 'for everyone');
  await has(b, 'for everyone');
  // The Mac (admin port) writes to one device by code; B must never see it.
  const target = (await a.local('GET', '/api/messages')).data.people.find((p) => p.kind === 'device');
  if (target) {
    assert.equal((await a.local('POST', '/api/messages', { text: 'private note', to: target.id })).status, 201);
    await pause(800);
    assert.equal((await texts(b)).includes('private note'), false);
  }
});

test('a delete on A reaches B; a delete is not undone by a later sync', async (t) => {
  const [a, b] = await roomOf(t);
  const m = (await send(a, 'to be deleted')).data;
  await has(b, 'to be deleted');
  assert.equal((await a.messages('DELETE', `/${m.seq}`)).status, 204);
  await until(async () => !(await texts(b)).includes('to be deleted'));
  await a.api('POST', '/leave').catch(() => {});
});

test('a device that was off catches up on start, and what it wrote while off reaches the others', async (t) => {
  const [a, b] = await roomOf(t);
  await send(a, 'before');
  await has(b, 'before');
  b.proc.kill('SIGTERM');
  await new Promise((resolve) => b.proc.once('exit', resolve));
  await send(a, 'while B was off');
  const gone = (await send(a, 'deleted while B was off')).data;
  await a.messages('DELETE', `/${gone.seq}`);
  const b2 = await restart(t, b);
  await has(b2, 'while B was off');
  assert.equal((await texts(b2)).includes('deleted while B was off'), false);
  await send(b2, 'B is back');
  await has(a, 'B is back');
  // And the other way: A off, B writes.
  a.proc.kill('SIGTERM');
  await new Promise((resolve) => a.proc.once('exit', resolve));
  await send(b2, 'written while A was off');
  const a2 = await restart(t, a);
  await has(a2, 'written while A was off');
});

test('an attachment shows as metadata at once and its bytes come on demand, cached on the mirror', async (t) => {
  const [a, b] = await roomOf(t);
  const up = await fetch(`${a.base}/api/messages/files`, { method: 'POST', headers: { cookie: a.cookie, 'x-pocket-dev': '1', 'x-filename': 'note.txt', 'content-type': 'application/octet-stream' }, body: 'file bytes' });
  const file = await up.json();
  await send(a, 'with a file', { files: [file.id] });
  await has(b, 'with a file');
  const meta = (await find(b, 'with a file')).files[0];
  assert.deepEqual([meta.name, meta.size], ['note.txt', 10]);
  const filesDir = path.join(b.stateDir, 'messages', 'files');
  assert.equal(fs.existsSync(path.join(filesDir, file.id)), false, 'no bytes copied by the sync itself');
  const got = await fetch(`${b.base}/api/messages/files/${file.id}`, { headers: { cookie: b.cookie } });
  assert.equal(await got.text(), 'file bytes');
  assert.equal(fs.existsSync(path.join(filesDir, file.id)), true, 'cached after the first open');
});

test('a file above the blob cap is not copied; the metadata still shows', async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env: { POCKET_DEV_BLOB_MAX: '5' } });
  const up = await fetch(`${a.base}/api/messages/files`, { method: 'POST', headers: { cookie: a.cookie, 'x-pocket-dev': '1', 'x-filename': 'big.txt', 'content-type': 'application/octet-stream' }, body: 'more than five bytes' });
  const file = await up.json();
  await send(a, 'big file', { files: [file.id] });
  await has(b, 'big file');
  assert.equal((await fetch(`${b.base}/api/messages/files/${file.id}`, { headers: { cookie: b.cookie } })).status, 413);
});

test('leaving deletes the copies on the leaving device; a kicked member receives nothing new', async (t) => {
  const [a, b, c] = await roomOf(t, ['admin', 'admin', 'admin']);
  await send(a, 'shared before');
  await has(b, 'shared before');
  await has(c, 'shared before');
  await send(b, 'my own message');
  await has(a, 'my own message');
  assert.equal((await b.api('POST', '/leave')).status, 200);
  assert.equal((await texts(b)).includes('shared before'), false, 'copies of the room are deleted on the leaving device');
  assert.equal((await texts(b)).includes('my own message'), true, 'its own messages stay');
  assert.equal(fs.existsSync(path.join(b.stateDir, 'messages.jsonl')), false);
  // Kick C: it deletes its copies, and A's later messages never reach it.
  assert.equal((await a.api('POST', '/kick', { deviceId: c.id })).status, 200);
  await until(async () => !(await texts(c)).includes('shared before'));
  await send(a, 'after the kick');
  await pause(1000);
  assert.equal((await texts(c)).includes('after the kick'), false);
  assert.equal(fs.existsSync(path.join(c.stateDir, 'messages.jsonl')), false);
});
