import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, resumeTarget, findCopies, stopProcesses, createTakeover, NOT_FOUND } from '../takeover.js';

// Every process here is made up. Nothing in this file lists or signals a real process.
const ME = 501;
const SERVER = 4000;
const ID = '28e64788-3976-496f-a7f0-113cf83b11f0';
const OTHER = '28e64788-3976-496f-a7f0-113cf83b11f1';
const VSCODE = '/Users/ani/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude';

let nextPid = 5000;
const proc = (exe, rest = '', extra = {}) => ({ pid: nextPid++, ppid: 1, uid: ME, stat: 'S', started: 1000, exe, args: `${exe}${rest ? ` ${rest}` : ''}`, ...extra });
const server = { pid: SERVER, ppid: 1, uid: ME, stat: 'S', exe: '/usr/local/bin/node', args: `/usr/local/bin/node /Users/ani/pocket-dev/server.js --resume ${ID}` };
const matches = (p, id = ID) => findCopies({ processes: [server, p], uid: ME, selfPid: SERVER }).some((c) => c.id === id);

test('ps listings join on pid and keep executable paths with spaces whole', () => {
  const status = `  2865  2242   501 S    Sun Nov  8 15:26:51 2026    ${VSCODE}\n  77 1 501 Ss   Mon Nov 10 09:05:00 2026    /Users/ani/Library/Application Support/Claude/claude-code/2.1.0/claude\n   9   1   0 S    Sat Nov  7 08:00:00 2026    /sbin/launchd\n`;
  const args = `  2865 ${VSCODE} --output-format stream-json --resume=${ID}\n   77 claude --resume ${ID}\n`;
  const list = parsePs(status, args);
  assert.deepEqual(list.map((p) => [p.pid, p.ppid, p.uid, p.stat]), [[2865, 2242, 501, 'S'], [77, 1, 501, 'Ss']], 'a pid missing from one listing is dropped');
  assert.equal(list[1].exe, '/Users/ani/Library/Application Support/Claude/claude-code/2.1.0/claude');
  assert.equal(list[0].started, new Date(2026, 10, 8, 15, 26, 51).getTime(), 'start time is read as local time');
  assert.deepEqual(resumeTarget(list[0]), { tool: 'claude', id: ID });
  assert.deepEqual(resumeTarget(list[1]), { tool: 'claude', id: ID });
});

test('the VS Code native binary with --resume=<id> matches', () => {
  assert.equal(matches(proc(VSCODE, `--output-format stream-json --verbose --input-format stream-json --max-thinking-tokens 31999 --permission-prompt-tool stdio --resume=${ID} --setting-sources=user,project,local`)), true);
});

test('claude --resume <id>, -r <id> and codex resume <id> match, including the CLI scripts node runs', () => {
  assert.equal(matches(proc('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', `--resume ${ID}`)), true);
  assert.equal(matches(proc('/Users/ani/.local/share/claude/versions/2.1.286', `-r ${ID}`)), true);
  assert.equal(matches(proc('/usr/local/bin/node', `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume=${ID}`)), true);
  assert.equal(matches(proc('/Users/ani/.codex/packages/standalone/releases/0.166.0/bin/codex', `resume ${ID}`)), true);
  assert.equal(matches(proc('/opt/homebrew/bin/node', `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js -c model=o3 resume ${ID}`)), true);
  assert.equal(matches(proc('/opt/homebrew/bin/codex', `resume -m gpt-5 ${ID}`)), true, 'options may come before the id');
  const [c] = findCopies({ processes: [proc('codex', `resume ${ID}`)], uid: ME, selfPid: SERVER });
  assert.equal(c.tool, 'codex');
});

test('grep, tail, editors, shells and a different id never match', () => {
  for (const reader of [
    proc('/usr/bin/grep', ID),
    proc('/usr/bin/tail', `-f /Users/ani/.claude/projects/-Users-ani-app/${ID}.jsonl`),
    proc('/usr/bin/vim', `/Users/ani/.claude/projects/-Users-ani-app/${ID}.jsonl`),
    proc('/bin/zsh', `-c claude --resume ${ID}`),
    proc('/usr/local/bin/node', `/Users/ani/scripts/tool.js --resume ${ID}`),
    proc('/usr/local/bin/claude', `--resume ${ID.slice(0, 8)}`),
  ]) assert.equal(matches(reader), false, reader.args);
  assert.equal(matches(proc(VSCODE, `--resume=${OTHER}`)), false, 'an id that shares a prefix is another conversation');
  assert.equal(matches(proc(VSCODE, `--resume=${ID}-2`)), false);
  assert.equal(matches(proc('/usr/local/bin/claude', `--resume ${OTHER}`), ID), false);
});

