import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// History reads its folders from these at call time, so a temp store stands in for ~/.claude, ~/.codex and ~/.copilot.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-copilothist-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
process.env.POCKET_DEV_CHAT_DIR = path.join(root, 'chats');
process.env.POCKET_DEV_AGY_DIR = path.join(root, 'agy');
process.env.POCKET_DEV_COPILOT_DIR = path.join(root, 'copilot', 'session-state');
const { createHistoryApi, findConversation, resumeArgv } = await import('../history.js');
const { parseWorkspace, copilotDir } = await import('../copilot-history.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ME = process.getuid();
const A = '22222222-aaaa-4bbb-8ccc-000000000001';
const B = '22222222-aaaa-4bbb-8ccc-000000000002';
const EMPTY = '22222222-aaaa-4bbb-8ccc-000000000003';
const app = path.join(root, 'my app');
fs.mkdirSync(app);

// What Copilot 1.0.112 wrote for a session: workspace.yaml and events.jsonl.
function session(id, { name, cwd = app, updated, events }) {
  const dir = path.join(copilotDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nclient_name: pocket-dev\nname: ${name}\nuser_named: false\ncreated_at: ${updated}\nupdated_at: ${updated}\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const user = (content, timestamp) => ({ type: 'user.message', data: { content, transformedContent: `<current_datetime>x</current_datetime>\n\n${content}` }, timestamp });
const assistant = (content, timestamp, extra = {}) => ({ type: 'assistant.message', data: { content, toolRequests: [], ...extra }, timestamp });
session(A, { name: 'Fix the login page', updated: '2026-11-16T11:53:21.090Z', events: [
  { type: 'session.start', data: { sessionId: A }, timestamp: '2026-11-16T11:50:00.000Z' },
  user('Fix the login page', '2026-11-16T11:50:01.000Z'),
  assistant('', '2026-11-16T11:50:02.000Z', { toolRequests: [{ name: 'view' }] }),
  assistant('The login form now validates the email.', '2026-11-16T11:53:20.000Z'),
] });
session(B, { name: 'Write the release notes', cwd: path.join(root, 'gone'), updated: '2026-11-10T08:00:00.000Z', events: [user('Write the release notes', '2026-11-10T08:00:01.000Z'), assistant('Done.', '2026-11-10T08:00:09.000Z')] });
session(EMPTY, { name: '', updated: '2026-11-16T12:30:00.000Z', events: [{ type: 'session.start', data: { sessionId: EMPTY }, timestamp: '2026-11-16T12:30:00.000Z' }] });
fs.mkdirSync(path.join(copilotDir(), 'not-a-session'), { recursive: true });

// A session written in the last few seconds counts as being worked on, which Continue on Mac asks about first.
const age = (id) => { const t = new Date(Date.now() - 60 * 60_000); fs.utimesSync(path.join(copilotDir(), id, 'events.jsonl'), t, t); };

function api({ procs = [], own, device = { id: 'dev1', name: 'Pixel 8', ip: '192.168.1.20' } } = {}) {
  const sessions = [];
  const signals = [];
  const logged = [];
  const table = new Map(procs.map((p) => [p.pid, p]));
  const handle = createHistoryApi({
    createSession: async (cwd, title, command) => { const s = { id: 'term1', title, cwd, command }; sessions.push(s); return s; },
    sessionView: (s) => s,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {},
    deviceFor: () => device,
    log: (type, fields) => logged.push({ type, ...fields }),
    own,
    system: { listProcesses: async () => [...table.values()], kill(pid, signal) { signals.push([pid, signal]); table.delete(pid); }, sleep: async () => {}, uid: ME, selfPid: 999_999 },
  });
  const call = async (method, url, body) => {
    const res = {};
    await handle({ method, url, headers: {}, body }, res, url.split('?')[0]);
    return res;
  };
  return { call, sessions, signals, logged, handle, table };
}

test('workspace.yaml is read as plain key: value lines', () => {
  assert.deepEqual(parseWorkspace('id: x\ncwd: /a b\nname: "Quoted: yes"\nnot a pair\n'), { id: 'x', cwd: '/a b', name: 'Quoted: yes' });
});

test('the Resume list shows Copilot sessions with title, folder and message count, and leaves out empty ones', async () => {
  const res = await api().call('GET', '/api/history?tool=copilot');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((s) => s.id), [A, B]);
  const [first, old] = res.body;
  assert.equal(first.tool, 'copilot');
  assert.equal(first.title, 'Fix the login page');
  assert.equal(first.cwd, app);
  assert.equal(first.project, 'my app');
  assert.equal(first.messageCount, 2, 'an assistant turn that only asks for tools is not a message');
  assert.equal(first.lastActive, '2026-11-16T11:53:21.090Z');
  assert.equal(old.title, 'Write the release notes');
});

test('all, the filter and an unknown tool: Copilot sits next to the other three', async () => {
  const t = api();
  const all = await t.call('GET', '/api/history');
  assert.ok(all.body.some((s) => s.tool === 'copilot'));
  assert.deepEqual((await t.call('GET', '/api/history?tool=claude')).body, []);
  const bad = await t.call('GET', '/api/history?tool=gemini');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /claude, codex, antigravity or copilot/);
});

test('the detail shows the real messages Copilot recorded, user and assistant only', async () => {
  const res = await api().call('GET', `/api/history/copilot/${A}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.messages.map((m) => [m.role, m.text]), [['user', 'Fix the login page'], ['assistant', 'The login form now validates the email.']]);
  assert.equal(res.body.note, undefined, 'nothing is hidden, so there is no note');
  assert.equal((await api().call('GET', `/api/history/copilot/${EMPTY}`)).status, 404, 'a session with no messages is not one to open');
});

test('Open here in a terminal resumes it with copilot --resume in its folder', async () => {
  const t = api();
  const res = await t.call('POST', `/api/history/copilot/${A}/resume`);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(t.sessions[0], { id: 'term1', title: 'copilot · my app', cwd: app, command: `copilot --resume ${A}` });
  assert.deepEqual(resumeArgv('copilot', A), ['copilot', ['--resume', A]]);
});

test('a session whose folder is gone opens in the home folder and says so', async () => {
  const t = api();
  const res = await t.call('POST', `/api/history/copilot/${B}/resume`);
  assert.equal(res.status, 201);
  assert.equal(t.sessions[0].cwd, os.homedir());
  assert.match(res.body.note, /no longer exists|home folder/);
});

test('names that are not a conversation id never reach the files', async () => {
  const t = api();
  for (const id of ['..', '../../etc/passwd', 'x'.repeat(65), 'short', 'not-a-session']) {
    const res = await t.call('GET', `/api/history/copilot/${encodeURIComponent(id)}`);
    assert.ok([400, 404].includes(res.status), `${id} gave ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  assert.equal((await t.call('GET', '/api/history/copilot/22222222-aaaa-4bbb-8ccc-999999999999')).status, 404);
});

test('the CLI finds a Copilot session by its id', async () => {
  assert.deepEqual(await findConversation(A), { tool: 'copilot', id: A, cwd: app });
});

test('Continue on Mac closes only Pocket Dev copies of a Copilot session and names the resume command', async () => {
  age(A);
  const shell = { pid: 7001, ppid: 1, uid: ME, stat: 'S', started: 0, exe: '/bin/zsh', args: '/bin/zsh -l' };
  const inTerminal = { pid: 7002, ppid: 7001, uid: ME, stat: 'S', started: 0, exe: '/usr/local/bin/copilot', args: `copilot --resume ${A}` };
  const onMac = { pid: 8000, ppid: 1, uid: ME, stat: 'S', started: 0, exe: '/usr/local/bin/copilot', args: `copilot --resume ${B}` };
  const ended = [];
  let t;
  const own = {
    terminals: () => [{ id: 'term9', title: 'copilot · my app', cwd: app, pid: 7001, activeAt: 5 }],
    endTerminal: (id, note) => { ended.push([id, note]); t.table.delete(7002); return true; },
  };
  t = api({ procs: [shell, inTerminal, onMac], own });
  const res = await t.call('POST', '/api/history/mac', { terminalId: 'term9' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.tool, res.body.id, res.body.cwd, res.body.command], ['copilot', A, app, `copilot --resume ${A}`]);
  assert.deepEqual(ended, [['term9', 'Continued on your Mac']]);
  assert.deepEqual(t.signals, [], 'take over sent no signal; the other copilot on the Mac was left alone');
  assert.ok(t.table.has(8000));
});

test('Continue on Mac for a Copilot chat releases the chat, and "Open in Pocket Dev" lists it with the resume command', async () => {
  age(A);
  const released = [];
  const open = [{ id: 'chat1', title: 'Fix the login page', tool: 'copilot', sessionId: A, cwd: app, updatedAt: 5 }];
  const own = {
    chats: () => open,
    releaseChat: async (id, note) => { released.push([id, note]); open.length = 0; return true; },
  };
  const t = api({ own });
  const items = await t.handle.openHere.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `copilot:${A}`);
  assert.match(items[0].details[0], /^Copilot in /);
  assert.ok(items[0].details.includes(`Then run: copilot --resume ${A}`));
  const res = await t.call('POST', '/api/history/mac', { tool: 'copilot', id: A });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.command, `copilot --resume ${A}`);
  assert.deepEqual(released, [['chat1', 'Continued on your Mac']]);
});

