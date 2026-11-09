import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { until, pause } from './helpers/server.mjs';
import { roomOf, restart } from './helpers/room-pair.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.mjs');
const env = { POCKET_DEV_CLAUDE: FAKE_CLAUDE };
const mirrors = async (s) => (await s.roomChats('GET')).data.chats ?? [];
const finished = (s, id) => until(async () => (await s.chat('GET', `/${id}`)).data.status === 'idle' && (await s.chat('GET', `/${id}`)).data.events.some((e) => e.type === 'result'));
async function chatOn(s, text) {
  const id = (await s.chat('POST', '', { tool: 'claude', cwd: s.home })).data.id;
  assert.equal((await s.chat('POST', `/${id}/message`, { text })).status, 202);
  await finished(s, id);
  return id;
}
const mirrored = (s, deviceId, id, check = () => true) => until(async () => {
  const r = await s.roomChats('GET', `/${deviceId}/${id}`);
  return r.status === 200 && check(r.data);
});

test('a chat on A (admin level) appears on B read-only with its events; B cannot write to it', { timeout: 60000 }, async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env });
  const id = await chatOn(a, 'hello there');
  await mirrored(b, a.id, id, (c) => c.events.some((e) => e.type === 'result'));
  const list = await mirrors(b);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].deviceId, list[0].deviceName, list[0].chatId, list[0].readOnly], [a.id, 'Laptop', id, true]);
  const full = (await b.roomChats('GET', `/${a.id}/${id}`)).data;
  assert.deepEqual(full.events.filter((e) => e.type === 'user-text' || e.type === 'assistant-text').map((e) => e.text), ['hello there', 'first answer']);
  assert.equal(full.sessionId, undefined, 'the session id never leaves the owning device');
  assert.equal((await b.roomChats('POST', `/${a.id}/${id}`, {})).status, 405);
  assert.equal((await b.chat('GET', `/${id}`)).status, 404, 'it is not one of B\'s own chats and cannot be resumed there');
  assert.deepEqual(await mirrors(a), [], 'a device does not list its own chats as mirrors');
  // A later turn on A shows up on B (updates, not only new events).
  await a.chat('POST', `/${id}/message`, { text: 'one more' });
  await mirrored(b, a.id, id, (c) => c.events.filter((e) => e.type === 'result').length === 2);
});

test('a picture from a tool run is metadata at once; its bytes come on demand and are cached on the mirror', { timeout: 60000 }, async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env });
  const id = await chatOn(a, 'show me a picture');
  await mirrored(b, a.id, id, (c) => c.events.some((e) => e.images?.length));
  const ev = (await b.roomChats('GET', `/${a.id}/${id}`)).data.events.find((e) => e.images?.length);
  const [blobId, meta] = Object.entries(ev.blobs)[0];
  assert.match(blobId, /^img:/);
  assert.ok(meta.size > 0 && meta.sha256);
  const cache = path.join(b.stateDir, 'room-chat-blobs');
  assert.equal(fs.existsSync(cache), false, 'nothing fetched yet');
  const got = await fetch(`${b.base}/api/room/chats/${a.id}/${id}/blob/${encodeURIComponent(blobId)}`, { headers: { cookie: b.cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal((await got.arrayBuffer()).byteLength, meta.size);
  assert.deepEqual(fs.readdirSync(cache), [meta.sha256]);
  assert.equal((await fetch(`${b.base}/api/room/chats/${a.id}/${id}/blob/img%3Anope.png`, { headers: { cookie: b.cookie } })).status, 404);
});

test('a picture above the blob cap shows as too large and is not fetched', { timeout: 60000 }, async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env: { ...env, POCKET_DEV_BLOB_MAX: '10' } });
  const id = await chatOn(a, 'show me a picture');
  await mirrored(b, a.id, id, (c) => c.events.some((e) => e.images?.length));
  const ev = (await b.roomChats('GET', `/${a.id}/${id}`)).data.events.find((e) => e.images?.length);
  const [blobId, meta] = Object.entries(ev.blobs)[0];
  assert.equal(meta.tooLarge, true);
  assert.equal((await fetch(`${b.base}/api/room/chats/${a.id}/${id}/blob/${encodeURIComponent(blobId)}`, { headers: { cookie: b.cookie } })).status, 413);
});