test("Claude's session registry finds a session started without --resume, and a stale entry is ignored", () => {
  const plain = proc('/usr/local/bin/claude', '', { started: 50_000 });
  const find = (sessions) => findCopies({ processes: [server, plain], uid: ME, selfPid: SERVER, sessions }).map((c) => [c.id, c.busy]);
  assert.deepEqual(find([{ pid: plain.pid, sessionId: ID, startedAt: 52_000, status: 'busy' }]), [[ID, true]]);
  assert.deepEqual(find([{ pid: plain.pid, sessionId: ID, startedAt: 52_000, status: 'idle' }]), [[ID, false]]);
  assert.deepEqual(find([{ pid: plain.pid, sessionId: ID, startedAt: 40_000 }]), [], 'written by an earlier process that had this pid');
  const grep = proc('/usr/bin/grep', 'x', { started: 50_000 });
  assert.deepEqual(findCopies({ processes: [grep], uid: ME, selfPid: SERVER, sessions: [{ pid: grep.pid, sessionId: ID, startedAt: 52_000 }] }), [], 'the registry never makes a reader a writer');
  const cleared = proc(VSCODE, `--resume=${OTHER}`, { started: 50_000 });
  const both = findCopies({ processes: [cleared], uid: ME, selfPid: SERVER, sessions: [{ pid: cleared.pid, sessionId: ID, startedAt: 52_000 }] });
  assert.deepEqual(both.map((c) => c.id).sort(), [ID, OTHER].sort(), 'after /clear it holds both');
});

test("another user's process, a zombie, and Pocket Dev's own server never match", () => {
  assert.equal(matches(proc(VSCODE, `--resume=${ID}`, { uid: 502 })), false);
  assert.equal(matches(proc(VSCODE, `--resume=${ID}`, { stat: 'Z' })), false);
  assert.deepEqual(findCopies({ processes: [server], uid: ME, selfPid: SERVER }), []);
  const launcher = proc('/usr/local/bin/claude', `--resume ${ID}`);
  const underIt = { ...server, ppid: launcher.pid };
  assert.deepEqual(findCopies({ processes: [launcher, underIt], uid: ME, selfPid: SERVER }), [], 'nor a program Pocket Dev itself runs under');
});

test("a program in a Pocket Dev terminal is that terminal's copy; one under the server is a chat engine", () => {
  const host = proc('/usr/local/bin/node', 'terminal-host.js /tmp/pd.sock');
  const shell = proc('/bin/zsh', '-l', { ppid: host.pid });
  const inTerminal = proc('/usr/local/bin/claude', `--resume ${ID}`, { ppid: shell.pid });
  const engine = proc('/usr/local/bin/claude', `--output-format stream-json --resume ${ID}`, { ppid: SERVER });
  const outside = proc(VSCODE, `--resume=${ID}`);
  const copies = findCopies({ processes: [server, host, shell, inTerminal, engine, outside], uid: ME, selfPid: SERVER, terminals: [{ id: 'abc', pid: shell.pid, title: 'claude · app' }] });
  assert.deepEqual(copies.map((c) => [c.kind, c.proc.pid]), [['terminal', inTerminal.pid], ['engine', engine.pid], ['process', outside.pid]]);
  assert.equal(copies[0].terminal.id, 'abc');
});

// A process table where each process exits after the signals it does not ignore.
function fakeSystem(procs) {
  const table = new Map(procs.map((p) => [p.pid, p]));
  const signals = [];
  let clock = 0;
  return {
    signals,
    get clock() { return clock; },
    listProcesses: async () => [...table.values()],
    isAlive: async (p) => table.has(p.pid),
    sleep: async (ms) => { clock += ms; },
    kill(pid, signal) {
      signals.push([pid, signal]);
      const p = table.get(pid);
      if (!p) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (!p.ignores?.includes(signal)) table.delete(pid);
    },
  };
}

