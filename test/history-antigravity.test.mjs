import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// History reads its folders from these at call time, so a temp store stands in for ~/.claude, ~/.codex and ~/.gemini.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-agyhist-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
process.env.POCKET_DEV_CHAT_DIR = path.join(root, 'chats');
process.env.POCKET_DEV_AGY_DIR = path.join(root, 'agy');
const { createHistoryApi, findConversation, resumeArgv } = await import('../src/conversations/history.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const A = '11111111-aaaa-4bbb-8ccc-000000000001';
const SUB = '11111111-aaaa-4bbb-8ccc-000000000002';
const EMPTY = '11111111-aaaa-4bbb-8ccc-000000000003';
const OLD = '11111111-aaaa-4bbb-8ccc-000000000004';
const app = path.join(root, 'my app');
fs.mkdirSync(app);
fs.mkdirSync(path.join(process.env.POCKET_DEV_AGY_DIR, 'conversations'), { recursive: true });

// The columns agy's summaries database has that history reads.
const dbFile = path.join(process.env.POCKET_DEV_AGY_DIR, 'conversation_summaries.db');
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, status text NOT NULL DEFAULT "",
  parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0)`);
const insert = db.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const uri = (dir) => JSON.stringify([`file://${dir.replace(/ /g, '%20')}`]);
insert.run(A, 'Fix the login page', 'Fix the login page', 12, '2026-11-16 11:53:21.090185+00:00', uri(app), '', 0);
insert.run(SUB, '', '', 9, '2026-11-16 11:50:00.000000+00:00', uri(app), A, 1);
insert.run(EMPTY, 'Never started', 'Never started', 0, '2026-11-16 11:40:00.000000+00:00', uri(app), '', 0);
insert.run(OLD, '', 'Write the release notes', 4, '2026-10-01 08:00:00.000000+00:00', JSON.stringify(['vscode-remote://x/y']), '', 0);
db.close();
fs.writeFileSync(path.join(process.env.POCKET_DEV_AGY_DIR, 'conversations', `${A}.db`), 'not a real conversation file');

function api() {
  const sessions = [];
  const handle = createHistoryApi({
    createSession: async (cwd, title, command) => { const s = { id: 'term1', title, cwd, command }; sessions.push(s); return s; },
    sessionView: (s) => s,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {},
    deviceFor: () => ({ id: 'dev1', name: 'Pixel 8', ip: '192.168.1.20' }),
    log: () => {},
    system: { listProcesses: async () => [], kill() {}, sleep: async () => {}, uid: process.getuid(), selfPid: 999_999 },
  });
  const call = async (method, url, body) => {
    const res = {};
    await handle({ method, url, headers: {}, body }, res, url.split('?')[0]);
    return res;
  };
  return { call, sessions };
}

test('the list shows Antigravity conversations with title, folder and step count, and leaves out helpers and empty ones', async () => {
  const { call } = api();
  const res = await call('GET', '/api/history?tool=antigravity');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((s) => s.id), [A, OLD]);
  const [first, old] = res.body;
  assert.equal(first.tool, 'antigravity');
  assert.equal(first.title, 'Fix the login page');
  assert.equal(first.cwd, app);
  assert.equal(first.project, 'my app');
  assert.equal(first.messageCount, 12);
  assert.equal(first.lastActive, '2026-11-16T11:53:21.090Z');
  assert.equal(old.title, 'Write the release notes');
  assert.equal(old.cwd, null, 'a workspace that is not a local folder has no folder');
});

test('all and the other tools still work next to Antigravity, and an unknown tool is refused', async () => {
  const { call } = api();
  const all = await call('GET', '/api/history');
  assert.equal(all.status, 200);
  assert.ok(all.body.some((s) => s.tool === 'antigravity'));
  assert.deepEqual((await call('GET', '/api/history?tool=claude')).body, []);
  const bad = await call('GET', '/api/history?tool=gemini');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /claude, codex, antigravity or copilot/);
});

test('the detail has the title as its one message and says why', async () => {
  const { call } = api();
  const res = await call('GET', `/api/history/antigravity/${A}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.tool, 'antigravity');
  assert.equal(res.body.messages.length, 1);
  assert.equal(res.body.messages[0].text, 'Fix the login page');
  assert.match(res.body.note, /own format/);
  assert.equal((await call('GET', `/api/history/antigravity/${SUB}`)).status, 404, 'a helper conversation is not a conversation to open');
});

test('Open here in a terminal resumes it with agy --conversation in its folder', async () => {
  const { call, sessions } = api();
  const res = await call('POST', `/api/history/antigravity/${A}/resume`);
  assert.equal(res.status, 201);
  assert.deepEqual(sessions[0], { id: 'term1', title: 'antigravity · my app', cwd: app, command: `agy --conversation ${A}` });
  assert.deepEqual(resumeArgv('antigravity', A), ['agy', ['--conversation', A]]);
});

test('a conversation with no folder on this computer opens in the home folder and says so', async () => {
  const { call, sessions } = api();
  const res = await call('POST', `/api/history/antigravity/${OLD}/resume`);
  assert.equal(res.status, 201);
  assert.equal(sessions[0].cwd, os.homedir());
  assert.match(res.body.note, /no longer exists|home folder/);
});

test('names that are not a conversation id never reach the files', async () => {
  const { call } = api();
  for (const id of ['..', '../../etc/passwd', 'x'.repeat(65), 'short']) {
    const res = await call('GET', `/api/history/antigravity/${encodeURIComponent(id)}`);
    assert.equal(res.status, 400, id);
  }
  assert.equal((await call('GET', '/api/history/antigravity/11111111-aaaa-4bbb-8ccc-999999999999')).status, 404);
});

test('the CLI finds an Antigravity conversation by its id', async () => {
  assert.deepEqual(await findConversation(A), { tool: 'antigravity', id: A, cwd: app });
});

test("agy's own files are read from a copy: nothing is changed or added next to them", async () => {
  const dir = process.env.POCKET_DEV_AGY_DIR;
  const snapshot = () => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}:${fs.statSync(path.join(dir, f)).size}`);
  const before = snapshot();
  await api().call('GET', '/api/history?tool=antigravity');
  fs.utimesSync(dbFile, new Date(), new Date());
  await api().call('GET', '/api/history?tool=antigravity');
  assert.deepEqual(snapshot().map((x) => x.split(':')[0]), before.map((x) => x.split(':')[0]), 'no -wal, -shm or other file appears');
  assert.equal(fs.statSync(dbFile).size, Number(before.find((x) => x.startsWith('conversation_summaries.db')).split(':')[2]));
});

test('no Antigravity folder means an empty list, not an error', async () => {
  const saved = process.env.POCKET_DEV_AGY_DIR;
  process.env.POCKET_DEV_AGY_DIR = path.join(root, 'nothing-here');
  try {
    const res = await api().call('GET', '/api/history?tool=antigravity');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  } finally { process.env.POCKET_DEV_AGY_DIR = saved; }
});
