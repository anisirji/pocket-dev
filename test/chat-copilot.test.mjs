import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startServer, pause } from './helpers/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COPILOT = path.join(HERE, 'helpers', 'fake-copilot.mjs');
const FAKE_AGY = path.join(HERE, 'helpers', 'fake-agy.mjs');

// Every engine is a stand-in: Copilot and Antigravity speak the protocol, and Codex and Claude only have to count as installed.
async function open(t, env = {}, { tool = 'copilot', server } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-fakecopilot-')), 'log.jsonl');
  t.after(() => fs.rmSync(path.dirname(log), { recursive: true, force: true }));
  const fullEnv = { POCKET_DEV_COPILOT: FAKE_COPILOT, POCKET_DEV_AGY: FAKE_AGY, POCKET_DEV_CODEX: FAKE_COPILOT, POCKET_DEV_CLAUDE: FAKE_COPILOT, FAKE_COPILOT_LOG: log, ...env };
  const s = server ?? await startServer(t, { env: fullEnv });
  const A = await s.login();
  const call = (method, url, body, cookie = A.cookie) => s.request(method, url, { cookie, body });
  const created = await call('POST', '/api/chat', { tool, cwd: s.home });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const get = async () => (await call('GET', `/api/chat/${id}`)).data;
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const c = await get(); if (pred(c)) return c; await pause(40); }
    throw new Error(`timed out: ${JSON.stringify(await get())}`);
  };
  const answers = (c) => c.events.filter((e) => e.type === 'assistant-text');
  const say = async (text, count) => {
    assert.equal((await call('POST', `/api/chat/${id}/message`, { text })).status, 202);
    return until((x) => x.status === 'idle' && answers(x).length >= count);
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { s, A, call, id, get, until, say, answers, calls, env: fullEnv };
}

// ---- 1. History in Pocket Dev's own format ------------------------------------------------------------------------

test('Copilot answers through copilot --acp --stdio, and every answer says it was Copilot who wrote it', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' })).status, 202);
  const chat = await c.until((x) => x.status === 'idle' && c.answers(x).length);
  assert.equal(chat.tool, 'copilot');
  const answer = c.answers(chat)[0];
  assert.equal(answer.text, 'Hello from copilot');
  assert.equal(answer.tool, 'copilot');
  assert.match(chat.sessionId, /^00000000-0000-4000-8000-/);
  assert.ok(chat.events.some((e) => e.type === 'result'));
  const argv = c.calls().find((x) => x.argv).argv;
  assert.deepEqual(argv.slice(0, 2), ['--acp', '--stdio']);
  assert.ok(argv.includes('--no-auto-update'));
  assert.ok(!argv.includes('--reasoning-effort'), 'no effort flag when effort is left at its default');
});

test('the history, the tool labels and the session survive a server restart, and the chat list names Copilot', { timeout: 90000 }, async (t) => {
  const c = await open(t);
  const before = await c.say('hello', 1);
  const listed = (await c.call('GET', '/api/chat')).data;
  assert.equal([].concat(listed.chats ?? listed).find((x) => x.id === c.id).tool, 'copilot');
  c.s.proc.kill();
  await once(c.s.proc, 'exit');
  const again = await startServer(t, { env: c.env, reuse: c.s });
  const login = await again.login();
  const after = (await again.request('GET', `/api/chat/${c.id}`, { cookie: login.cookie })).data;
  assert.equal(after.tool, 'copilot');
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(c.answers(after).map((e) => [e.text, e.tool]), [['Hello from copilot', 'copilot']]);
  assert.deepEqual(after.events.filter((e) => e.type === 'user-text').map((e) => e.text), ['hello']);
});

// ---- 2. Switching both ways keeps the whole conversation -----------------------------------------------------------

