import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-unified-history-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
process.env.POCKET_DEV_AGY_DIR = path.join(root, 'agy');
process.env.POCKET_DEV_COPILOT_DIR = path.join(root, 'copilot');
const { createHistoryApi, readConversationMessages, codexInTurn } = await import('../history.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const app = path.join(root, 'app');
fs.mkdirSync(app);
const ids = Object.fromEntries(['claude', 'codex', 'antigravity', 'copilot'].map((tool, i) => [tool, `33333333-aaaa-4bbb-8ccc-${String(i + 1).padStart(12, '0')}`]));
const at = '2026-11-01T12:00:00.000Z';
const old = new Date(Date.now() - 3600_000);
const writeJsonl = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, old, old);
};
const claudeFile = path.join(process.env.POCKET_DEV_CLAUDE_DIR, app.replace(/[^A-Za-z0-9]/g, '-'), `${ids.claude}.jsonl`);
const long = 'message '.repeat(40_000);
writeJsonl(claudeFile, [
  { type: 'user', cwd: app, timestamp: at, message: { content: 'Claude login task' } },
  ...Array.from({ length: 25 }, (_, i) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `Earlier reply ${i}` }] } })),
  { type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: long }] } },
]);
writeJsonl(path.join(process.env.POCKET_DEV_CODEX_DIR, 'sessions', `rollout-2026-11-01-${ids.codex}.jsonl`), [
  { timestamp: at, type: 'session_meta', payload: { id: ids.codex, cwd: app } },
  { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex release task' }] } },
  { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex answer' }] } },
]);
fs.mkdirSync(process.env.POCKET_DEV_AGY_DIR, { recursive: true });
const db = new DatabaseSync(path.join(process.env.POCKET_DEV_AGY_DIR, 'conversation_summaries.db'));
db.exec('CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, parent_conversation_id text, nesting_depth integer)');
db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ids.antigravity, 'Antigravity layout task', '', 3, at, JSON.stringify([`file://${app}`]), '', '', 0);
db.close();
const copilotDir = path.join(process.env.POCKET_DEV_COPILOT_DIR, ids.copilot);
fs.mkdirSync(copilotDir, { recursive: true });
fs.writeFileSync(path.join(copilotDir, 'workspace.yaml'), `cwd: ${app}\nname: Copilot test task\nupdated_at: ${at}\n`);
writeJsonl(path.join(copilotDir, 'events.jsonl'), [
  { type: 'user.message', timestamp: at, data: { content: 'Copilot test task' } },
  { type: 'assistant.message', timestamp: at, data: { content: long } },
]);

function fixture({ chats = [], bound = [], procs = [], owner = true, resume } = {}) {
  const table = new Map(procs.map((p) => [p.pid, p]));
  const signals = [], imported = [], released = [];
  const handle = createHistoryApi({
    createSession: async () => {}, sessionView: (s) => s,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {}, deviceFor: () => owner ? { id: 'owner-device' } : null,
    isOwner: (req) => owner && !req.roomPeer && !req.guest,
    log() {}, listChats: () => chats,
    resumeChat: async (s) => { imported.push(s); return resume ? resume(s) : { id: 'new-chat', tool: s.tool, sessionId: s.id }; },
    own: { chats: () => bound, releaseChat: async (id) => { released.push(id); bound.splice(0); return true; } },
    system: { listProcesses: async () => [...table.values()], kill(pid, signal) { signals.push([pid, signal]); table.delete(pid); }, sleep: async () => {}, uid: process.getuid(), selfPid: 999_999 },
  });
  const call = async (method, url, body, req = {}) => {
    const res = {};
    await handle({ method, url, body, headers: {}, ...req }, res, url.split('?')[0]);
    return res;
  };
  return { call, signals, imported, released };
}
const liveProcess = () => ({ pid: 12345, ppid: 1, uid: process.getuid(), stat: 'S', started: 0, exe: '/usr/bin/claude', args: `claude --resume ${ids.claude}` });

test('one list includes all four native providers and deduplicates sleeping and past provider sessions', async () => {
  const all = await fixture().call('GET', '/api/history/chats');
  assert.equal(all.status, 200);
  assert.deepEqual(new Set(all.body.computer.map((s) => s.tool)), new Set(Object.keys(ids)));
  const chats = [
    { id: 'phone', title: 'Phone task', tool: 'codex', sessionId: ids.codex, status: 'sleeping', sessionRefs: [{ tool: 'claude', id: ids.claude }] },
  ];
  const deduped = await fixture({ chats }).call('GET', '/api/history/chats');
  assert.deepEqual(deduped.body.chats, chats);
  assert.deepEqual(new Set(deduped.body.computer.map((s) => s.tool)), new Set(['antigravity', 'copilot']));
});

test('search filters both sources before pagination; Show more never repeats an item', async () => {
  const f = fixture({ chats: [{ title: 'Copilot phone task', tool: 'copilot' }, { title: 'Other task', tool: 'claude' }] });
  const first = await f.call('GET', '/api/history/chats?limit=2');
  const second = await f.call('GET', '/api/history/chats?limit=2&offset=2');
  assert.equal(first.body.hasMore, true);
  assert.equal(second.body.hasMore, false);
  assert.equal(new Set([...first.body.computer, ...second.body.computer].map((s) => s.tool)).size, 4);
  const found = await f.call('GET', '/api/history/chats?limit=1&q=copilot');
  assert.deepEqual(found.body.computer.map((s) => s.tool), ['copilot']);
  assert.equal(found.body.chats.length, 1);
  assert.equal(found.body.hasMore, false);
  const none = await f.call('GET', '/api/history/chats?q=not-present');
  assert.deepEqual(none.body, { chats: [], computer: [], hasMore: false });
  for (const offset of ['-1', 'abc', '1.1', '100001']) assert.equal((await f.call('GET', `/api/history/chats?offset=${offset}`)).status, 400);
});

test('anonymous callers, collaborators and room peers cannot read or open computer conversations', async () => {
  for (const [f, req] of [[fixture({ owner: false }), {}], [fixture(), { guest: true }], [fixture(), { roomPeer: {} }]]) {
    assert.equal((await f.call('GET', '/api/history/chats', undefined, req)).status, 403);
    assert.equal((await f.call('POST', `/api/history/claude/${ids.claude}/open-chat`, {}, req)).status, 403);
    assert.equal(f.imported.length, 0);
    assert.deepEqual(f.signals, []);
  }
});

test('opening a native conversation stops its external writer before importing', async () => {
  const f = fixture({ procs: [liveProcess()] });
  const res = await f.call('POST', `/api/history/claude/${ids.claude}/open-chat`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.chat.sessionId, ids.claude);
  assert.deepEqual(f.signals, [[12345, 'SIGTERM']]);
  assert.equal(f.imported.length, 1);
  assert.equal(f.imported[0].cwd, app);
});

test('an already open Pocket Dev chat shares its current reply without release or import', async () => {
  const chat = { id: 'chat1', tool: 'claude', sessionId: ids.claude, status: 'running' };
  const engine = { ...liveProcess(), ppid: 999_999 };
  const f = fixture({ chats: [chat], bound: [chat], procs: [engine] });
  const res = await f.call('POST', `/api/history/claude/${ids.claude}/open-chat`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.chat, chat);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.released, []);
  assert.deepEqual(f.imported, []);
});

