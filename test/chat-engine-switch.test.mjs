import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, pause } from './helpers/server.mjs';
import { Chat } from '../chat/chat.js';
import { buildTranscript, buildHandoff, wrapFirstMessage, HANDOFF_COMPACT_AT, HANDOFF_RECENT_CHARS, HANDOFF_MAX_CHARS } from '../chat/handoff.js';

const FAKE_AGY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-agy.mjs');

async function open(t) {
  const s = await startServer(t, { env: { POCKET_DEV_AGY: FAKE_AGY, POCKET_DEV_CODEX: FAKE_AGY } });
  const A = await s.login();
  const call = (method, url, body, cookie = A.cookie) => s.request(method, url, { cookie, body });
  const created = await call('POST', '/api/chat', { tool: 'antigravity', cwd: s.home });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const get = async () => (await call('GET', `/api/chat/${id}`)).data;
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const c = await get(); if (pred(c)) return c; await pause(40); }
    throw new Error(`timed out: ${JSON.stringify(await get())}`);
  };
  const say = async (text, count) => {
    assert.equal((await call('POST', `/api/chat/${id}/message`, { text })).status, 202);
    return until((x) => x.status === 'idle' && x.events.filter((e) => e.type === 'assistant-text').length >= count);
  };
  return { call, id, get, until, say };
}

test('every answer records the engine that wrote it', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  const chat = await c.say('hello', 1);
  assert.equal(chat.events.find((e) => e.type === 'assistant-text').tool, 'antigravity');
});

test('switching keeps the whole history, changes the engine and clears the old session', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  const before = await c.say('hello', 1);
  const res = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'codex' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.tool, 'codex');
  assert.equal(res.data.sessionId, null);
  const after = await c.get();
  assert.deepEqual(after.events.slice(0, before.events.length).map((e) => [e.id, e.text]), before.events.map((e) => [e.id, e.text]));
  assert.match(after.events.at(-1).text, /Switched from Antigravity to Codex/);
});

test('the next engine gets the earlier conversation with the first message, and only once', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.say('hello', 1);
  await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'codex' });
  assert.equal((await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' })).status, 200);
  const first = await c.say('echo-prompt one', 2);
  const got = first.events.filter((e) => e.type === 'assistant-text').at(-1).text;
  assert.match(got, /continued with Antigravity/);
  assert.match(got, /User: hello/);
  assert.match(got, /Assistant \(Antigravity\): Hello from agy/);
  assert.match(got, /echo-prompt one$/);
  assert.equal(first.events.find((e) => e.type === 'user-text' && /echo-prompt one/.test(e.text)).text, 'echo-prompt one', 'the chat shows the message as typed');
  const second = await c.say('echo-prompt two', 3);
  const again = second.events.filter((e) => e.type === 'assistant-text').at(-1).text;
  assert.doesNotMatch(again, /Earlier in this conversation/);
});

test('a switch is refused while a reply runs, and to the same engine or an unknown one', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'slow' });
  await c.until((x) => x.status === 'running');
  const busy = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'codex' });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /stop it/);
  await c.call('POST', `/api/chat/${c.id}/interrupt`);
  await c.until((x) => x.status !== 'running');
  assert.equal((await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' })).status, 400);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'gemini' })).status, 400);
});

test('only a logged-in device can switch the engine', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'codex' }, '')).status, 401);
});

test('the pending handoff and the tool labels survive a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chat = Chat.create({ tool: 'claude', cwd: dir, settings: {} }, dir);
  chat.emit({ type: 'user-text', text: 'question' });
  chat.emit({ type: 'assistant-text', text: 'answer' });
  chat.tool = 'codex';
  chat.handoffSeq = chat.seq;
  chat.handoffFrom = 'claude';
  chat.persist();
  const loaded = Chat.load(chat.file);
  assert.equal(loaded.tool, 'codex');
  assert.equal(loaded.handoffSeq, 2);
  assert.equal(loaded.handoffFrom, 'claude');
  assert.equal(loaded.events.find((e) => e.type === 'assistant-text').tool, 'claude');
});

