import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWinProcesses, splitCommandLine, parseLockHolders, winKill, WINDOWS_ACTIONS, encodeScript } from '../takeover-windows.js';
import { findCopies, copyView, holderName, stopProcesses, createTakeover, STOPS } from '../takeover.js';

// Windows listings and outputs as the PowerShell scripts in takeover-windows.js print them. Nothing here runs on Windows
// or signals a real process.
const ID = '28e64788-3976-496f-a7f0-113cf83b11f0';
const THREAD = '01a1ec6c-74e2-77f2-a309-a6daa5243871';
const OTHER_THREAD = '01a1ec9c-80e8-7963-816e-4345c85847f3';
const SELF = 9000;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'C:\\Users\\ani\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
const NATIVE_CLAUDE = 'C:\\Users\\ani\\.local\\bin\\claude.exe';
const VSCODE_CODEX = 'C:\\Users\\ani\\.vscode\\extensions\\openai.chatgpt-26.5.1-win32-x64\\bin\\windows-x86_64\\codex.exe';
const CODEX_JS = 'C:\\Users\\ani\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';

const cim = JSON.stringify([
  { pid: SELF, ppid: 8000, session: 1, name: 'node.exe', exe: NODE, args: `"${NODE}" C:\\Users\\ani\\pocket-dev\\server.js`, started: 1794970000000 },
  { pid: 4100, ppid: 3900, session: 1, name: 'node.exe', exe: NODE, args: `"${NODE}" "${CLI}" --resume ${ID} --model sonnet`, started: 1794970100123 },
  { pid: 4200, ppid: 3901, session: 1, name: 'claude.exe', exe: NATIVE_CLAUDE, args: `"${NATIVE_CLAUDE}" --resume=${ID}`, started: 1794970200456 },
  { pid: 4300, ppid: 3902, session: 1, name: 'codex.exe', exe: VSCODE_CODEX, args: `"${VSCODE_CODEX}" app-server --analytics-default-enabled`, started: 1794970300789 },
  { pid: 4400, ppid: 3903, session: 1, name: 'node.exe', exe: NODE, args: `"${NODE}" "${CODEX_JS}" resume ${THREAD}`, started: 1794970400000 },
  { pid: 4500, ppid: 3904, session: 2, name: 'claude.exe', exe: NATIVE_CLAUDE, args: `"${NATIVE_CLAUDE}" --resume ${ID}`, started: 1794970500000 },
  { pid: 4600, ppid: 4, session: 0, name: 'svchost.exe', exe: null, args: null, started: null },
  { pid: 0, ppid: 0, session: 0, name: 'System Idle Process', exe: null, args: null, started: null },
]);

test('CIM rows become the listing takeover.js reads: same session is the same user, quoted arguments are split', () => {
  const procs = parseWinProcesses(JSON.parse(cim), SELF);
  assert.equal(procs.length, 7, 'the idle process (pid 0) is dropped');
  const cli = procs.find((p) => p.pid === 4100);
  assert.deepEqual(cli, { pid: 4100, ppid: 3900, uid: 0, stat: 'R', started: 1794970100123, exe: NODE, args: `"${NODE}" "${CLI}" --resume ${ID} --model sonnet`, argv: [CLI, '--resume', ID, '--model', 'sonnet'] });
  assert.equal(procs.find((p) => p.pid === 4500).uid, -1, 'another logon session is another user');
  const service = procs.find((p) => p.pid === 4600);
  assert.deepEqual([service.exe, service.uid, Number.isNaN(service.started)], ['svchost.exe', -1, true], 'no path or start time: never signalled');
  assert.deepEqual(parseWinProcesses({ pid: SELF, session: 1, exe: NODE, args: NODE, started: 1 }, SELF).map((p) => p.uid), [0], 'one row is not wrapped in a list by ConvertTo-Json');
  assert.ok(parseWinProcesses(JSON.parse(cim), 1).every((p) => p.uid === -1), 'without Pocket Dev in the listing nothing is ours');
});

test('command lines split the way Windows does: quotes, escaped quotes and backslashes', () => {
  assert.deepEqual(splitCommandLine(`"${NODE}" "${CLI}" --resume ${ID}`), [NODE, CLI, '--resume', ID]);
  assert.deepEqual(splitCommandLine(`${NATIVE_CLAUDE} --resume=${ID}`), [NATIVE_CLAUDE, `--resume=${ID}`]);
  assert.deepEqual(splitCommandLine('C:\\tools\\codex.exe   -c "model=\\"o3\\""  resume\t x'), ['C:\\tools\\codex.exe', '-c', 'model="o3"', 'resume', 'x']);
  assert.deepEqual(splitCommandLine('prog "C:\\a b\\\\" next'), ['prog', 'C:\\a b\\', 'next'], 'an even run of backslashes before a quote halves and closes');
  assert.deepEqual(splitCommandLine('prog C:\\dir\\ "say ""hi"""'), ['prog', 'C:\\dir\\', 'say "hi"'], 'backslashes not before a quote stay; "" inside quotes is a quote');
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\x.exe"'), ['C:\\Program Files\\x.exe']);
  assert.deepEqual(splitCommandLine(''), ['']);
});

