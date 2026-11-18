import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// History reads its folders from these at call time, so a temp store stands in for ~/.claude and ~/.codex.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-takeover-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
process.env.POCKET_DEV_CHAT_DIR = path.join(root, 'chats');
const { createHistoryApi, findConversation } = await import('../history.js');
const { createChatApi } = await import('../chat/index.js');
// A chat saves itself a second after it changes, so the store stays until those saves are done.
test.after(async () => { await new Promise((r) => setTimeout(r, 1500)); fs.rmSync(root, { recursive: true, force: true }); });

const ME = process.getuid();
const ID = '0b3c1d2e-1111-4222-8333-944455556666';
const app = path.join(root, 'app');
fs.mkdirSync(app);
const file = path.join(process.env.POCKET_DEV_CLAUDE_DIR, app.replace(/[^A-Za-z0-9]/g, '-'), `${ID}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: app, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Fix the login page' } })}\n`);
const age = (ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };

// Made-up processes only: the listing and the signals never touch the real system.
function fakeSystem(procs) {
  const table = new Map(procs.map((p) => [p.pid, p]));
  const signals = [];
  return {
    signals,
    listProcesses: async () => [...table.values()],
    kill(pid, signal) { signals.push([pid, signal]); table.delete(pid); },
    sleep: async () => {},
    uid: ME,
    selfPid: 999_999,
  };
}
const vscode = { pid: 2865, ppid: 2242, uid: ME, stat: 'S', started: 0, exe: '/Users/ani/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude', args: `/Users/ani/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude --resume=${ID}` };

function api({ procs = [vscode], device = { id: 'dev1', name: 'Pixel 8', ip: '192.168.1.20' }, own } = {}) {
  const system = fakeSystem(procs);
  const logged = [];
  const handle = createHistoryApi({
    createSession: async (cwd, title, command) => ({ id: 'term1', title, cwd, command }),
    sessionView: (s) => s,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {},
    deviceFor: () => device,
    log: (type, fields) => logged.push({ type, ...fields }),
    own, system,
  });
  const call = async (method, url, body) => {
    const res = {};
    await handle({ method, url, headers: {}, body }, res, url.split('?')[0]);
    return res;
  };
  return { call, system, logged, handle };
}

test('the detail says where the conversation is open, and the list badge follows', async () => {
  age(60 * 60_000);
  const { call } = api();
  const detail = await call('GET', `/api/history/claude/${ID}`);
  assert.equal(detail.status, 200);
  assert.deepEqual([detail.body.live, detail.body.openIn, detail.body.busy], [true, 'mac', false]);
  assert.deepEqual(detail.body.copies, [{ kind: 'process', pid: 2865, label: 'Claude Code in VS Code (pid 2865)' }]);
  const list = await call('GET', '/api/history?tool=claude');
  assert.deepEqual(list.body.map((s) => [s.id, s.live, s.openIn]), [[ID, true, 'mac']]);
  const closed = await api({ procs: [] }).call('GET', `/api/history/claude/${ID}`);
  assert.deepEqual([closed.body.live, closed.body.openIn], [false, null]);
});

test('POST takeover stops the Mac copy, returns what it stopped, and logs the device', async () => {
  age(60 * 60_000);
  const { call, system, logged } = api();
  const r = await call('POST', `/api/history/claude/${ID}/takeover`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { busy: false, stopped: [{ kind: 'process', pid: 2865, label: 'Claude Code in VS Code (pid 2865)', signals: ['SIGINT'] }] });
  assert.deepEqual(system.signals, [[2865, 'SIGINT']]);
  assert.deepEqual(logged, [{ type: 'conversation-taken-over', tool: 'claude', conversationId: ID, pids: [2865], stopped: ['process'], force: false, by: 'phone', deviceId: 'dev1', name: 'Pixel 8', ip: '192.168.1.20' }]);
});

test('POST takeover: busy needs confirmBusy, bad flags are refused, and no device means no signal', async () => {
  age(2000);
  const busy = api();
  const first = await busy.call('POST', `/api/history/claude/${ID}/takeover`, {});
  assert.deepEqual([first.status, first.body.code, first.body.busy], [409, 'busy', true]);
  assert.deepEqual(busy.system.signals, []);
  const second = await busy.call('POST', `/api/history/claude/${ID}/takeover`, { confirmBusy: true });
  assert.equal(second.status, 200);
  assert.deepEqual(busy.system.signals, [[2865, 'SIGINT']]);

  age(60 * 60_000);
  const bad = api();
  await assert.rejects(bad.call('POST', `/api/history/claude/${ID}/takeover`, { force: 'yes' }), /force must be true or false/);
  assert.deepEqual(bad.system.signals, []);

  const nobody = api({ device: null });
  const refused = await nobody.call('POST', `/api/history/claude/${ID}/takeover`, {});
  assert.equal(refused.status, 403);
  assert.deepEqual(nobody.system.signals, []);
});