test('Antigravity to Copilot and back: each new engine gets the whole conversation, and the chat says so', { timeout: 120000 }, async (t) => {
  const c = await open(t, {}, { tool: 'antigravity' });
  await c.say('first question', 1);
  const toCopilot = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'copilot' });
  assert.equal(toCopilot.status, 200, JSON.stringify(toCopilot.data));
  let chat = await c.get();
  assert.equal(chat.tool, 'copilot');
  assert.match(chat.events.filter((e) => e.type === 'status').at(-1).text, /^Switched from Antigravity to Copilot\. The conversation continues here\.$/);
  chat = await c.say('echo-prompt please', 2);
  const copilotSaw = c.answers(chat).at(-1);
  assert.equal(copilotSaw.tool, 'copilot');
  assert.match(copilotSaw.text, /first question/, 'Copilot was given the earlier question');
  assert.match(copilotSaw.text, /Hello from agy/, 'and the earlier answer');
  assert.match(copilotSaw.text, /echo-prompt please/, 'and then the new message');

  const back = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.match((await c.get()).events.filter((e) => e.type === 'status').at(-1).text, /^Switched from Copilot to Antigravity\. The conversation continues here\.$/);
  chat = await c.say('echo-prompt again', 3);
  const agySaw = c.answers(chat).at(-1).text;
  assert.match(agySaw, /first question/);
  assert.match(agySaw, /Assistant \(Copilot\)/, 'the answer Copilot gave is in what Antigravity received, labelled as Copilot');
  assert.deepEqual(c.answers(chat).map((e) => e.tool), ['antigravity', 'copilot', 'antigravity']);
  assert.equal(chat.events.filter((e) => e.type === 'user-text').length, 3, 'nothing was lost from the chat itself');
});

test('Copilot to Codex, to Claude and back to Copilot: every hop keeps the history and says where it went', { timeout: 120000 }, async (t) => {
  const c = await open(t);
  await c.say('hello', 1);
  const events = (await c.get()).events.length;
  for (const [tool, label, from] of [['codex', 'Codex', 'Copilot'], ['claude', 'Claude', 'Codex'], ['copilot', 'Copilot', 'Claude']]) {
    const res = await c.call('POST', `/api/chat/${c.id}/engine`, { tool });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const chat = await c.get();
    assert.equal(chat.tool, tool);
    assert.match(chat.events.filter((e) => e.type === 'status').at(-1).text, new RegExp(`^Switched from ${from} to ${label}\\.`));
    assert.ok(chat.events.length > events, 'the old events are all still there');
    assert.equal(chat.events.find((e) => e.type === 'user-text').text, 'hello');
  }
  const chat = await c.say('echo-prompt after the round trip', 2);
  assert.match(c.answers(chat).at(-1).text, /Assistant \(Copilot\): Hello from copilot/);
});

test('a long Copilot chat is compacted when it moves to another engine, and the digest says so', { timeout: 240000 }, async (t) => {
  const c = await open(t);
  const asks = Array.from({ length: 17 }, (_, i) => `ask-${i} `.padEnd(8_000, 'q'));
  for (const [i, text] of asks.entries()) await c.say(text, i + 1);
  const switched = await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  const status = (await c.get()).events.filter((e) => e.type === 'status').at(-1).text;
  assert.match(status, /Switched from Copilot to Antigravity\. The conversation continues here\. Earlier turns were summarised\./);
  const chat = await c.say('echo-prompt', 18);
  const received = c.answers(chat).at(-1).text;
  assert.match(received, /Digest of the \d+ earliest turns/);
  assert.match(received, /Assistant \(Copilot\)/);
  assert.equal(chat.events.filter((e) => e.type === 'user-text').length, 18, 'the chat itself keeps every message');
});

// ---- 3. Chat list, Open here ---------------------------------------------------------------------------------------

test('a Copilot session found in the Resume sheet opens in chat and continues with session/load, without replaying it', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  const sid = '33333333-aaaa-4bbb-8ccc-000000000009';
  const resumed = await c.call('POST', '/api/chat', { tool: 'copilot', cwd: c.s.home, resume: { sessionId: sid } });
  assert.equal(resumed.status, 201, JSON.stringify(resumed.data));
  await c.call('POST', `/api/chat/${resumed.data.id}/message`, { text: 'hello' });
  const end = Date.now() + 8000;
  let chat;
  while (Date.now() < end) { chat = (await c.call('GET', `/api/chat/${resumed.data.id}`)).data; if (chat.status === 'idle' && c.answers(chat).length) break; await pause(40); }
  assert.equal(chat.sessionId, sid);
  assert.ok(c.calls().some((x) => x.method === 'session/load' && x.params.sessionId === sid), 'the session was loaded, not created');
  assert.ok(!JSON.stringify(chat.events).includes('old answer'), 'the replayed history is not shown again');
});