test('Windows programs are found by their backslash paths, under node.exe or as .exe; another session is not', () => {
  const procs = parseWinProcesses(JSON.parse(cim), SELF);
  const locks = [{ pid: 4300, threadId: THREAD }, { pid: 4300, threadId: OTHER_THREAD }];
  const copies = findCopies({ processes: procs, uid: 0, selfPid: SELF, codexLocks: locks });
  assert.deepEqual(copies.map((c) => [c.proc.pid, c.tool, c.id]), [
    [4100, 'claude', ID], [4200, 'claude', ID], [4300, 'codex', THREAD], [4300, 'codex', OTHER_THREAD], [4400, 'codex', THREAD],
  ]);
  const named = Object.fromEntries(copies.map((c) => [c.proc.pid, [copyView(c).label, holderName(c)]]));
  assert.deepEqual(named[4300], ['Codex in VS Code (pid 4300)', 'Codex in VS Code']);
  assert.deepEqual(named[4200], ['claude.exe (pid 4200)', 'Claude Code'], 'the file name, not the whole Windows path');
});

test("Claude's session file on Windows: its start time in ms is after the process's CreationDate, a stale one is before", () => {
  const procs = parseWinProcesses(JSON.parse(cim), SELF);
  const plain = { ...procs.find((p) => p.pid === 4200), argv: [] };
  const find = (startedAt) => findCopies({ processes: [plain], uid: 0, selfPid: SELF, sessions: [{ pid: 4200, sessionId: ID, startedAt, status: 'busy', pidDomain: 'win32' }] });
  assert.deepEqual(find(plain.started + 850).map((c) => [c.id, c.busy]), [[ID, true]]);
  assert.deepEqual(find(plain.started - 1), [], 'written by an earlier process that had this pid');
});

test('Restart Manager output names the holder of each lock; noise and stale locks print nothing usable', () => {
  const out = `4300 ${THREAD}\r\n4300 ${OTHER_THREAD}\r\n\r\nWARNING: something\r\n77 not-a-thread\r\n`;
  assert.deepEqual(parseLockHolders(out), [{ pid: 4300, threadId: THREAD }, { pid: 4300, threadId: OTHER_THREAD }]);
  assert.deepEqual(parseLockHolders(''), []);
});

test('the PowerShell scripts travel as UTF-16 base64, which keeps their quotes intact', () => {
  const script = '"$holder $thread" | Write-Output';
  assert.equal(Buffer.from(encodeScript(script), 'base64').toString('utf16le'), script);
});

test('on Windows SIGINT is a Ctrl+C; with no console, or for SIGTERM and SIGKILL, the program is ended at once', async () => {
  assert.deepEqual(WINDOWS_ACTIONS, { SIGINT: 'ctrl-c', SIGTERM: 'terminate', SIGKILL: 'terminate' });
  const run = async (signal, ctrlC) => {
    const calls = [];
    const took = await winKill(4100, signal, { ctrlC: async (pid) => { calls.push(['ctrl-c', pid]); return ctrlC(); }, terminate: (pid) => calls.push(['terminate', pid]) });
    return [took, calls];
  };
  assert.deepEqual(await run('SIGINT', () => 'sent'), ['SIGINT', [['ctrl-c', 4100]]]);
  assert.deepEqual(await run('SIGINT', () => 'no-console'), ['SIGKILL', [['ctrl-c', 4100], ['terminate', 4100]]]);
  assert.deepEqual(await run('SIGINT', () => { throw new Error('powershell.exe missing'); }), ['SIGKILL', [['ctrl-c', 4100], ['terminate', 4100]]]);
  assert.deepEqual(await run('SIGTERM', () => 'sent'), ['SIGKILL', [['terminate', 4100]]]);
  assert.deepEqual(await run('SIGKILL', () => 'sent'), ['SIGKILL', [['terminate', 4100]]]);
});

test('the stop steps record what Windows did: a Ctrl+C that is ignored ends in an immediate end after the grace', async () => {
  const alive = new Set([4100]);
  let clock = 0;
  const send = (pid, signal) => winKill(pid, signal, { ctrlC: async () => 'sent', terminate: (p) => alive.delete(p) });
  const { sent, remaining } = await stopProcesses([{ pid: 4100, ppid: 1 }], { kill: send, isAlive: async (p) => alive.has(p.pid), sleep: async (ms) => { clock += ms; }, stop: STOPS.replying });
  assert.deepEqual(sent.get(4100), ['SIGINT', 'SIGKILL']);
  assert.deepEqual(remaining, []);
  assert.ok(clock >= 5000, 'the Ctrl+C had its grace first');
});

test('a Windows process table in POCKET_DEV_PROCESS_FIXTURE: take over finds the VS Code Codex by its lock and stops it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-win-fixture-'));
  const fixture = path.join(dir, 'processes.json');
  const procs = parseWinProcesses(JSON.parse(cim), SELF);
  fs.writeFileSync(fixture, JSON.stringify({ processes: procs, codexLocks: [{ pid: 4300, threadId: OTHER_THREAD }] }));
  process.env.POCKET_DEV_PROCESS_FIXTURE = fixture;
  t.after(() => { delete process.env.POCKET_DEV_PROCESS_FIXTURE; fs.rmSync(dir, { recursive: true, force: true }); });
  const { readCodexLocks } = await import('../takeover.js');
  const takeover = createTakeover({ codexLocks: () => readCodexLocks('C:\\Users\\ani\\.codex\\thread-writer-locks'), codexBusy: async () => false, uid: 0, selfPid: SELF, sleep: async () => {} });
  const r = await takeover.takeOver({ tool: 'codex', id: OTHER_THREAD, mtimeMs: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.stopped.map((s) => [s.label, s.signals]), [['Codex in VS Code (pid 4300)', ['SIGINT']]]);
  const table = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.deepEqual(table.signals, [{ pid: 4300, signal: 'SIGINT' }]);
  assert.deepEqual(table.codexLocks, [], 'the lock goes with its holder');
});