test('the Open in Pocket Dev section lists Pocket Dev copies with the resume command, and Continue on Mac closes only those', async () => {
  age(60 * 60_000);
  const shell = { pid: 7001, ppid: 1, uid: ME, stat: 'S', started: 0, exe: '/bin/zsh', args: '/bin/zsh -l' };
  const inTerminal = { pid: 7002, ppid: 7001, uid: ME, stat: 'S', started: 0, exe: '/usr/local/bin/claude', args: `claude --resume ${ID}` };
  const ended = [];
  let system;
  const own = {
    terminals: () => [{ id: 'term9', title: 'claude · app', cwd: app, pid: 7001, activeAt: 5 }],
    endTerminal: (id, note) => { ended.push([id, note]); system.kill(7002, 'SIGHUP'); return true; },
  };
  const t = api({ procs: [vscode, shell, inTerminal], own });
  system = t.system;
  const items = await t.handle.openHere.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].details[0], 'Claude in terminal "claude · app"', 'the VS Code copy is not a Pocket Dev copy');
  assert.equal(items[0].id, `claude:${ID}`);
  assert.equal(items[0].label, 'Fix the login page');
  assert.equal(items[0].cwd, app);
  assert.ok(items[0].details.includes(`Then run: claude --resume ${ID}`));
  assert.equal(await t.handle.openHere.act(`claude:${ID}`), true);
  assert.deepEqual(ended, [['term9', 'Continued on your Mac']]);
  assert.deepEqual(system.signals, [[7002, 'SIGHUP']], 'take over itself sent nothing; VS Code was left alone');
  assert.equal(t.logged[0].by, 'mac');
  assert.equal(await t.handle.openHere.act('claude:not-a-real-id!'), false);
});

test('Continue on Mac closes only Pocket Dev copies, names the resume command, and leaves VS Code alone', async () => {
  age(60 * 60_000);
  const shell = { pid: 7001, ppid: 1, uid: ME, stat: 'S', started: 0, exe: '/bin/zsh', args: '/bin/zsh -l' };
  const inTerminal = { pid: 7002, ppid: 7001, uid: ME, stat: 'S', started: 0, exe: '/usr/local/bin/claude', args: `claude --resume ${ID}` };
  const ended = [];
  let system;
  const own = {
    terminals: () => [{ id: 'term9', title: 'claude · app', cwd: app, pid: 7001, activeAt: 5 }],
    endTerminal: (id, note) => { ended.push([id, note]); system.kill(7002, 'SIGHUP'); return true; },
  };
  const t = api({ procs: [vscode, shell, inTerminal], own });
  system = t.system;

  const byTerminal = await t.call('POST', '/api/history/mac', { terminalId: 'term9' });
  assert.equal(byTerminal.status, 200, JSON.stringify(byTerminal.body));
  assert.deepEqual([byTerminal.body.tool, byTerminal.body.id, byTerminal.body.cwd, byTerminal.body.command], ['claude', ID, app, `claude --resume ${ID}`]);
  assert.deepEqual(ended, [['term9', 'Continued on your Mac']]);
  assert.deepEqual(system.signals, [[7002, 'SIGHUP']], 'VS Code was left alone');
  assert.deepEqual([t.logged[0].type, t.logged[0].by, t.logged[0].deviceId], ['conversation-taken-over', 'phone', 'dev1']);

  const none = await t.call('POST', '/api/history/mac', { terminalId: 'term-unknown' });
  assert.equal(none.status, 404);
});

test('Continue on Mac for a chat that is asleep has nothing to close and still gives the command', async () => {
  age(60 * 60_000);
  const t = api({ procs: [] });
  const r = await t.call('POST', '/api/history/mac', { tool: 'claude', id: ID });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.stopped, r.body.command, r.body.cwd], [[], `claude --resume ${ID}`, app]);
  const codex = await t.call('POST', '/api/history/mac', { tool: 'codex', id: '0b3c1d2e-9999-4222-8333-944455556666' });
  assert.equal(codex.status, 404, 'no history file means nothing to resume');
});

