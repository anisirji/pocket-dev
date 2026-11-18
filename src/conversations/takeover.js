import fs from 'node:fs';
import { platform } from '../core/platform.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { listWinProcesses, winCodexLocks, winKill } from './takeover-windows.js';

// Take over: a conversation has one writer at a time, because every copy appends to the same history file. Taking a
// conversation over closes the copy that is running (another program on the Mac, a Pocket Dev terminal, or a Pocket Dev
// chat) before the new copy starts.

export const BUSY_MS = 10_000;
export const LIVE_MS = 2 * 60_000;
export const STOP_GRACE_MS = 5000;
export const IDLE_GRACE_MS = 2000;
const POLL_MS = 100;
const PRODUCTS = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' };
const REPLYING = new Set(['running', 'waiting-permission', 'waiting-answer']);

// How a holder is stopped. One that is idle has nothing to lose, so it gets a short wait per signal. It still gets SIGINT
// first: idle Claude Code exits 0 on SIGINT in about half a second, while SIGTERM's exit code 143 shows as an error in the
// VS Code extension. One that is replying gets SIGINT to finish its write first; SIGKILL only with force, because it can
// cut off that write.
export const STOPS = {
  idle: { signals: ['SIGINT', 'SIGTERM', 'SIGKILL'], graceMs: IDLE_GRACE_MS },
  replying: { signals: ['SIGINT', 'SIGTERM'], graceMs: STOP_GRACE_MS },
  forced: { signals: ['SIGINT', 'SIGTERM', 'SIGKILL'], graceMs: STOP_GRACE_MS },
};

const win = platform.platform === 'win32';

// Only these programs write conversations. Everything else that mentions an id (grep, tail, an editor, a shell) is a reader.
// Paths may use / or \ (Windows), and a program may end in .exe.
const PROGRAMS = [
  ['claude', /(^|[\\/])claude(\.exe)?$/],
  ['claude', /[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/][^\\/]+$/],
  ['claude', /[\\/]@anthropic-ai[\\/]claude-(code|agent-sdk)[\\/]cli\.js$/],
  ['codex', /(^|[\\/])codex(\.exe)?$/],
  ['codex', /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/],
  ['copilot', /(^|[\\/])copilot(\.exe)?$/],
  ['copilot', /[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/],
];
const NODE = /(^|[\\/])node(\.exe)?$/;
const programOf = (file) => PROGRAMS.find(([, re]) => re.test(file))?.[0] ?? null;

const CLAUDE_ID = /^[A-Za-z0-9-]{8,64}$/;
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE_FLAGS = new Set(['--resume', '-r', '--session-id']);

// ps prints the command line with spaces between arguments, so an argument that holds a space cannot be told apart. The
// executable comes from its own column, which keeps paths such as "Application Support" whole. Windows quotes its
// arguments, so its listing carries them already split.
function argv(proc) {
  if (proc.argv) return proc.argv;
  const rest = proc.args.startsWith(proc.exe) ? proc.args.slice(proc.exe.length) : proc.args.replace(/^\S+/, '');
  return rest.trim().split(/\s+/).filter(Boolean);
}

function claudeId(args) {
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!CLAUDE_FLAGS.has(flag)) continue;
    const value = inline ?? args[i + 1];
    if (CLAUDE_ID.test(value ?? '')) return value;
  }
  return null;
}

// Copilot continues a session with --resume <id>, -r <id> or --session-id <id>; a bare --continue names none.
const COPILOT_FLAGS = new Set(['--resume', '-r', '--session-id']);
function copilotId(args) {
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!COPILOT_FLAGS.has(flag)) continue;
    const value = inline ?? args[i + 1];
    if (CODEX_ID.test(value ?? '')) return value;
  }
  return null;
}

const codexId = (args) => {
  const at = args.indexOf('resume');
  return at === -1 ? null : args.slice(at + 1).find((a) => CODEX_ID.test(a)) ?? null;
};

