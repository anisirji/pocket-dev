import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-review-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
process.env.POCKET_DEV_CHAT_DIR = path.join(root, 'chats');
const { createHistoryApi } = await import('../history.js');
const { createChatApi } = await import('../chat/index.js');
test.after(async () => { await new Promise((r) => setTimeout(r, 1500)); fs.rmSync(root, { recursive: true, force: true }); });

const ME = process.getuid();
const HELD = '0b3c1d2e-2222-4222-8333-944455556666';
const app = path.join(root, 'app');
fs.mkdirSync(app);
const heldFile = path.join(process.env.POCKET_DEV_CLAUDE_DIR, app.replace(/[^A-Za-z0-9]/g, '-'), `${HELD}.jsonl`);
fs.mkdirSync(path.dirname(heldFile), { recursive: true });
fs.writeFileSync(heldFile, `${JSON.stringify({ type: 'user', cwd: app, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Refactor the parser' } })}\n`);
const old = new Date(Date.now() - 60 * 60_000);
fs.utimesSync(heldFile, old, old);
const vscodeExe = '/Users/ani/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude';

const until = async (check, what) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

function fakeSystem(procs) {
  const table = new Map(procs.map((p) => [p.pid, p]));
  const signals = [];
  return { signals, listProcesses: async () => [...table.values()], kill(pid, signal) { signals.push([pid, signal]); table.delete(pid); }, sleep: async () => {}, uid: ME, selfPid: 999_999 };
}

test('a chat awake on the phone while the Mac replies: the hold puts its engine to sleep, and the hand over sends the queued message', async () => {
  const sent = [];
  const calls = [];
  const engines = {
    claude: {
      label: 'Claude', grantLabel: (g) => g, projectRules: () => [],
      settingsSchema: async () => [{ key: 'model', label: 'Model', default: 'opus', custom: true, choices: [{ value: 'opus', label: 'Opus' }] }],
      create: (chat) => ({
        start: async () => { calls.push('start'); },
        send: async (input) => { sent.push(input.text); chat.endTurn({ status: 'done', durationMs: 1 }); },
        interrupt: async () => {}, stop: async () => { calls.push('stop'); }, configure: async () => ({}),
      }),
    },
  };
  const config = { data: {}, read() { return this.data; }, update(c) { Object.assign(this.data, c); } };
  const chatApi = createChatApi({ sendJson: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body, config, wss: null, engines });
  const call = async (handle, method, url, body) => { const res = {}; await handle({ method, url, headers: {}, body }, res, url.split('?')[0]); return res; };
  const chat = (method, url, body) => call(chatApi.handleApi, method, url, body);

  // 1. The person uses the chat on the phone. Its engine wakes and stays awake, idle, after the reply.
  const created = await chat('POST', '/api/chat/', { tool: 'claude', cwd: app, resume: { sessionId: HELD } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  await chat('POST', `/api/chat/${id}/message`, { text: 'hello from the phone' });
  await until(() => sent.length === 1, 'the first reply');
  assert.deepEqual(chatApi.bound().map((c) => c.id), [id], 'the engine is awake and idle: the chat is a bound copy');

  // 2. Meanwhile a Claude Code in VS Code resumed the same conversation on the Mac and is replying.
  const holder = { pid: 3100, ppid: 1, uid: ME, stat: 'S', started: 0, exe: vscodeExe, args: vscodeExe };
  const session = { pid: holder.pid, sessionId: HELD, startedAt: 1000, status: 'busy' };
  const fake = fakeSystem([holder]);
  const system = { ...fake, claudeSessions: () => [session] };
  const history = createHistoryApi({
    createSession: async () => {}, sessionView: (s) => s, sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {}, deviceFor: () => ({ id: 'dev1' }), log: () => {}, system,
    listChats: () => chatApi.list(), own: { chats: () => chatApi.bound(), releaseChat: (i, note) => chatApi.release(i, note) },
    resumeChat: (c) => chatApi.resumeSession(c), mirrorChat: (i, m, a) => chatApi.mirrorNative(i, m, a), endChatHold: (i, h) => chatApi.endHold(i, h),
    handoverTickMs: 15, closedCheckMs: 15,
  });

  // 3. The person taps the chat row in Chats (public/chat.js:605 calls open-chat for a chat with a sessionId).
  const opened = await call(history, 'POST', `/api/history/claude/${HELD}/open-chat`, {});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.chat.id, id, 'the same chat');
  assert.equal(opened.body.chat.held, 'Claude Code in VS Code');
  assert.deepEqual(chatApi.bound(), [], 'the hold put the engine to sleep, so the chat is not a second copy');

  // 4. They queue a message for after the Mac finishes.
  const queued = await chat('POST', `/api/chat/${id}/message`, { text: 'then add tests' });
  assert.deepEqual([queued.status, queued.body.queued], [202, 1]);

  // 5. The Mac goes idle. The watcher takes over.
  session.status = 'idle';
  await until(async () => (await chat('GET', `/api/chat/${id}`)).body.held === null, 'the hand over');
  await new Promise((r) => setTimeout(r, 100));
  const view = (await chat('GET', `/api/chat/${id}`)).body;
  const queuedEvent = view.events.find((e) => e.text === 'then add tests');
  assert.deepEqual(fake.signals, [[3100, 'SIGINT']], 'only the Mac program is stopped');
  assert.equal(queuedEvent.notSent, undefined, 'the queued message is not marked not sent');
  assert.ok(!view.events.some((e) => e.text === 'Continued in Pocket Dev chat'), 'this chat was never closed as a copy');
  assert.deepEqual(sent, ['hello from the phone', 'then add tests'], 'the queued message goes out after the hand over');
});