test('Continue on Mac: a reply in progress needs one yes, a bad request or a stranger signals nothing', async () => {
  age(2000);
  const shell = { pid: 7001, ppid: 1, uid: ME, stat: 'S', started: 0, exe: '/bin/zsh', args: '/bin/zsh -l' };
  const inTerminal = { pid: 7002, ppid: 7001, uid: ME, stat: 'S', started: 0, exe: '/usr/local/bin/claude', args: `claude --resume ${ID}` };
  let system;
  const own = { terminals: () => [{ id: 'term9', title: 'claude · app', cwd: app, pid: 7001, activeAt: 5 }], endTerminal: () => { system.kill(7002, 'SIGHUP'); return true; } };
  const busy = api({ procs: [shell, inTerminal], own });
  system = busy.system;
  const first = await busy.call('POST', '/api/history/mac', { terminalId: 'term9' });
  assert.deepEqual([first.status, first.body.code], [409, 'busy']);
  assert.match(first.body.error, /still replying in a Pocket Dev terminal\. Continuing stops that reply\./);
  const second = await busy.call('POST', '/api/history/mac', { terminalId: 'term9', confirmBusy: true });
  assert.equal(second.status, 200);

  const quiet = api({ procs: [] });
  assert.equal((await quiet.call('POST', '/api/history/mac', {})).status, 400);
  assert.equal((await quiet.call('POST', '/api/history/mac', { tool: 'claude', id: '../etc' })).status, 400);
  assert.equal((await quiet.call('POST', '/api/history/mac', { tool: 'nope', id: ID })).status, 400);
  const stranger = api({ device: null, procs: [vscode] });
  assert.equal((await stranger.call('POST', '/api/history/mac', { tool: 'claude', id: ID })).status, 403);
  assert.deepEqual(stranger.system.signals, []);
});

test('findConversation looks an id up in either tool', async () => {
  assert.deepEqual(await findConversation(ID), { tool: 'claude', id: ID, cwd: app });
  assert.equal(await findConversation('0b3c1d2e-0000-4222-8333-944455556666'), null);
  assert.equal(await findConversation('../etc'), null);
});