test('a chat that went to sleep wakes with the same Copilot session', { timeout: 60000 }, async (t) => {
  const c = await open(t, { POCKET_DEV_CHAT_IDLE_SECONDS: '1' });
  const first = await c.say('hello', 1);
  await pause(3500);
  const chat = await c.say('again', 2);
  assert.ok(chat.events.some((e) => e.type === 'status' && /Waking up/.test(e.text)), 'the engine really slept and woke');
  assert.equal(chat.sessionId, first.sessionId);
  assert.ok(c.calls().some((x) => x.method === 'session/load'));
});

// ---- 4. Queue, stop, approvals, modes, attachments, limits, model, effort ------------------------------------------

test('a permission request shows the change, waits for the phone, and the choice reaches Copilot', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission' });
  const waiting = await c.until((x) => x.status === 'waiting-permission');
  const req = waiting.events.find((e) => e.type === 'permission-request');
  assert.equal(req.title, 'Create file');
  assert.equal(req.kind, 'file');
  assert.match(req.diff, /@@ \/tmp\/fake-copilot\/probe\.txt\n\+hello/);
  assert.equal(req.rule, 'Tool: Create file');
  assert.ok(waiting.events.some((e) => e.type === 'file-edit' && e.path === '/tmp/fake-copilot/probe.txt' && e.diff.includes('+hello')));
  assert.equal((await c.call('POST', `/api/chat/${c.id}/answer`, { requestId: req.requestId, decision: 'deny' })).status, 200);
  const done = await c.until((x) => x.status === 'idle' && c.answers(x).length);
  assert.equal(c.answers(done)[0].text, 'chose reject_once');
  assert.equal(done.events.find((e) => e.type === 'file-edit').status, 'error');
});

test('Approve for this chat remembers the kind of change, so the next request is not asked', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission' });
  const req = (await c.until((x) => x.status === 'waiting-permission')).events.find((e) => e.type === 'permission-request');
  await c.call('POST', `/api/chat/${c.id}/answer`, { requestId: req.requestId, decision: 'allow-chat' });
  await c.until((x) => x.status === 'idle' && c.answers(x).some((e) => e.text === 'chose allow_once'));
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission again' });
  const done = await c.until((x) => x.status === 'idle' && c.answers(x).filter((e) => e.text === 'chose allow_once').length === 2);
  assert.equal(done.events.filter((e) => e.type === 'permission-request').length, 1);
});

test('Stop cancels the turn in Copilot', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'slow' });
  await c.until((x) => x.status === 'running' && x.events.some((e) => e.text === 'working'));
  await c.call('POST', `/api/chat/${c.id}/interrupt`, {});
  // The 5 second fallback in Pocket Dev would also end the turn, so a quick finish proves Copilot got the cancel.
  await c.until((x) => x.status === 'idle', 3000);
  assert.ok(c.calls().some((x) => x.method === 'session/cancel'));
});

test('a message sent while Copilot is working waits in the queue and goes out after Stop', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'slow' });
  await c.until((x) => x.status === 'running' && x.events.some((e) => e.text === 'working'));
  const queued = await c.call('POST', `/api/chat/${c.id}/message`, { text: 'the next thing' });
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  assert.ok(((await c.get()).queued ?? 0) >= 1 || (await c.get()).events.some((e) => e.queued), 'it waits instead of interrupting');
  await c.call('POST', `/api/chat/${c.id}/interrupt`, {});
  const done = await c.until((x) => x.status === 'idle' && c.answers(x).some((e) => e.text === 'Hello from copilot'), 10000);
  assert.deepEqual(done.events.filter((e) => e.type === 'user-text' && !e.removed).map((e) => e.text), ['slow', 'the next thing']);
});

test('the Mode setting sends plan mode to Copilot, before the first message and between turns', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('PATCH', `/api/chat/${c.id}`, { settings: { mode: 'plan' } })).status, 200);
  await c.say('hello', 1);
  const planUrl = 'https://agentclientprotocol.com/protocol/session-modes#plan';
  assert.ok(c.calls().some((x) => x.method === 'session/set_mode' && x.params.modeId === planUrl), 'the chosen mode was sent when the session started');
  const again = await c.call('PATCH', `/api/chat/${c.id}`, { settings: { mode: 'agent' } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.applied.mode, 'next-turn');
  assert.ok(c.calls().some((x) => x.method === 'session/set_mode' && x.params.modeId.endsWith('#agent')));
  assert.equal((await c.call('PATCH', `/api/chat/${c.id}`, { settings: { mode: 'autopilot' } })).status, 400, 'unattended autopilot is not offered');
});