test('a third device gets the chat and its picture through the host', { timeout: 60000 }, async (t) => {
  const [a, b, c] = await roomOf(t, ['admin', 'admin', 'admin'], { env });
  const id = await chatOn(b, 'show me a picture');
  await mirrored(a, b.id, id, (x) => x.events.some((e) => e.images?.length));
  await mirrored(c, b.id, id, (x) => x.events.some((e) => e.images?.length));
  const ev = (await c.roomChats('GET', `/${b.id}/${id}`)).data.events.find((e) => e.images?.length);
  const got = await fetch(`${c.base}/api/room/chats/${b.id}/${id}/blob/${encodeURIComponent(Object.keys(ev.blobs)[0])}`, { headers: { cookie: c.cookie } });
  assert.equal(got.status, 200, 'member to member goes through the host');
});

test('chats of a collaborator-level device are shared with nobody', { timeout: 60000 }, async (t) => {
  const [a, b, c] = await roomOf(t, ['admin', 'admin', 'collaborator'], { env });
  const secret = await chatOn(c, 'a private chat on the collaborator-level device');
  const open = await chatOn(a, 'a chat on the admin-level host');
  await mirrored(b, a.id, open);
  await mirrored(c, a.id, open);
  await pause(1500);
  assert.deepEqual((await mirrors(a)).map((x) => x.chatId), []);
  assert.deepEqual((await mirrors(b)).map((x) => x.chatId), [open]);
  assert.equal((await b.roomChats('GET', `/${c.id}/${secret}`)).status, 404);
  assert.equal(fs.existsSync(path.join(a.stateDir, 'chats.jsonl')) && fs.readFileSync(path.join(a.stateDir, 'chats.jsonl'), 'utf8').includes('private chat'), false);
  assert.equal(fs.readFileSync(path.join(b.stateDir, 'chats.jsonl'), 'utf8').includes('private chat'), false);
});

test('deleting a chat on A removes its mirror', { timeout: 60000 }, async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env });
  const id = await chatOn(a, 'to be deleted');
  await mirrored(b, a.id, id);
  assert.equal((await a.chat('DELETE', `/${id}`)).status, 204);
  await until(async () => (await mirrors(b)).length === 0);
});

test('a device that was off catches up on chats', { timeout: 90000 }, async (t) => {
  const [a, b] = await roomOf(t, ['admin', 'admin'], { env });
  b.proc.kill('SIGTERM');
  await new Promise((resolve) => b.proc.once('exit', resolve));
  const id = await chatOn(a, 'written while B was off');
  const b2 = await restart(t, b, env);
  await mirrored(b2, a.id, id, (c) => c.events.some((e) => e.type === 'result'));
  // Written on B while A is off, delivered when A is back.
  a.proc.kill('SIGTERM');
  await new Promise((resolve) => a.proc.once('exit', resolve));
  const own = await chatOn(b2, 'written while A was off');
  const a2 = await restart(t, a, env);
  await mirrored(a2, b.id, own, (c) => c.events.some((e) => e.type === 'result'));
});

test('leaving deletes the mirrored chats; a kicked member receives nothing new', { timeout: 90000 }, async (t) => {
  const [a, b, c] = await roomOf(t, ['admin', 'admin', 'admin'], { env });
  const first = await chatOn(a, 'before leaving');
  await mirrored(b, a.id, first);
  await mirrored(c, a.id, first);
  const mine = await chatOn(b, 'a chat of B');
  await mirrored(a, b.id, mine);
  assert.equal((await b.api('POST', '/leave')).status, 200);
  assert.equal(fs.existsSync(path.join(b.stateDir, 'chats.jsonl')), false, 'the mirrored data is deleted');
  assert.equal((await b.chat('GET', `/${mine}`)).status, 200, 'its own chat stays');
  assert.equal((await a.api('POST', '/kick', { deviceId: c.id })).status, 200);
  await until(async () => !fs.existsSync(path.join(c.stateDir, 'chats.jsonl')));
  const later = await chatOn(a, 'after the kick');
  await pause(1500);
  assert.equal(fs.existsSync(path.join(c.stateDir, 'chats.jsonl')) && fs.readFileSync(path.join(c.stateDir, 'chats.jsonl'), 'utf8').includes('after the kick'), false);
  assert.equal(fs.existsSync(path.join(b.stateDir, 'chats.jsonl')), false);
  assert.equal(later.length > 0, true);
});