test("a chat's copy closes through the chat API: the turn stops, waiting messages are held, and the chat says why", async () => {
  const calls = [];
  const engines = {
    claude: {
      label: 'Claude', settingsSchema: async () => [], grantLabel: (g) => g, projectRules: () => [],
      create: () => ({
        start: async () => calls.push('start'),
        send: async () => calls.push('send'),
        interrupt: async () => calls.push('interrupt'),
        stop: async () => calls.push('stop'),
        configure: async () => ({}),
      }),
    },
  };
  const config = { data: {}, read() { return this.data; }, update(c) { Object.assign(this.data, c); } };
  const chatApi = createChatApi({ sendJson: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body, config, wss: null, engines });
  const call = async (method, url, body) => {
    const res = {};
    await chatApi.handleApi({ method, url, headers: {}, body }, res, url);
    return res;
  };
  const created = await call('POST', '/api/chat', { tool: 'claude', cwd: app, resume: { sessionId: ID } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const chatId = created.body.id;
  await call('POST', `/api/chat/${chatId}/message`, { text: 'keep going' });
  await new Promise((resolve) => setImmediate(resolve));
  await call('POST', `/api/chat/${chatId}/message`, { text: 'and then this' });
  assert.deepEqual(chatApi.bound().map((c) => [c.id, c.sessionId]), [[chatId, ID]]);

  assert.equal(await chatApi.release(chatId, 'Continued on your Mac'), true);
  assert.deepEqual(calls, ['start', 'send', 'interrupt', 'stop']);
  assert.deepEqual(chatApi.bound(), [], 'nothing in Pocket Dev has the conversation open now');
  const { body } = await call('GET', `/api/chat/${chatId}`);
  assert.equal(body.events.at(-1).text, 'Continued on your Mac');
  assert.equal(body.events.find((e) => e.text === 'and then this').notSent, true, 'the waiting message was not sent');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.filter((c) => c === 'start').length, 1, 'and the engine did not wake again');
  assert.equal(await chatApi.release('ffffffffffff', 'x'), false);
});

// The chat API and the history API wired as server.js wires them, over a made-up process table where one VS Code Claude
// holds the conversation and says through its session file whether it is replying.
const HELD = '0b3c1d2e-2222-4222-8333-944455556666';
const heldFile = path.join(process.env.POCKET_DEV_CLAUDE_DIR, app.replace(/[^A-Za-z0-9]/g, '-'), `${HELD}.jsonl`);
const line = (o) => fs.appendFileSync(heldFile, `${JSON.stringify(o)}\n`);
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

function heldSetup({ took } = {}) {
  process.env.POCKET_DEV_CHAT_DIR = fs.mkdtempSync(path.join(root, 'chats-'));
  fs.writeFileSync(heldFile, `${JSON.stringify({ type: 'user', cwd: app, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Refactor the parser' } })}\n`);
  const sent = [];
  const engines = {
    claude: {
      label: 'Claude', grantLabel: (g) => g, projectRules: () => [],
      settingsSchema: async () => [{ key: 'model', label: 'Model', default: 'opus', custom: true, choices: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] }],
      create: () => ({ start: async () => {}, send: async (input) => sent.push(input.text), interrupt: async () => {}, stop: async () => {}, configure: async () => ({}) }),
    },
  };
  engines.codex = { ...engines.claude, label: 'Codex' };
  const config = { data: {}, read() { return this.data; }, update(c) { Object.assign(this.data, c); } };
  const chatApi = createChatApi({ sendJson: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body, config, wss: null, engines });
  const holder = { pid: 3100, ppid: 1, uid: ME, stat: 'S', started: 0, exe: vscode.exe, args: vscode.exe };
  const session = { pid: holder.pid, sessionId: HELD, startedAt: 1000, status: 'busy' };
  const fake = fakeSystem([holder]);
  // `took` stands in for Windows, where a stop can end up as an immediate end (see winKill).
  const system = { ...fake, claudeSessions: () => [session], kill: (pid, signal) => { fake.kill(pid, signal); return took; } };
  const history = createHistoryApi({
    createSession: async () => {}, sessionView: (s) => s, sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {}, deviceFor: () => ({ id: 'dev1' }), log: () => {}, system,
    listChats: () => chatApi.list(), own: { chats: () => chatApi.bound(), releaseChat: (id, note) => chatApi.release(id, note) },
    resumeChat: (c) => chatApi.resumeSession(c), mirrorChat: (id, m, a) => chatApi.mirrorNative(id, m, a), endChatHold: (id, h) => chatApi.endHold(id, h),
    handoverTickMs: 15,
  });
  const call = async (handle, method, url, body) => {
    const res = {};
    await handle({ method, url, headers: {}, body }, res, url.split('?')[0]);
    return res;
  };
  const chat = (method, url, body) => call(chatApi.handleApi, method, url, body);
  const open = () => call(history, 'POST', `/api/history/claude/${HELD}/open-chat`, {});
  const get = async (id) => (await chat('GET', `/api/chat/${id}`)).body;
  return { chatApi, chat, open, get, sent, session, signals: system.signals, holder };
}

