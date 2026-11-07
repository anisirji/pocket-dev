import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chat } from '../chat/chat.js';

function chat(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return Chat.create({ tool: 'claude', cwd: dir, settings: {} }, dir);
}
const files = (...names) => names.map((n) => ({ path: `/tmp/${n}`, size: 1 }));

test('queued messages appear in the chat as queued, in order, and count in the view', (t) => {
  const c = chat(t);
  c.enqueue({ text: 'first', files: [] });
  c.enqueue({ text: 'second', files: files('a.png') });
  assert.equal(c.view().queued, 2);
  const shown = c.events.filter((e) => e.type === 'user-text');
  assert.deepEqual(shown.map((e) => [e.text, e.queued]), [['first', true], ['second', true]]);
  assert.deepEqual(shown[1].attachments, ['/tmp/a.png']);
});

test('dequeue hands back the oldest and re-posts it at the end of the conversation', (t) => {
  const c = chat(t);
  const first = c.enqueue({ text: 'first', files: [] });
  c.enqueue({ text: 'second', files: [] });
  assert.equal(c.dequeue().text, 'first');
  assert.deepEqual([c.find(first.id).queued, c.find(first.id).removed], [false, true], 'the waiting bubble is hidden');
  const last = c.events.at(-1);
  assert.deepEqual([last.type, last.text, last.queued], ['user-text', 'first', undefined], 'and sent again where it went out');
  assert.equal(c.view().queued, 1);
  assert.equal(c.dequeue().text, 'second');
  assert.equal(c.dequeue(), null);
});

test('a queued message can be removed before it is sent, and only while it waits', (t) => {
  const c = chat(t);
  const a = c.enqueue({ text: 'a', files: [] });
  const b = c.enqueue({ text: 'b', files: [] });
  assert.equal(c.unqueue(a.id), true);
  assert.deepEqual([c.find(a.id).queued, c.find(a.id).removed], [false, true]);
  assert.equal(c.unqueue(a.id), false, 'already gone');
  assert.equal(c.unqueue('nope'), false);
  assert.equal(c.dequeue().text, 'b');
  assert.equal(c.unqueue(b.id), false, 'already sent');
});

test('after a failure the rest are held, marked not sent, and never auto-sent', (t) => {
  const c = chat(t);
  const a = c.enqueue({ text: 'a', files: [] });
  c.enqueue({ text: 'b', files: [] });
  c.holdQueue();
  assert.equal(c.view().queued, 0);
  assert.equal(c.find(a.id).notSent, true);
  assert.equal(c.dequeue(), null);
});

test('the end of a turn tells the queue which way it ended', (t) => {
  const c = chat(t);
  const seen = [];
  c.afterTurn = (status) => seen.push(status);
  c.startTurn();
  c.endTurn({ status: 'done', durationMs: 1 });
  c.startTurn();
  c.turn.interrupted = true;
  c.endTurn({ status: 'done', durationMs: 1 });
  c.startTurn();
  c.endTurn({ status: 'failed', durationMs: 1 });
  assert.deepEqual(seen, ['done', 'done', 'failed']);
});

test('a message still queued when the server stopped is shown as not sent after reload', (t) => {
  const c = chat(t);
  c.enqueue({ text: 'waiting', files: [] });
  c.persist();
  fs.writeFileSync(c.file, JSON.stringify({ ...JSON.parse(fs.readFileSync(c.file, 'utf8')) }));
  const loaded = Chat.load(c.file);
  const ev = loaded.events.find((e) => e.type === 'user-text');
  assert.deepEqual([ev.queued, ev.notSent], [false, true]);
  assert.equal(loaded.view().queued, 0);
});

test('removing a chat deletes its saved images too', (t) => {
  const c = chat(t);
  fs.mkdirSync(c.imageDir, { recursive: true });
  fs.writeFileSync(path.join(c.imageDir, 'x.png'), 'x');
  c.persist();
  c.remove();
  assert.ok(!fs.existsSync(c.imageDir));
  assert.ok(!fs.existsSync(c.file));
});