test('Copilot is found as a program on a command line, however it was started', async () => {
  const { resumeTarget } = await import('../takeover.js');
  const mk = (exe, args) => ({ pid: 1, ppid: 0, uid: ME, stat: 'S', started: 0, exe, args: `${exe} ${args}` });
  assert.deepEqual(resumeTarget(mk('/usr/local/bin/copilot', `--resume ${A}`)), { tool: 'copilot', id: A });
  assert.deepEqual(resumeTarget(mk('/usr/local/bin/copilot', `-r=${A}`)), { tool: 'copilot', id: A });
  assert.deepEqual(resumeTarget(mk('/usr/local/bin/node', `/usr/local/lib/node_modules/@github/copilot/npm-loader.js --session-id ${A}`)), { tool: 'copilot', id: A });
  assert.equal(resumeTarget(mk('/usr/local/bin/copilot', '--continue')), null, 'a bare --continue names no session');
  assert.equal(resumeTarget(mk('/usr/bin/grep', `${A} somefile`)), null, 'a reader is not a copy');
});

test("Copilot's own files are only read: nothing is changed or added in its folder", async () => {
  const snapshot = () => fs.readdirSync(copilotDir(), { recursive: true }).sort().map((f) => { const p = path.join(copilotDir(), String(f)); const st = fs.statSync(p); return `${f}:${st.size}:${st.mtimeMs}`; });
  const before = snapshot();
  await api().call('GET', '/api/history?tool=copilot');
  await api().call('GET', `/api/history/copilot/${A}`);
  assert.deepEqual(snapshot(), before);
});