test('stopping sends SIGINT and waits; SIGTERM only for a program that keeps running; never SIGKILL without force', async () => {
  const polite = proc(VSCODE, `--resume=${ID}`);
  const sys = fakeSystem([polite]);
  const r = await stopProcesses([polite], sys);
  assert.deepEqual(sys.signals, [[polite.pid, 'SIGINT']]);
  assert.deepEqual(r.remaining, []);

  const stubborn = proc(VSCODE, `--resume=${ID}`, { ignores: ['SIGINT'] });
  const sys2 = fakeSystem([stubborn]);
  await stopProcesses([stubborn], sys2);
  assert.deepEqual(sys2.signals, [[stubborn.pid, 'SIGINT'], [stubborn.pid, 'SIGTERM']]);
  assert.ok(sys2.clock >= 5000, 'SIGTERM comes only after the 5 s wait');

  const deaf = proc(VSCODE, `--resume=${ID}`, { ignores: ['SIGINT', 'SIGTERM'] });
  const sys3 = fakeSystem([deaf]);
  const r3 = await stopProcesses([deaf], sys3);
  assert.deepEqual(sys3.signals.map(([, s]) => s), ['SIGINT', 'SIGTERM'], 'no SIGKILL');
  assert.deepEqual(r3.remaining.map((p) => p.pid), [deaf.pid]);
  assert.ok(sys3.clock >= 10_000);

  const sys4 = fakeSystem([deaf]);
  const r4 = await stopProcesses([deaf], { ...sys4, kill: sys4.kill, force: true });
  assert.deepEqual(sys4.signals.map(([, s]) => s), ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.deepEqual(r4.remaining, []);
});

test('a wrapper and the program it runs: the first signal goes to the wrapper only', async () => {
  const wrapper = proc('/usr/local/bin/node', `/usr/local/lib/node_modules/@openai/codex/bin/codex.js resume ${ID}`, { ignores: ['SIGINT'] });
  const native = proc('/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex', `resume ${ID}`, { ppid: wrapper.pid, ignores: ['SIGINT'] });
  const sys = fakeSystem([wrapper, native]);
  await stopProcesses([wrapper, native], sys);
  assert.deepEqual(sys.signals, [[wrapper.pid, 'SIGINT'], [wrapper.pid, 'SIGTERM'], [native.pid, 'SIGTERM']]);
});

test('a pid that now belongs to another program is not signalled', async () => {
  const old = proc(VSCODE, `--resume=${ID}`);
  const reused = { ...old, args: '/usr/bin/vim notes.txt' };
  let listings = 0;
  const signals = [];
  const takeover = createTakeover({
    // The first listing finds the conversation; by the time a signal would go out the pid runs vim.
    listProcesses: async () => (listings++ === 0 ? [old] : [reused]),
    kill: (pid, signal) => signals.push([pid, signal]),
    sleep: async () => {}, uid: ME, selfPid: SERVER,
  });
  const r = await takeover.takeOver({ tool: 'claude', id: ID, mtimeMs: -1e9 });
  assert.equal(r.status, 200);
  assert.deepEqual(signals, []);
});

function takeoverWith(procs, extra = {}) {
  const sys = fakeSystem([server, ...procs]);
  const logged = [];
  const takeover = createTakeover({
    listProcesses: sys.listProcesses, kill: sys.kill, isAlive: sys.isAlive, sleep: sys.sleep, now: () => 1_000_000,
    uid: ME, selfPid: SERVER, log: (type, fields) => logged.push({ type, ...fields }), ...extra,
  });
  return { sys, logged, takeOver: takeover.takeOver };
}
const OLD = 1_000_000 - 10 * 60_000;

test('take over stops the program, reports what it stopped, and logs it', async () => {
  const vscode = proc(VSCODE, `--resume=${ID}`);
  const { sys, logged, takeOver } = takeoverWith([vscode]);
  const r = await takeOver({ tool: 'claude', id: ID, mtimeMs: OLD, who: { by: 'phone', deviceId: 'd1', name: 'Pixel', ip: '10.0.0.5' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { busy: false, stopped: [{ kind: 'process', pid: vscode.pid, label: `Claude Code in VS Code (pid ${vscode.pid})`, signals: ['SIGINT'] }] });
  assert.deepEqual(sys.signals, [[vscode.pid, 'SIGINT']]);
  assert.deepEqual(logged, [{ type: 'conversation-taken-over', tool: 'claude', conversationId: ID, pids: [vscode.pid], stopped: ['process'], force: false, by: 'phone', deviceId: 'd1', name: 'Pixel', ip: '10.0.0.5' }]);
});

test('the busy flag: a file written in the last 10 s needs a second confirmation before anything stops', async () => {
  const vscode = proc(VSCODE, `--resume=${ID}`);
  const { sys, takeOver } = takeoverWith([vscode]);
  const first = await takeOver({ tool: 'claude', id: ID, mtimeMs: 1_000_000 - 3000 });
  assert.equal(first.status, 409);
  assert.equal(first.body.code, 'busy');
  assert.equal(first.body.busy, true);
  assert.equal(first.body.error, 'Claude is still working on the Mac. Taking over stops that reply.');
  assert.deepEqual(sys.signals, [], 'nothing is stopped before the second confirmation');
  const second = await takeOver({ tool: 'claude', id: ID, mtimeMs: 1_000_000 - 3000, confirmBusy: true });
  assert.equal(second.status, 200);
  assert.equal(second.body.busy, true);
  assert.deepEqual(sys.signals, [[vscode.pid, 'SIGINT']]);
  const working = takeoverWith([vscode], { claudeSessions: () => [{ pid: vscode.pid, sessionId: ID, startedAt: 2000, status: 'busy' }] });
  const registryBusy = await working.takeOver({ tool: 'claude', id: ID, mtimeMs: OLD });
  assert.deepEqual([registryBusy.status, registryBusy.body.code], [409, 'busy'], "Claude's own busy status counts even before the file changes");
  const quiet = takeoverWith([proc(VSCODE, `--resume=${ID}`)]);
  assert.equal((await quiet.takeOver({ tool: 'claude', id: ID, mtimeMs: 1_000_000 - 11_000 })).body.busy, false);
});

test("Pocket Dev's own terminal and chat close through their APIs, with no signal from take over", async () => {
  const shell = proc('/bin/zsh', '-l');
  const inTerminal = proc('/usr/local/bin/claude', `--resume ${ID}`, { ppid: shell.pid });
  const engine = proc('/usr/local/bin/claude', `--resume ${ID}`, { ppid: SERVER });
  const calls = [];
  let chatAwake = true;
  let sys;
  const t = takeoverWith([shell, inTerminal, engine], {
    terminals: () => [{ id: 'term1', pid: shell.pid, title: 'claude · app' }],
    endTerminal: (id, note) => { calls.push(['endTerminal', id, note]); sys.kill(inTerminal.pid, 'SIGHUP'); return true; },
    chats: () => (chatAwake ? [{ id: 'chat1', title: 'Fix it', tool: 'claude', sessionId: ID }] : []),
    releaseChat: async (id, note) => { calls.push(['releaseChat', id, note]); chatAwake = false; sys.kill(engine.pid, 'SIGTERM'); return true; },
  });
  sys = t.sys;
  const r = await t.takeOver({ tool: 'claude', id: ID, mtimeMs: OLD, note: 'Continued in another Pocket Dev tab' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.sort(), [['endTerminal', 'term1', 'Continued in another Pocket Dev tab'], ['releaseChat', 'chat1', 'Continued in another Pocket Dev tab']]);
  assert.deepEqual(sys.signals.map(([, s]) => s).sort(), ['SIGHUP', 'SIGTERM'], 'only the fakes standing in for the terminal and chat ended their programs');
  assert.deepEqual(r.body.stopped.map((s) => s.kind).sort(), ['chat', 'terminal']);
});

test('the Mac terminal scope closes only Pocket Dev copies and leaves other programs alone', async () => {
  const vscode = proc(VSCODE, `--resume=${ID}`);
  let awake = true;
  const t = takeoverWith([vscode], {
    chats: () => (awake ? [{ id: 'chat1', title: 'Fix it', tool: 'claude', sessionId: ID }] : []),
    releaseChat: async () => { awake = false; return true; },
  });
  const r = await t.takeOver({ tool: 'claude', id: ID, mtimeMs: OLD, scope: 'pocket-dev', confirmBusy: true });
  assert.equal(r.status, 200);
  assert.deepEqual(t.sys.signals, []);
  assert.deepEqual(r.body.stopped.map((s) => s.kind), ['chat']);
});

test('live from a recent write but no program found: a clear refusal, nothing signalled', async () => {
  const { sys, takeOver } = takeoverWith([proc('/usr/bin/tail', `-f ${ID}.jsonl`)]);
  const r = await takeOver({ tool: 'claude', id: ID, mtimeMs: 1_000_000 - 30_000 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not-found');
  assert.equal(r.body.error, NOT_FOUND);
  assert.deepEqual(sys.signals, []);
  const old = await takeOver({ tool: 'claude', id: ID, mtimeMs: OLD });
  assert.deepEqual([old.status, old.body.stopped], [200, []], 'a conversation nobody has open needs nothing stopped');
});

test('a program that ignores the signals: a clear error that offers force, and force ends it with SIGKILL', async () => {
  const deaf = proc(VSCODE, `--resume=${ID}`, { ignores: ['SIGINT', 'SIGTERM'] });
  const { sys, logged, takeOver } = takeoverWith([deaf]);
  const r = await takeOver({ tool: 'claude', id: ID, mtimeMs: OLD });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'still-running');
  assert.equal(r.body.canForce, true);
  assert.match(r.body.error, new RegExp(`Claude Code in VS Code \\(pid ${deaf.pid}\\) did not close when asked`));
  assert.deepEqual(sys.signals.map(([, s]) => s), ['SIGINT', 'SIGTERM']);
  assert.equal(logged[0].type, 'conversation-takeover-failed');
  const forced = await takeOver({ tool: 'claude', id: ID, mtimeMs: OLD, force: true });
  assert.equal(forced.status, 200);
  assert.deepEqual(sys.signals.map(([, s]) => s).slice(2), ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.deepEqual(forced.body.stopped[0].signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
});