// 'claude', 'codex' or 'copilot' when this process is one of them (directly, or a CLI script run by node), else null; with the
// arguments that follow the program.
function program(proc) {
  const args = argv(proc);
  const tool = programOf(proc.exe);
  if (tool) return { tool, args };
  if (NODE.test(proc.exe) && args[0] && programOf(args[0])) return { tool: programOf(args[0]), args: args.slice(1) };
  return null;
}

// { tool, id } when this process's command line names the conversation it runs, else null.
export function resumeTarget(proc) {
  const found = program(proc);
  const id = found && ({ claude: claudeId, codex: codexId, copilot: copilotId }[found.tool])(found.args);
  return id ? { tool: found.tool, id } : null;
}

// Claude Code 2.1 writes ~/.claude/sessions/<pid>.json with the conversation that process is in, which is how a session
// started without --resume (a plain `claude`, a new VS Code tab) is found. A file left by a process that has exited may
// carry a pid the system has since reused, so an entry counts only if it was written after the current process started.
export function readClaudeSessions(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^\d+\.json$/.test(n)).flatMap((n) => {
    try {
      const { pid, sessionId, startedAt, status } = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      return Number.isInteger(pid) && CLAUDE_ID.test(sessionId ?? '') && Number.isFinite(startedAt) ? [{ pid, sessionId, startedAt, status }] : [];
    } catch {
      return [];
    }
  });
}

// Codex keeps ~/.codex/thread-writer-locks/<thread id>.lock open in the process that writes that thread, and refuses a
// second writer itself. The VS Code extension runs one app-server that holds several threads and names none of them on its
// command line, so the locks are the only way to see what it holds.
export function parseLsof(text) {
  const out = [];
  let pid = null;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    const m = line[0] === 'n' && /\/([^/]+)\.lock$/.exec(line);
    if (m && Number.isInteger(pid) && CODEX_ID.test(m[1])) out.push({ pid, threadId: m[1] });
  }
  return out;
}

export async function readCodexLocks(dir) {
  if (fixtureFile()) return JSON.parse(fs.readFileSync(fixtureFile(), 'utf8')).codexLocks ?? [];
  if (win) return winCodexLocks(dir).catch(() => []);
  // lsof exits 1 with no output when nothing holds a lock. Without lsof, Codex's own writer lock still refuses a second
  // writer. Any other failure must not read as "nobody holds it".
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-n', '-F', 'pn', '+d', dir], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err && err.code !== 'ENOENT' && !(err.code === 1 && !out?.trim())) return reject(err);
      resolve(parseLsof(out ?? ''));
    });
  });
}

// Two listings joined by pid: `comm` is the executable path and may hold spaces, `args` is the whole command line.
export function parsePs(statusText, argsText) {
  const commands = new Map();
  for (const line of argsText.split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) commands.set(Number(m[1]), m[2].trim());
  }
  const out = [];
  for (const line of statusText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    const pid = m && Number(m[1]);
    if (!m || !commands.has(pid)) continue;
    // lstart is local time to the second, so `started` is at most a second before the real start.
    out.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), stat: m[4], started: Date.parse(m[5]), exe: m[6].trim(), args: commands.get(pid) });
  }
  return out;
}