test('the model picker sends the chosen model to Copilot, and Auto sends auto', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('PATCH', `/api/chat/${c.id}`, { settings: { model: 'gpt-5' } })).status, 200);
  await c.say('hello', 1);
  assert.ok(c.calls().some((x) => x.method === 'session/set_model' && x.params.modelId === 'gpt-5'));
  const again = await c.call('PATCH', `/api/chat/${c.id}`, { settings: { model: 'default' } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.applied.model, 'next-turn');
  assert.ok(c.calls().some((x) => x.method === 'session/set_model' && x.params.modelId === 'auto'));
  const schema = (await c.call('GET', '/api/chat/options')).data.tools.copilot;
  assert.equal(schema.label, 'Copilot');
  assert.equal(schema.experimental, true);
  assert.deepEqual(schema.settings.map((s) => s.key), ['model', 'mode', 'effort']);
});

test('the Effort setting is a command-line argument, so the next turn restarts Copilot with it', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.say('hello', 1);
  const res = await c.call('PATCH', `/api/chat/${c.id}`, { settings: { effort: 'high' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.applied.effort, 'next-turn', 'it takes effect from the next message, in a fresh process');
  await c.say('again', 2);
  const starts = c.calls().filter((x) => x.argv).map((x) => x.argv);
  assert.equal(starts.length, 2, 'a second process was started');
  assert.deepEqual(starts[1].slice(starts[1].indexOf('--reasoning-effort')), ['--reasoning-effort', 'high']);
  assert.ok(c.calls().some((x) => x.method === 'session/load'), 'and it picked the same session up again');
});

test('a picture attached with the paperclip is sent to Copilot as an image', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${c.s.base}/api/upload`, { method: 'POST', headers: { cookie: c.A.cookie, 'x-pocket-dev': '1', 'x-filename': 'dot.png', 'content-type': 'application/octet-stream' }, body: png });
  assert.equal(up.status, 201, await up.clone().text());
  const { path: file } = await up.json();
  const sent = await c.call('POST', `/api/chat/${c.id}/message`, { text: 'image-check', attachments: [file] });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const chat = await c.until((x) => x.status === 'idle' && c.answers(x).length);
  assert.equal(c.answers(chat)[0].text, 'image: yes');
  const plain = await c.say('image-check', 2);
  assert.equal(c.answers(plain)[1].text, 'image: no');
});

// ---- Limits, sign-in and start-up problems -------------------------------------------------------------------------

test('a spent premium allowance, as an error or as an answer, becomes a usage limit error so the chat offers Continue with', { timeout: 60000 }, async (t) => {
  for (const text of ['limit-error', 'limit-answer']) {
    const c = await open(t);
    assert.equal((await c.call('POST', `/api/chat/${c.id}/message`, { text })).status, 202);
    const chat = await c.until((x) => x.events.some((e) => e.type === 'error') && x.events.some((e) => e.type === 'result'));
    const error = chat.events.find((e) => e.type === 'error');
    assert.equal(error.message, 'Copilot usage limit reached. Resets on Dec 1, 2026.', text);
    assert.match(error.message, /\blimit reached\b/i, 'the phone shows the Continue with buttons for this wording');
  }
});

test('only a short spent-allowance message counts as a limit', async () => {
  const { copilotLimitNotice } = await import('../src/chat/limits.js');
  assert.equal(copilotLimitNotice('Hello from copilot'), null);
  assert.equal(copilotLimitNotice('You can set a rate limit in nginx with limit_req.'), null);
  assert.equal(copilotLimitNotice(`${'The quota section explains how the limit is reached. '.repeat(20)}`), null);
  assert.deepEqual(copilotLimitNotice('Monthly limit reached.'), { type: 'error', message: 'Copilot usage limit reached.' });
  assert.equal(copilotLimitNotice('You have used up your premium requests. Resets in 3h 20m.').message, 'Copilot usage limit reached. Resets in 3h 20m.');
});

test('a signed-out Copilot says how to sign in', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'need-login' });
  const chat = await c.until((x) => x.events.some((e) => e.type === 'error'));
  assert.match(chat.events.find((e) => e.type === 'error').message, /copilot login/);
});

test('a Copilot that cannot start says so, and is not offered as an engine to switch to', { timeout: 60000 }, async (t) => {
  const c = await open(t, { POCKET_DEV_COPILOT: '/nonexistent/copilot' });
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' });
  const chat = await c.until((x) => x.events.some((e) => e.type === 'error'));
  assert.match(chat.events.find((e) => e.type === 'error').message, /Could not start Copilot/);
  assert.equal((await c.call('GET', '/api/chat/options')).data.tools.copilot.installed, false);
  const other = await open(t, { POCKET_DEV_COPILOT: '/nonexistent/copilot' }, { tool: 'antigravity', server: c.s });
  const refused = await other.call('POST', `/api/chat/${other.id}/engine`, { tool: 'copilot' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /not installed/);
});

test('only a logged-in device can use Copilot chats or switch to Copilot', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('POST', '/api/chat', { tool: 'copilot', cwd: c.s.home }, '')).status, 401);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/engine`, { tool: 'antigravity' }, '')).status, 401);
  assert.equal((await c.call('GET', `/api/chat/${c.id}`, undefined, '')).status, 401);
});