test('the transcript keeps messages, answers, tool runs and edits, and leaves out thinking and unsent messages', () => {
  const events = [
    { seq: 1, type: 'user-text', text: 'fix the bug', attachments: ['/tmp/a.png'] },
    { seq: 2, type: 'thinking', text: 'secret thoughts' },
    { seq: 3, type: 'tool-run', name: 'Bash', summary: 'npm test' },
    { seq: 4, type: 'file-edit', path: 'src/a.js', diff: '+x' },
    { seq: 5, type: 'assistant-text', text: 'done', tool: 'claude' },
    { seq: 6, type: 'user-text', text: 'never sent', notSent: true },
    { seq: 7, type: 'user-text', text: 'after the switch' },
  ];
  const { text, dropped } = buildTranscript(events, 6, (tool) => ({ claude: 'Claude' })[tool]);
  assert.equal(dropped, 0);
  assert.match(text, /User: fix the bug\n\(attached: \/tmp\/a\.png\)/);
  assert.match(text, /\[Tool Bash: npm test\]/);
  assert.match(text, /\[Edited src\/a\.js\n\+x\]/);
  assert.match(text, /Assistant \(Claude\): done/);
  assert.doesNotMatch(text, /secret thoughts|never sent|after the switch/);
});

test('above the size cap the oldest items go first and the message says how many', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, type: 'user-text', text: `m${i}`.padEnd(100, 'x') }));
  const { text, dropped } = buildTranscript(events, 10, undefined, 350);
  assert.equal(dropped, 7);
  assert.match(text, /m9/);
  assert.doesNotMatch(text, /m0/);
  const wrapped = wrapFirstMessage({ transcript: text, dropped, from: 'Claude', to: 'Codex', message: 'next' });
  assert.match(wrapped, /7 oldest items are left out/);
  assert.match(wrapped, /next$/);
});

test('a switch to an engine that is not installed is refused and the chat stays as it was', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_AGY: FAKE_AGY, POCKET_DEV_CODEX: path.join(os.tmpdir(), 'pocket-dev-no-such-codex') } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const created = await call('POST', '/api/chat', { tool: 'antigravity', cwd: s.home });
  assert.equal(created.status, 201);
  const refused = await call('POST', `/api/chat/${created.data.id}/engine`, { tool: 'codex' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /not installed/);
  assert.equal((await call('GET', `/api/chat/${created.data.id}`)).data.tool, 'antigravity');
});

// Turn n: a question, an answer, an edit and a command, each about `pad` characters.
function turns(from, to, pad = 1_000) {
  const events = [];
  let seq = from * 4;
  for (let n = from; n < to; n++) {
    events.push({ seq: ++seq, type: 'user-text', text: `ask-${n} `.padEnd(pad, 'q') });
    events.push({ seq: ++seq, type: 'assistant-text', tool: 'claude', text: `answer-${n} `.padEnd(pad, 'a') });
    events.push({ seq: ++seq, type: 'file-edit', path: `src/f${n}.js`, diff: '+x' });
    events.push({ seq: ++seq, type: 'tool-run', name: 'Bash', summary: `npm test ${n}` });
  }
  return events;
}
const SMALL = { compactAt: 6_000, recentChars: 3_000, maxChars: 60_000 };
const claudeLabel = (tool) => ({ claude: 'Claude' })[tool] ?? 'Claude';

test('a short conversation is sent unchanged, byte for byte, with no digest', () => {
  const events = turns(0, 3);
  const full = buildTranscript(events, events.at(-1).seq, claudeLabel);
  const handoff = buildHandoff(events, events.at(-1).seq, claudeLabel);
  assert.equal(handoff.text, full.text);
  assert.equal(handoff.digestedTurns, 0);
  assert.equal(handoff.digest, null);
  assert.ok(HANDOFF_COMPACT_AT < HANDOFF_MAX_CHARS && HANDOFF_RECENT_CHARS < HANDOFF_COMPACT_AT);
});