test('a busy Mac reply opens the chat at once, held: messages queue, the model waits, and the idle holder hands over by itself', async () => {
  const t = heldSetup();
  const opened = await t.open();
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const { id } = opened.body.chat;
  assert.equal(opened.body.chat.held, 'Claude Code in VS Code');
  assert.deepEqual(t.signals, [], 'the reply on the Mac is not stopped');
  assert.equal((await t.open()).body.chat.id, id, 'a second tap opens the same held chat');

  const queued = await t.chat('POST', `/api/chat/${id}/message`, { text: 'then add tests' });
  assert.deepEqual([queued.status, queued.body.queued], [202, 1]);
  const model = await t.chat('PATCH', `/api/chat/${id}`, { settings: { model: 'sonnet' } });
  assert.deepEqual([model.status, model.body.error], [409, 'The model can change once Claude Code in VS Code finishes.']);
  const provider = await t.chat('POST', `/api/chat/${id}/engine`, { tool: 'codex' });
  assert.deepEqual([provider.status, provider.body.error], [409, 'Claude Code in VS Code is finishing on your computer. Wait for it before switching the provider.']);

  const before = (await t.get(id)).events.length;
  line({ type: 'assistant', timestamp: '2026-11-01T10:00:05Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  await until(async () => (await t.get(id)).heldActivity === '▶ ran Bash: npm test', 'the tool step to show');
  assert.equal((await t.get(id)).events.length, before, 'a tool step is not a chat event');
  line({ type: 'assistant', timestamp: '2026-11-01T10:00:09Z', message: { content: [{ type: 'text', text: 'All 40 tests pass.' }] } });
  await until(async () => (await t.get(id)).events.some((e) => e.text === 'All 40 tests pass.'), 'the Mac reply to appear');
  assert.equal((await t.get(id)).heldActivity, null, 'a message ends the step');
  assert.deepEqual(t.sent, [], 'nothing is sent while the Mac holds the conversation');

  t.session.status = 'idle';
  await until(async () => (await t.get(id)).held === null, 'the hand over');
  assert.deepEqual(t.signals, [[t.holder.pid, 'SIGINT']]);
  await until(() => t.sent.length === 1, 'the queued message to go out');
  assert.deepEqual(t.sent, ['then add tests']);
  const view = await t.get(id);
  assert.ok(view.events.some((e) => e.type === 'status' && e.text === 'Continued here from your Mac'));
  assert.equal((await t.chat('PATCH', `/api/chat/${id}`, { settings: { model: 'sonnet' } })).status, 200, 'the model can change again');
});

test('queued messages can be edited and removed while the chat is held', async () => {
  const t = heldSetup();
  const { id } = (await t.open()).body.chat;
  await t.chat('POST', `/api/chat/${id}/message`, { text: 'first' });
  await t.chat('POST', `/api/chat/${id}/message`, { text: 'second' });
  const [first, second] = (await t.get(id)).events.filter((e) => e.queued);
  const edited = await t.chat('PATCH', `/api/chat/${id}/queue`, { eventId: first.id, text: 'first, edited', expectedText: 'first' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const removed = await t.chat('DELETE', `/api/chat/${id}/queue`, { eventId: second.id });
  assert.deepEqual([removed.status, removed.body.queued, removed.body.held], [200, 1, 'Claude Code in VS Code']);
  t.session.status = 'idle';
  await until(() => t.sent.length === 1, 'the queue to drain');
  assert.deepEqual(t.sent, ['first, edited']);
});

test('Stop on a held chat stops the Mac reply with SIGINT, takes over, and sends the queued message', async () => {
  const t = heldSetup();
  const { id } = (await t.open()).body.chat;
  await t.chat('POST', `/api/chat/${id}/message`, { text: 'do this instead' });
  const stop = await t.chat('POST', `/api/chat/${id}/interrupt`);
  assert.equal(stop.status, 200);
  await until(async () => (await t.get(id)).held === null, 'the hold to end');
  assert.deepEqual(t.signals, [[t.holder.pid, 'SIGINT']], 'the busy holder gets SIGINT to finish its write, as a confirmed take over');
  await until(() => t.sent.length === 1, 'the queued message to go out');
  assert.deepEqual(t.sent, ['do this instead']);
  assert.ok((await t.get(id)).events.some((e) => e.text === 'Stopped the reply on your Mac. The conversation continues here.'));
});

test('a chat still held when Pocket Dev restarts comes back released, with its waiting messages not sent', async () => {
  const t = heldSetup();
  const { id } = (await t.open()).body.chat;
  await t.chat('POST', `/api/chat/${id}/message`, { text: 'later' });
  t.chatApi.list();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.POCKET_DEV_CHAT_DIR, `${id}.json`), 'utf8'));
  assert.equal(saved.nativeHeld, 'Claude Code in VS Code', 'the hold is saved');
  const config = { data: {}, read() { return this.data; }, update() {} };
  const engines = { claude: { label: 'Claude', settingsSchema: async () => [], grantLabel: (g) => g, projectRules: () => [], create: () => assert.fail('no engine wakes') } };
  const restarted = createChatApi({ sendJson: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body, config, wss: null, engines });
  const res = {};
  await restarted.handleApi({ method: 'GET', url: `/api/chat/${id}`, headers: {} }, res, `/api/chat/${id}`);
  assert.deepEqual([res.body.held, res.body.nativeReleased], [null, true]);
  assert.equal(res.body.events.find((e) => e.text === 'later').notSent, true);
  assert.match(res.body.events.at(-1).text, /restarted before Claude Code in VS Code finished/);
  t.session.status = 'idle';
});

test('a Stop that had to end the program at once (Windows, no console) says its last step may be lost', async () => {
  const t = heldSetup({ took: 'SIGKILL' });
  const { id } = (await t.open()).body.chat;
  await t.chat('POST', `/api/chat/${id}/interrupt`);
  await until(async () => (await t.get(id)).held === null, 'the hold to end');
  assert.ok((await t.get(id)).events.some((e) => e.text === 'Stopped the reply on your Mac. Its last step may be lost. The conversation continues here.'));
});
