import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './isolated-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-takeover-cli-'));
const isolated = {
  POCKET_DEV_STATE_DIR: path.join(root, 'state'),
  POCKET_DEV_CLAUDE_DIR: path.join(root, 'claude', 'projects'),
  POCKET_DEV_CODEX_DIR: path.join(root, 'codex'),
};
Object.assign(process.env, isolated);
const { takeoverCommand } = await import('../takeover-cli.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ID = '5a6b7c8d-1234-4abc-8def-0123456789ab';
const NEWER = '9f8e7d6c-1234-4abc-8def-0123456789ab';
const app = path.join(root, 'app');
fs.mkdirSync(app);
const uid = process.getuid();

// Stands in for the running server's Admin API on a random local port, and checks what the CLI sends.
async function fakeAdmin(t, { items, closeStatus = 200 }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, admin: req.headers['x-pocket-admin'], type: req.headers['content-type'], body });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'GET' && req.url === '/api/state') return send(200, { sections: [{ id: 'terminals', items: [] }, { id: 'conversations', items }] });
      if (req.method === 'POST' && req.url.startsWith('/api/sections/conversations/')) {
        if (req.headers['x-pocket-admin'] !== '1' || !/^application\/json/.test(req.headers['content-type'] ?? '')) return send(403, { error: 'Missing x-pocket-admin header.' });
        return closeStatus === 200 ? send(200, { ok: true }) : send(closeStatus, { error: closeStatus === 404 ? 'Already gone' : 'Pocket Dev terminal "claude · app" did not close. Close it on the Mac, then try again.' });
      }
      send(404, { error: 'Not found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

const item = (id, activeAt, extra = {}) => ({
  id: `claude:${id}`, label: 'Ship it', tool: 'claude', conversationId: id, cwd: app, busy: false, activeAt,
  details: ['Claude in terminal "claude · app"', app, `On the Mac, run: pocket-dev takeover ${id}`], ...extra,
});

function deps(admin, events, extra = {}) {
  return {
    adminUrl: () => admin?.url ?? null,
    run: (bin, args, opts) => { events.push(['run', bin, args, opts]); return { status: 0 }; },
    listProcesses: async () => { events.push(['list']); return []; },
    claudeSessions: () => [],
    lookup: async () => null,
    ask: async () => { throw new Error('should not ask'); },
    out: (line) => events.push(['out', line]),
    err: (line) => events.push(['err', line]),
    uid, selfPid: 999_999, home: root,
    ...extra,
  };
}

test('takeover <id> closes the Pocket Dev copy, then runs claude --resume in its folder', async (t) => {
  const admin = await fakeAdmin(t, { items: [item(NEWER, 20), item(ID, 10)] });
  const events = [];
  assert.equal(await takeoverCommand([ID], deps(admin, events)), 0);
  const close = admin.calls.find((c) => c.method === 'POST');
  assert.deepEqual([close.url, close.admin, close.type, close.body], [`/api/sections/conversations/${encodeURIComponent(`claude:${ID}`)}`, '1', 'application/json', '{}']);
  assert.equal(admin.calls.filter((c) => c.method === 'POST').length, 1, 'only that conversation');
  const runs = events.filter(([e]) => e === 'run');
  assert.deepEqual(runs, [['run', 'claude', ['--resume', ID], { cwd: app, stdio: 'inherit' }]]);
  assert.ok(events.findIndex(([e]) => e === 'list') < events.findIndex(([e]) => e === 'run'), 'it checks nothing else has it open before it starts');
  assert.ok(events.some(([e, line]) => e === 'out' && line === 'Closed Pocket Dev\'s copy: Claude in terminal "claude · app".'));
});

test('takeover --last takes the most recent conversation open in Pocket Dev, and codex resumes with codex resume', async (t) => {
  const admin = await fakeAdmin(t, { items: [item(NEWER, 20, { tool: 'codex', id: `codex:${NEWER}` }), item(ID, 10)] });
  const events = [];
  assert.equal(await takeoverCommand(['--last'], deps(admin, events)), 0);
  assert.equal(admin.calls.find((c) => c.method === 'POST').url, `/api/sections/conversations/${encodeURIComponent(`codex:${NEWER}`)}`);
  assert.deepEqual(events.find(([e]) => e === 'run'), ['run', 'codex', ['resume', NEWER], { cwd: app, stdio: 'inherit' }]);

  const empty = await fakeAdmin(t, { items: [] });
  const none = [];
  assert.equal(await takeoverCommand(['--last'], deps(empty, none)), 1);
  assert.deepEqual(none, [['err', 'No conversation is open in a Pocket Dev terminal or chat.']]);
});

test('it refuses, and starts nothing, while another program still has the conversation open', async (t) => {
  const admin = await fakeAdmin(t, { items: [item(ID, 10)] });
  const events = [];
  const vscode = { pid: 2865, ppid: 1, uid, stat: 'S', started: 0, exe: '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude', args: `/Users/x/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude --resume=${ID}` };
  const code = await takeoverCommand([ID], deps(admin, events, { listProcesses: async () => [vscode] }));
  assert.equal(code, 1);
  assert.equal(events.some(([e]) => e === 'run'), false);
  assert.ok(events.some(([e, line]) => e === 'err' && line === 'This conversation is still open in Claude Code in VS Code (pid 2865). Close it there, then run this again.'));
});

test("when Pocket Dev cannot close its copy, the CLI reports why and starts nothing", async (t) => {
  const admin = await fakeAdmin(t, { items: [item(ID, 10)], closeStatus: 409 });
  const events = [];
  assert.equal(await takeoverCommand([ID], deps(admin, events)), 1);
  assert.deepEqual(events, [['err', 'Pocket Dev terminal "claude · app" did not close. Close it on the Mac, then try again.']]);

  const gone = await fakeAdmin(t, { items: [item(ID, 10)], closeStatus: 404 });
  const later = [];
  assert.equal(await takeoverCommand([ID], deps(gone, later)), 0, 'a copy that already closed is fine');
});

test('a busy copy needs a yes before it is closed', async (t) => {
  const admin = await fakeAdmin(t, { items: [item(ID, 10, { busy: true })] });
  const events = [];
  const questions = [];
  assert.equal(await takeoverCommand([ID], deps(admin, events, { ask: async (q) => { questions.push(q); return false; } })), 1);
  assert.deepEqual(questions, ['Claude is still working on this in Pocket Dev. Taking over stops that reply. Take it over? [y/N] ']);
  assert.equal(admin.calls.some((c) => c.method === 'POST'), false);
  assert.equal(events.some(([e]) => e === 'run'), false);
});

test('a conversation Pocket Dev does not have open resumes from its own record; no server is fine', async () => {
  const events = [];
  const code = await takeoverCommand([ID], deps(null, events, { lookup: async (id) => ({ tool: 'claude', id, cwd: path.join(root, 'gone') }) }));
  assert.equal(code, 0);
  assert.deepEqual(events.find(([e]) => e === 'run'), ['run', 'claude', ['--resume', ID], { cwd: root, stdio: 'inherit' }]);
  assert.ok(events.some(([e, line]) => e === 'out' && /no longer exists, so it continues in your home folder/.test(line)));
});

test('the pocket-dev command validates its arguments and finds no unknown conversation', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), ...args], { env: isolatedEnv(root, isolated), encoding: 'utf8' });
  const usage = cli('takeover');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: pocket-dev takeover <conversation id> \| --last/);
  assert.equal(cli('takeover', 'not an id').status, 2);
  const unknown = cli('takeover', ID);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, new RegExp(`No conversation ${ID}`));
  assert.match(cli('help').stdout, /takeover <id> \| --last/);
});