const ps = (columns) => new Promise((resolve, reject) => {
  execFile('ps', ['-axo', columns], { maxBuffer: 16 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
});

// POCKET_DEV_PROCESS_FIXTURE names a JSON file { processes: [...] } that stands in for the process table in tests:
// listing reads it, and a signal is recorded in it and ends the process unless the process lists that signal in `ignores`.
const fixtureFile = () => process.env.POCKET_DEV_PROCESS_FIXTURE;

export async function listProcesses() {
  if (fixtureFile()) return JSON.parse(fs.readFileSync(fixtureFile(), 'utf8')).processes;
  if (!platform.capabilities().processScan.available) return [];
  if (win) return listWinProcesses();
  const [status, args] = await Promise.all([ps('pid=,ppid=,uid=,stat=,lstart=,comm='), ps('pid=,args=')]);
  return parsePs(status, args);
}

// Returns the signal that took effect when it differs from the one asked for (see winKill).
export function kill(pid, signal) {
  if (!fixtureFile()) return win ? winKill(pid, signal) : process.kill(pid, signal);
  const table = JSON.parse(fs.readFileSync(fixtureFile(), 'utf8'));
  const proc = table.processes.find((p) => p.pid === pid);
  if (!proc) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  table.signals = [...(table.signals ?? []), { pid, signal }];
  if (!proc.ignores?.includes(signal)) {
    table.processes = table.processes.filter((p) => p !== proc);
    if (table.codexLocks) table.codexLocks = table.codexLocks.filter((l) => l.pid !== pid);
  }
  fs.writeFileSync(fixtureFile(), JSON.stringify(table));
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every copy of every conversation in one process listing. `terminals` are Pocket Dev's shells ({ id, pid, ... }); a
// program under one of them is that terminal's copy. A program under `selfPid` that is not in a terminal is a chat
// engine, which stops with its chat. Pocket Dev itself and the programs it runs under are never copies. `sessions` is
// readClaudeSessions(); a process it names holds that conversation as well as the one on its command line, because
// after /clear the command line still shows the conversation the process started with. `codexLocks` is readCodexLocks().
// `busy` is true or false when the program says whether it is replying in that conversation, null when it cannot tell.
export function findCopies({ processes, uid, selfPid, terminals = [], sessions = [], codexLocks = [] }) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const lineage = (pid) => {
    const out = [];
    for (let p = pid; p > 1 && out.length < 64 && !out.includes(p); p = byPid.get(p)?.ppid ?? 0) out.push(p);
    return out;
  };
  const guarded = new Set(lineage(selfPid));
  const shells = new Map(terminals.map((t) => [t.pid, t]));
  const registered = new Map(sessions.map((s) => [s.pid, s]));
  const copies = [];
  for (const proc of processes) {
    if (proc.uid !== uid || guarded.has(proc.pid) || proc.stat.startsWith('Z')) continue;
    const found = program(proc);
    if (!found) continue;
    const entry = found.tool === 'claude' && registered.get(proc.pid);
    const current = entry && entry.startedAt >= proc.started ? entry : null;
    const locked = found.tool === 'codex' ? codexLocks.filter((l) => l.pid === proc.pid).map((l) => l.threadId) : [];
    const ids = new Set([resumeTarget(proc)?.id, current?.sessionId, ...locked].filter(Boolean));
    const chain = lineage(proc.pid);
    const terminal = chain.map((pid) => shells.get(pid)).find(Boolean);
    const kind = terminal ? 'terminal' : chain.includes(selfPid) ? 'engine' : 'process';
    // Claude says busy, idle, or (waiting on a prompt) something else, for the one conversation it is in now.
    const known = typeof current?.status === 'string';
    for (const id of ids) {
      const busy = known ? current.sessionId === id && current.status !== 'idle' : null;
      copies.push({ kind, tool: found.tool, id, proc, ...(terminal && { terminal }), busy });
    }
  }
  return copies;
}

const APPS = [
  ['VS Code', /[\\/]\.vscode(-insiders)?[\\/]extensions[\\/]/], ['Cursor', /[\\/]\.cursor[\\/]extensions[\\/]/],
  ['the Claude app', /\/Application Support\/Claude\/|[\\/]AppData[\\/](Roaming|Local)[\\/](Claude|AnthropicClaude)[\\/]/],
];

const appOf = (copy) => APPS.find(([, re]) => re.test(copy.proc.exe))?.[0];

export function copyView(copy) {
  if (copy.kind === 'chat') return { kind: 'chat', id: copy.chat.id, label: `Pocket Dev chat "${copy.chat.title || 'New chat'}"` };
  if (copy.kind === 'terminal') return { kind: 'terminal', id: copy.terminal.id, pid: copy.proc.pid, label: `Pocket Dev terminal "${copy.terminal.title}"` };
  const app = appOf(copy);
  const name = app ? `${PRODUCTS[copy.tool]} in ${app}` : copy.proc.exe.split(/[\\/]/).pop();
  return { kind: copy.kind, pid: copy.proc.pid, label: `${copy.kind === 'engine' ? 'Pocket Dev chat engine' : name} (pid ${copy.proc.pid})` };
}

// Who holds a copy, in words for a person: "Claude Code in VS Code", "Codex", 'Pocket Dev terminal "app"'.
export function holderName(copy) {
  if (copy.kind !== 'process') return copyView(copy).label.replace(/ \(pid \d+\)$/, '');
  const app = appOf(copy);
  return app ? `${PRODUCTS[copy.tool]} in ${app}` : PRODUCTS[copy.tool];
}

// The wait counts real time as well as polls, because one look at the process table takes about a second on Windows.
async function waitForExit(procs, { isAlive, sleep, graceMs, pollMs = POLL_MS }) {
  let alive = procs;
  const start = Date.now();
  for (let polls = 0; ; polls++) {
    const checks = await Promise.all(alive.map((p) => isAlive(p)));
    alive = alive.filter((_, i) => checks[i]);
    if (!alive.length || Math.max(polls * pollMs, Date.now() - start) >= graceMs) return alive;
    await sleep(pollMs);
  }
}

// Sends each signal of `stop` (one of STOPS) in turn to whatever is still running, waiting `graceMs` after each. Each signal goes
// only to a process that is still the one that was matched, so a pid the system reused for something else is never
// signalled. Returns the signals sent per pid and what is still running.
export async function stopProcesses(procs, { kill: send, isAlive, sleep, stop = STOPS.replying }) {
  const { signals: steps, graceMs } = stop;
  const pids = new Set(procs.map((p) => p.pid));
  const sent = new Map();
  let alive = procs;
  for (const [step, signal] of steps.entries()) {
    // A wrapper (the codex node script) passes the first signal to the program it runs, so that program hears it once.
    const targets = step === 0 ? alive.filter((p) => !pids.has(p.ppid)) : alive;
    for (const p of targets) {
      if (!(await isAlive(p))) continue;
      try {
        const took = await send(p.pid, signal);
        sent.set(p.pid, [...(sent.get(p.pid) ?? []), typeof took === 'string' ? took : signal]);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
    alive = await waitForExit(alive, { isAlive, sleep, graceMs });
    if (!alive.length) break;
  }
  return { sent, remaining: alive };
}

function where(copy) {
  if (copy.kind === 'process') return `on ${platform.host.the}`;
  if (copy.kind === 'terminal') return 'in a Pocket Dev terminal';
  return 'in Pocket Dev';
}

// `claudeSessions()` returns readClaudeSessions() for the Claude config folder in use; `codexLocks()` returns
// readCodexLocks() for the Codex folder in use; `codexBusy(threadId)` says whether a Codex thread is in a turn (true or
// false), or null when it cannot tell. `terminals()` lists Pocket Dev's running shells as { id, title, cwd, pid, activeAt }; `endTerminal(id, note)` ends one.
// `chats()` lists chats whose engine is awake as { id, title, tool, sessionId, cwd, updatedAt }; `releaseChat(id, note)`
// stops one's engine. `log(type, fields)` writes the security log.
export function createTakeover({
  listProcesses: list = listProcesses, claudeSessions = () => [], codexLocks = async () => [], codexBusy = async () => null, kill: send = kill, isAlive, sleep = sleepFor, now = Date.now,
  uid = process.getuid?.() ?? 0, selfPid = process.pid, log = () => {},
  terminals = () => [], endTerminal = () => false, chats = () => [], releaseChat = async () => false,
}) {
  isAlive ??= async (proc) => {
    const current = (await list()).find((p) => p.pid === proc.pid);
    return Boolean(current && current.uid === proc.uid && current.exe === proc.exe
      && Number.isFinite(proc.started) && current.started === proc.started
      && current.args === proc.args && !current.stat.startsWith('Z'));
  };

  async function survey() {
    const [processes, locks] = await Promise.all([list(), codexLocks()]);
    const copies = findCopies({ processes, uid, selfPid, terminals: terminals(), sessions: claudeSessions(), codexLocks: locks });
    await Promise.all(copies.filter((c) => c.tool === 'codex' && c.busy === null).map(async (c) => { c.busy = await codexBusy(c.id).catch(() => null); }));
    for (const chat of chats()) if (chat.sessionId) copies.push({ kind: 'chat', tool: chat.tool, id: chat.sessionId, chat, busy: REPLYING.has(chat.status) });
    return copies;
  }

  const refuse = (body) => ({ status: 409, body });

  // `scope` 'all' closes every copy; 'pocket-dev' closes only Pocket Dev's own, for a Mac terminal that resumes the
  // conversation itself. `note` is what the closed Pocket Dev terminal or chat shows. `who` names who asked, for the log.
  async function takeOver({ tool, id, mtimeMs, force = false, confirmBusy = false, scope = 'all', note, who = {} }) {
    const ours = (c) => c.tool === tool && c.id === id && (scope === 'all' || c.kind !== 'process');
    const all = await survey();
    const found = all.filter(ours);
    // Closing a holder stops every conversation it has open (one Codex app-server holds several), so a reply in any of
    // them blocks. A copy that cannot tell falls back to how recently this conversation's file was written.
    const pids = new Set(found.filter((c) => c.proc).map((c) => c.proc.pid));
    const replying = (c) => c.busy ?? (c.tool === tool && c.id === id && now() - mtimeMs < BUSY_MS);
    const blocking = all.filter((c) => (found.includes(c) || pids.has(c.proc?.pid)) && replying(c));
    const busy = blocking.length > 0;
    if (!found.length) return { status: 200, body: { stopped: [], busy } };
    if (busy && !confirmBusy) {
      const first = blocking[0];
      const holder = holderName(first);
      const what = ours(first) ? `is still replying ${where(first)}` : `is replying in another conversation ${where(first)}`;
      return refuse({ code: 'busy', busy, holder, copies: found.map(copyView), error: `${holder} ${what}. Continuing stops that reply.` });
    }

    const stopped = [];
    const external = found.filter((c) => c.kind === 'process');
    const terminalIds = [...new Set(found.filter((c) => c.kind === 'terminal').map((c) => c.terminal.id))];
    const [{ sent }] = await Promise.all([
      stopProcesses(external.map((c) => c.proc), { kill: send, isAlive, sleep, stop: STOPS[!busy ? 'idle' : force ? 'forced' : 'replying'] }),
      ...found.filter((c) => c.kind === 'chat').map(async (c) => { if (await releaseChat(c.chat.id, note)) stopped.push(copyView(c)); }),
      ...terminalIds.map(async (tid) => {
        if (await endTerminal(tid, note)) stopped.push(copyView(found.find((c) => c.terminal?.id === tid)));
      }),
    ]);
    // A closed terminal or chat takes its program with it; wait for that program to be gone too.
    await waitForExit(found.filter((c) => c.kind === 'terminal' || c.kind === 'engine').map((c) => c.proc), { isAlive, sleep, graceMs: 2 * STOP_GRACE_MS });

    const left = (await survey()).filter(ours);
    for (const c of external) {
      if (!left.some((l) => l.proc?.pid === c.proc.pid)) stopped.push({ ...copyView(c), signals: sent.get(c.proc.pid) ?? [] });
    }
    if (left.length) {
      log('conversation-takeover-failed', { tool, conversationId: id, pids: [...pids], remaining: left.filter((c) => c.proc).map((c) => c.proc.pid), force, ...who });
      const canForce = !force && left.every((c) => c.kind === 'process');
      const names = left.map((c) => copyView(c).label).join(', ');
      return refuse({
        code: 'still-running', busy, canForce, stopped, remaining: left.map(copyView),
        error: canForce
          ? `${names} did not close when asked. Force quit stops it at once, and its last reply may be lost.`
          : `${names} did not close. Close it on ${platform.host.the}, then try again.`,
      });
    }
    log('conversation-taken-over', { tool, conversationId: id, pids: [...pids], stopped: stopped.map((s) => s.kind), force, ...who });
    return { status: 200, body: { stopped, busy } };
  }

  return { survey, takeOver };
}