test('a busy writer never refuses opening: the chat opens held by it and nothing is signalled; no writer opens at once', async () => {
  const fresh = new Date();
  fs.utimesSync(claudeFile, fresh, fresh);
  try {
    const f = fixture({ procs: [liveProcess()] });
    const busy = await f.call('POST', `/api/history/claude/${ids.claude}/open-chat`, {});
    assert.equal(busy.status, 200, JSON.stringify(busy.body));
    assert.equal(busy.body.chat.sessionId, ids.claude);
    assert.deepEqual(f.signals, [], 'the reply on the computer keeps running');
    assert.deepEqual(f.imported.map((s) => s.heldBy), ['Claude Code']);
    const unknown = fixture();
    const opened = await unknown.call('POST', `/api/history/claude/${ids.claude}/open-chat`, {});
    assert.equal(opened.status, 200);
    assert.deepEqual(unknown.imported.map((s) => s.heldBy ?? null), [null]);
  } finally { fs.utimesSync(claudeFile, old, old); }
});

test('full native import preserves old turns and long text, and reports Antigravity unreadability', async () => {
  const claude = await readConversationMessages('claude', ids.claude);
  assert.equal(claude.messages.length, 27);
  assert.equal(claude.messages[1].text, 'Earlier reply 0');
  assert.equal(claude.messages.at(-1).text, long.trim());
  const codex = await readConversationMessages('codex', ids.codex);
  assert.deepEqual(codex.messages.map((m) => m.text), ['Codex release task', 'Codex answer']);
  const copilot = await readConversationMessages('copilot', ids.copilot);
  assert.equal(copilot.messages.at(-1).text, long.trim());
  const antigravity = await readConversationMessages('antigravity', ids.antigravity);
  assert.deepEqual(antigravity.messages, []);
  assert.match(antigravity.note, /own format/);
});

test("a Codex thread is replying while its rollout's last turn marker is task_started, read from the tail only", async () => {
  const thread = '01a1ec6c-74e2-77f2-a309-a6daa5243871';
  const file = path.join(process.env.POCKET_DEV_CODEX_DIR, 'sessions', '2026', '11', '18', `rollout-2026-11-18T07-41-33-${thread}.jsonl`);
  const marker = (type) => ({ timestamp: at, type: 'event_msg', payload: { type, turn_id: 't1' } });
  const filler = { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(100_000) }] } };
  writeJsonl(file, [{ timestamp: at, type: 'session_meta', payload: { id: thread, cwd: app } }, marker('task_started'), marker('task_complete'), marker('task_started')]);
  assert.equal(await codexInTurn(thread), true);
  fs.appendFileSync(file, `${JSON.stringify(marker('turn_aborted'))}\n`);
  assert.equal(await codexInTurn(thread), false, 'an aborted turn is over');
  fs.appendFileSync(file, `${JSON.stringify(marker('task_started'))}\n${Array.from({ length: 6 }, () => JSON.stringify(filler)).join('\n')}\n`);
  assert.equal(await codexInTurn(thread), true, 'a marker further back than the first window is found by widening');
  assert.equal(await codexInTurn('01a1ec6c-0000-77f2-a309-a6daa5243871'), null, 'no rollout: cannot tell');
});