test('a long conversation keeps the recent turns word for word and digests the rest', () => {
  const events = turns(0, 30);
  const before = JSON.stringify(events);
  const upTo = events.at(-1).seq;
  const handoff = buildHandoff(events, upTo, claudeLabel, null, SMALL);
  assert.ok(handoff.digestedTurns > 0 && handoff.digestedTurns < 30);
  assert.match(handoff.text, /^Digest of the \d+ earliest turns \(background only/);
  assert.match(handoff.text, /Recent conversation, word for word:/);
  assert.ok(handoff.text.includes(`User: ${events.at(-4).text}`), 'the newest question is word for word');
  assert.ok(handoff.text.includes(`Assistant (Claude): ${events.at(-3).text}`), 'the newest answer is word for word');
  assert.doesNotMatch(handoff.text, /User: ask-0 /);
  assert.match(handoff.text, /- Asked: ask-0 q+… \[shortened\] \| Answered \(Claude\): answer-0 a+… \[shortened\] \| Changed: src\/f0\.js \| Ran: npm test 0/);
  assert.ok(handoff.text.length < SMALL.maxChars);
  assert.equal(JSON.stringify(events), before, 'the chat history itself is untouched');
  assert.equal(handoff.digest.upToSeq > 0 && handoff.digest.entries.length, handoff.digestedTurns);
});

test('a second switch extends the kept digest instead of rebuilding it', () => {
  const first = turns(0, 30);
  const one = buildHandoff(first, first.at(-1).seq, claudeLabel, null, SMALL);
  const more = [...first, ...turns(30, 45)];
  const two = buildHandoff(more, more.at(-1).seq, claudeLabel, one.digest, SMALL);
  assert.ok(two.digest.upToSeq > one.digest.upToSeq);
  assert.ok(two.digest.entries.length > one.digest.entries.length);
  assert.deepEqual(two.digest.entries.slice(0, one.digest.entries.length), one.digest.entries, 'earlier lines are reused as they were');
  const kept = { upToSeq: one.digest.upToSeq, entries: one.digest.entries.map((e) => ({ ...e, line: `kept ${e.line}` })), omitted: 0 };
  const proof = buildHandoff(more, more.at(-1).seq, claudeLabel, kept, SMALL);
  assert.match(proof.text, /- kept Asked: ask-0 /, 'the stored lines are what is sent, not a fresh digest');
});

test('the hard cap is respected, dropping the oldest digest lines first and saying so', () => {
  const events = turns(0, 120);
  const handoff = buildHandoff(events, events.at(-1).seq, claudeLabel, null, { compactAt: 6_000, recentChars: 3_000, maxChars: 8_000 });
  assert.ok(handoff.text.length <= 8_000, `${handoff.text.length} characters`);
  assert.match(handoff.text, /older ones are left out/);
  assert.ok(handoff.text.includes(`User: ${events.at(-4).text}`));
  assert.doesNotMatch(handoff.text, /Asked: ask-0 /);
  assert.match(wrapFirstMessage({ transcript: handoff.text, dropped: 0, digestedTurns: handoff.digestedTurns, from: 'Claude', to: 'Codex', message: 'next' }), /shortened into a digest/);
});

test('the stored digest survives a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-digest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chat = Chat.create({ tool: 'claude', cwd: dir, settings: {} }, dir);
  for (const ev of turns(0, 30)) chat.emit(ev);
  const handoff = buildHandoff(chat.events, chat.seq, claudeLabel, null, SMALL);
  chat.handoffDigest = handoff.digest;
  chat.persist();
  const loaded = Chat.load(chat.file);
  assert.deepEqual(loaded.handoffDigest, handoff.digest);
  assert.equal(chat.view().handoffDigest, undefined, 'the phone is not sent the digest');
});

test('a long chat switched on a real server says earlier turns were summarised, and the next engine gets the digest', { timeout: 180000 }, async (t) => {
  const c = await open(t);
  const asks = Array.from({ length: 17 }, (_, i) => `ask-${i} `.padEnd(8_000, 'q'));
  for (const [i, text] of asks.entries()) await c.say(text, i + 1);
  const switched = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'codex' });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  const status = (await c.get()).events.filter((e) => e.type === 'status').at(-1).text;
  assert.match(status, /Switched from Antigravity to Codex\. The conversation continues here\. Earlier turns were summarised\./);
  await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' });
  const after = await c.say('echo-prompt final', 18);
  const got = after.events.filter((e) => e.type === 'assistant-text').at(-1).text;
  assert.match(got, /Digest of the \d+ earliest turns/);
  assert.ok(got.includes(asks.at(-1).slice(0, 7_990)), 'the newest question is word for word');
  assert.ok(!got.includes(asks[0]), 'the oldest question is no longer word for word');
  assert.match(got, /- Asked: ask-0 q+… \[shortened\]/, 'it is in the digest, shortened');
  assert.equal(after.events.filter((e) => e.type === 'user-text').length, 18, 'the chat still shows every message');
  assert.equal(after.events.find((e) => e.type === 'user-text').text, asks[0], 'in full');
});