// ---- 5. Terminal shortcut, detection, setup, docs ------------------------------------------------------------------

test('the terminal shortcuts offer copilot next to claude and codex', () => {
  const server = fs.readFileSync(path.join(HERE, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /DEFAULT_SHORTCUTS = \['claude', 'codex', 'copilot'/);
});

test('Setup knows GitHub Copilot: package, command, no sign-in check, and a login note instead', async () => {
  const { TOOLS, STEP_IDS, detectTool } = await import('../src/setup/setup.js');
  const tool = TOOLS.find((x) => x.id === 'copilot');
  assert.equal(tool.bin, 'copilot');
  assert.equal(tool.npm, '@github/copilot');
  assert.equal(tool.env, 'POCKET_DEV_COPILOT');
  assert.equal(tool.optIn, true, 'an account sign-up is never pre-selected');
  assert.deepEqual(tool.login, ['login']);
  assert.equal(tool.status, undefined);
  assert.ok(STEP_IDS.includes('copilot'));
  const found = await detectTool(tool, { find: () => FAKE_COPILOT, run: async () => ({ code: 0, stdout: 'GitHub Copilot CLI 1.0.112.', stderr: '' }), childEnv: {} });
  assert.equal(found.installed, true);
  assert.equal(found.status, 'ok');
  assert.equal(found.loggedIn, null, 'Pocket Dev does not claim to know whether Copilot is signed in');
  const missing = await detectTool(tool, { find: () => null, run: async () => ({}), childEnv: {} });
  assert.equal(missing.status, 'missing');
});

test('the Admin permissions list shows Copilot as an optional tool, installed or missing', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'auth', 'permissions.js'), 'utf8');
  assert.match(src, /copilot: tool\('GitHub Copilot \(copilot\)', findBin\('copilot'\)\)/);
  assert.match(src, /id: 'copilot', group: 'tools', title: 'GitHub Copilot'/);
});

test('the docs and the phone screens list all four engines', () => {
  const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');
  for (const f of ['public/chat.js', 'public/history.js']) assert.match(read(f), /copilot: 'Copilot'/, f);
  for (const f of ['public/chat.css', 'public/history.css']) assert.match(read(f), /copilot/, f);
  assert.match(read('README.md'), /Copilot/);
  assert.match(read('docs/GUIDE.md'), /Copilot/);
  assert.match(read('docs/REFERENCE.md'), /Copilot/);
  assert.match(read('docs/SETUP.md'), /Copilot/);
});

test('a session Copilot no longer has is replaced by a new one that is given the conversation so far', { timeout: 90000 }, async (t) => {
  const c = await open(t, { POCKET_DEV_CHAT_IDLE_SECONDS: '1', FAKE_COPILOT_LOST: '1' });
  const first = await c.say('first question', 1);
  await pause(3500);
  const chat = await c.say('echo-prompt please', 2);
  assert.ok(chat.events.some((e) => e.type === 'status' && /no longer has its saved session/.test(e.text)));
  assert.notEqual(chat.sessionId, first.sessionId, 'a new session took over');
  const received = c.answers(chat).at(-1).text;
  assert.match(received, /first question/, 'the new session was given the earlier question');
  assert.match(received, /Hello from copilot/, 'and the earlier answer');
  assert.equal(chat.events.filter((e) => e.type === 'user-text' && !e.removed).length, 2);
});
