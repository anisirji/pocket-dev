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
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

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

test('the Open in Pocket Dev section lists Pocket Dev copies with the Mac command, and act closes only those', async () => {
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
  assert.ok(items[0].details.includes(`On the Mac, run: pocket-dev takeover ${ID}`));
  assert.equal(await t.handle.openHere.act(`claude:${ID}`), true);
  assert.deepEqual(ended, [['term9', 'Continued on your Mac']]);
  assert.deepEqual(system.signals, [[7002, 'SIGHUP']], 'take over itself sent nothing; VS Code was left alone');
  assert.equal(t.logged[0].by, 'mac');
  assert.equal(await t.handle.openHere.act('claude:not-a-real-id!'), false);
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
