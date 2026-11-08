import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(50); }
  assert.fail('Condition timed out');
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The server reads its process table from POCKET_DEV_PROCESS_FIXTURE and records signals there, so take over never
// lists or signals a real process. Only the server's own test shell ends, through the terminal API.
test('take over through the real server: owner only, CSRF header, security log, and a Pocket Dev terminal closed by its API', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-takeover-server-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const app = path.join(home, 'app');
  fs.mkdirSync(app, { recursive: true });
  const ID = '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
  const conversation = path.join(home, '.claude', 'projects', app.replace(/[^A-Za-z0-9]/g, '-'), `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(conversation), { recursive: true });
  fs.writeFileSync(conversation, `${JSON.stringify({ type: 'user', cwd: app, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Ship the release' } })}\n`);
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(conversation, old, old);

  const fixture = path.join(root, 'processes.json');
  const uid = process.getuid();
  const vscode = { pid: 912865, ppid: 912242, uid, stat: 'S', started: 0, exe: '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude', args: `/Users/x/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude --resume=${ID}` };
  const writeTable = (table) => fs.writeFileSync(fixture, JSON.stringify(table));
  const readTable = () => JSON.parse(fs.readFileSync(fixture, 'utf8'));
  writeTable({ processes: [vscode] });

  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ password: 'test-password', awake: 'off', fileRoots: [home] }));
  const stub = path.join(root, 'stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "No\\n"\n', { mode: 0o700 });
  const port = await freePort(), adminPort = await freePort();
  const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: {
    ...process.env, HOME: home, SHELL: '/bin/zsh', PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: config,
    POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1', POCKET_DEV_TERMINAL_HOST: 'off', POCKET_DEV_PROCESS_FIXTURE: fixture,
    POCKET_DEV_CLAUDE: '/nonexistent/claude', POCKET_DEV_CODEX: '/nonexistent/codex', POCKET_DEV_CLAUDE_DIR: '', POCKET_DEV_CODEX_DIR: '',
    POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub, POCKET_DEV_TOP: stub, POCKET_DEV_MEMORY_PRESSURE: stub, POCKET_DEV_UPDATE_CHECK: stub, POCKET_DEV_OSASCRIPT: stub,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const sockets = new Set();
  t.after(async () => {
    for (const s of sockets) s.terminate();
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), pause(5000).then(() => proc.kill('SIGKILL'))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => { assert.equal(proc.exitCode, null, `server exited during startup:\n${logs}`); return logs.includes('Admin (this Mac only)'); });

  async function request(method, endpoint, { cookie, body, csrf = true, adminRequest = false } = {}) {
    const res = await fetch((adminRequest ? admin : base) + endpoint, {
      method, signal: AbortSignal.timeout(20000),
      headers: { ...(cookie && { cookie }), ...(csrf && { [adminRequest ? 'x-pocket-admin' : 'x-pocket-dev']: '1' }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const takeover = `/api/history/claude/${ID}/takeover`;
  const { cookie } = await request('POST', '/api/login', { body: { password: 'test-password' } });
  assert.match(cookie, /^pd_token=/);

  assert.equal((await request('POST', takeover, { body: {} })).status, 401, 'needs a login');
  const noHeader = await request('POST', takeover, { cookie, body: {}, csrf: false });
  assert.equal(noHeader.status, 403, 'needs x-pocket-dev');
  assert.deepEqual(readTable().signals, undefined, 'refused requests signal nothing');

  const detail = await request('GET', `/api/history/claude/${ID}`, { cookie });
  assert.deepEqual([detail.data.live, detail.data.openIn, detail.data.copies[0].pid], [true, 'mac', vscode.pid]);
  const taken = await request('POST', takeover, { cookie, body: {} });
  assert.equal(taken.status, 200, JSON.stringify(taken.data));
  assert.deepEqual(taken.data.stopped.map((s) => [s.kind, s.pid, s.signals]), [['process', vscode.pid, ['SIGINT']]]);
  assert.deepEqual(readTable().signals, [{ pid: vscode.pid, signal: 'SIGINT' }]);
  const logged = (await request('GET', '/api/log', { adminRequest: true })).data.find((e) => e.type === 'conversation-taken-over');
  assert.deepEqual([logged.tool, logged.conversationId, logged.pids, logged.by, typeof logged.deviceId], ['claude', ID, [vscode.pid], 'phone', 'string']);
  assert.equal(logged.category, 'change');

  // A Pocket Dev terminal runs the conversation. Its shell prints its pid so the fixture can put the program under it.
  const session = (await request('POST', '/api/sessions', { cookie, body: { cwd: app, command: 'echo PD_SHELL=$$' } })).data;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${session.id}`, { headers: { cookie, origin: base } });
  sockets.add(ws);
  let output = '';
  let exited = false;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'out') output += msg.d;
    if (msg.t === 'exit') exited = true;
  });
  await until(() => /PD_SHELL=(\d+)/.test(output));
  const shellPid = Number(/PD_SHELL=(\d+)/.exec(output)[1]);
  const inTerminal = { pid: 913000, ppid: shellPid, uid, stat: 'S', started: 0, exe: '/usr/local/bin/claude', args: `claude --resume ${ID}` };
  writeTable({ processes: [inTerminal] });

  const section = (await request('GET', '/api/state', { adminRequest: true })).data.sections.find((s) => s.id === 'conversations');
  assert.equal(section.title, 'Open in Pocket Dev');
  assert.equal(section.action ?? null, null, 'the Admin page shows the command, not a button');
  assert.deepEqual(section.items.map((i) => [i.id, i.cwd]), [[`claude:${ID}`, app]]);
  assert.ok(section.items[0].details.includes(`On the Mac, run: pocket-dev takeover ${ID}`));

  // The fixture's program goes when its terminal does, as a real one would.
  const ended = until(() => exited).then(() => writeTable({ ...readTable(), processes: [] }));
  const closed = await request('POST', `/api/sections/conversations/${encodeURIComponent(`claude:${ID}`)}`, { adminRequest: true, body: {} });
  await ended;
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.match(output, /\[Continued on your Mac\]/);
  assert.equal(readTable().signals, undefined, 'take over sent no signal; the terminal ended its own shell');
  const tab = (await request('GET', '/api/sessions', { cookie })).data.find((s) => s.id === session.id);
  assert.notEqual(tab?.exitCode ?? null, null, 'the tab stays, showing that it ended');
  assert.deepEqual((await request('GET', '/api/state', { adminRequest: true })).data.sections.find((s) => s.id === 'conversations').items, []);
});
