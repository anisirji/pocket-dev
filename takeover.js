import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Take over: a conversation has one writer at a time, because every copy appends to the same history file. Taking a
// conversation over closes the copy that is running (another program on the Mac, a Pocket Dev terminal, or a Pocket Dev
// chat) before the new copy starts.

export const BUSY_MS = 10_000;
export const LIVE_MS = 2 * 60_000;
export const STOP_GRACE_MS = 5000;
const POLL_MS = 100;
const TOOL_LABELS = { claude: 'Claude', codex: 'Codex' };

export const NOT_FOUND = "Couldn't find the program that has this conversation open. Close it on the Mac, then try again.";

// Only these programs write conversations. Everything else that mentions an id (grep, tail, an editor, a shell) is a reader.
const PROGRAMS = [
  ['claude', /(^|\/)claude(\.exe)?$/],
  ['claude', /\/\.local\/share\/claude\/versions\/[^/]+$/],
  ['claude', /\/@anthropic-ai\/claude-(code|agent-sdk)\/cli\.js$/],
  ['codex', /(^|\/)codex$/],
  ['codex', /\/@openai\/codex\/bin\/codex\.js$/],
];
const programOf = (file) => PROGRAMS.find(([, re]) => re.test(file))?.[0] ?? null;

const CLAUDE_ID = /^[A-Za-z0-9-]{8,64}$/;
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE_FLAGS = new Set(['--resume', '-r', '--session-id']);

// ps prints the command line with spaces between arguments, so an argument that holds a space cannot be told apart. The
// executable comes from its own column, which keeps paths such as "Application Support" whole.
function argv(proc) {
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

const codexId = (args) => {
  const at = args.indexOf('resume');
  return at === -1 ? null : args.slice(at + 1).find((a) => CODEX_ID.test(a)) ?? null;
};

// 'claude' or 'codex' when this process is one of them (directly, or a CLI script run by node), else null; with the
// arguments that follow the program.
function program(proc) {
  const args = argv(proc);
  const tool = programOf(proc.exe);
  if (tool) return { tool, args };
  if (/(^|\/)node$/.test(proc.exe) && args[0] && programOf(args[0])) return { tool: programOf(args[0]), args: args.slice(1) };
  return null;
}

// { tool, id } when this process's command line names the conversation it runs, else null.
export function resumeTarget(proc) {
  const found = program(proc);
  const id = found && (found.tool === 'claude' ? claudeId(found.args) : codexId(found.args));
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
  const [status, args] = await Promise.all([ps('pid=,ppid=,uid=,stat=,lstart=,comm='), ps('pid=,args=')]);
  return parsePs(status, args);
}

export function kill(pid, signal) {
  if (!fixtureFile()) return process.kill(pid, signal);
  const table = JSON.parse(fs.readFileSync(fixtureFile(), 'utf8'));
  const proc = table.processes.find((p) => p.pid === pid);
  if (!proc) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  table.signals = [...(table.signals ?? []), { pid, signal }];
  if (!proc.ignores?.includes(signal)) table.processes = table.processes.filter((p) => p !== proc);
  fs.writeFileSync(fixtureFile(), JSON.stringify(table));
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every copy of every conversation in one process listing. `terminals` are Pocket Dev's shells ({ id, pid, ... }); a
// program under one of them is that terminal's copy. A program under `selfPid` that is not in a terminal is a chat
// engine, which stops with its chat. Pocket Dev itself and the programs it runs under are never copies. `sessions` is
// readClaudeSessions(); a process it names holds that conversation as well as the one on its command line, because
// after /clear the command line still shows the conversation the process started with.
export function findCopies({ processes, uid, selfPid, terminals = [], sessions = [] }) {
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
    const ids = new Set([resumeTarget(proc)?.id, current?.sessionId].filter(Boolean));
    const chain = lineage(proc.pid);
    const terminal = chain.map((pid) => shells.get(pid)).find(Boolean);
    const kind = terminal ? 'terminal' : chain.includes(selfPid) ? 'engine' : 'process';
    for (const id of ids) {
      copies.push({ kind, tool: found.tool, id, proc, ...(terminal && { terminal }), busy: current?.sessionId === id && current.status === 'busy' });
    }
  }
  return copies;
}

const APPS = [['VS Code', /\/\.vscode(-insiders)?\/extensions\//], ['Cursor', /\/\.cursor\/extensions\//], ['the Claude app', /\/Application Support\/Claude\//]];

export function copyView(copy) {
  if (copy.kind === 'chat') return { kind: 'chat', id: copy.chat.id, label: `Pocket Dev chat "${copy.chat.title || 'New chat'}"` };
  if (copy.kind === 'terminal') return { kind: 'terminal', id: copy.terminal.id, pid: copy.proc.pid, label: `Pocket Dev terminal "${copy.terminal.title}"` };
  const app = APPS.find(([, re]) => re.test(copy.proc.exe))?.[0];
  const name = app ? `${copy.tool === 'claude' ? 'Claude Code' : 'Codex'} in ${app}` : path.basename(copy.proc.exe);
  return { kind: copy.kind, pid: copy.proc.pid, label: `${copy.kind === 'engine' ? 'Pocket Dev chat engine' : name} (pid ${copy.proc.pid})` };
}

async function waitForExit(procs, { isAlive, sleep, graceMs, pollMs = POLL_MS }) {
  let alive = procs;
  for (let waited = 0; ; waited += pollMs) {
    const checks = await Promise.all(alive.map((p) => isAlive(p)));
    alive = alive.filter((_, i) => checks[i]);
    if (!alive.length || waited >= graceMs) return alive;
    await sleep(pollMs);
  }
}

// SIGINT lets the program finish its write and exit; SIGTERM follows for one that keeps going. SIGKILL only with force,
// because it can cut off the last write. Each signal goes only to a process that is still the one that was matched, so a
// pid the system reused for something else is never signalled. Returns the signals sent per pid and what is still running.
export async function stopProcesses(procs, { kill: send, isAlive, sleep, force = false, graceMs = STOP_GRACE_MS }) {
  const steps = force ? ['SIGINT', 'SIGTERM', 'SIGKILL'] : ['SIGINT', 'SIGTERM'];
  const pids = new Set(procs.map((p) => p.pid));
  const sent = new Map();
  let alive = procs;
  for (const [step, signal] of steps.entries()) {
    // A wrapper (the codex node script) passes the first signal to the program it runs, so that program hears it once.
    const targets = step === 0 ? alive.filter((p) => !pids.has(p.ppid)) : alive;
    for (const p of targets) {
      if (!(await isAlive(p))) continue;
      try {
        send(p.pid, signal);
        sent.set(p.pid, [...(sent.get(p.pid) ?? []), signal]);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
    alive = await waitForExit(alive, { isAlive, sleep, graceMs });
    if (!alive.length) break;
  }
  return { sent, remaining: alive };
}

function where(copies) {
  if (copies.some((c) => c.kind === 'process')) return 'on the Mac';
  if (copies.some((c) => c.kind === 'terminal')) return 'in a Pocket Dev terminal';
  return 'in a Pocket Dev chat';
}

// `claudeSessions()` returns readClaudeSessions() for the Claude config folder in use. `terminals()` lists Pocket Dev's running shells as { id, title, cwd, pid, activeAt }; `endTerminal(id, note)` ends one.
// `chats()` lists chats whose engine is awake as { id, title, tool, sessionId, cwd, updatedAt }; `releaseChat(id, note)`
// stops one's engine. `log(type, fields)` writes the security log.
export function createTakeover({
  listProcesses: list = listProcesses, claudeSessions = () => [], kill: send = kill, isAlive, sleep = sleepFor, now = Date.now,
  uid = process.getuid(), selfPid = process.pid, log = () => {},
  terminals = () => [], endTerminal = () => false, chats = () => [], releaseChat = async () => false,
}) {
  isAlive ??= async (proc) => {
    const current = (await list()).find((p) => p.pid === proc.pid);
    return Boolean(current && current.uid === proc.uid && current.exe === proc.exe
      && Number.isFinite(proc.started) && current.started === proc.started
      && current.args === proc.args && !current.stat.startsWith('Z'));
  };

  async function survey() {
    const copies = findCopies({ processes: await list(), uid, selfPid, terminals: terminals(), sessions: claudeSessions() });
    for (const chat of chats()) if (chat.sessionId) copies.push({ kind: 'chat', tool: chat.tool, id: chat.sessionId, chat });
    return copies;
  }

  const refuse = (body) => ({ status: 409, body });

  // `scope` 'all' closes every copy; 'pocket-dev' closes only Pocket Dev's own, for a Mac terminal that resumes the
  // conversation itself. `note` is what the closed Pocket Dev terminal or chat shows. `who` names who asked, for the log.
  async function takeOver({ tool, id, mtimeMs, force = false, confirmBusy = false, scope = 'all', note, who = {} }) {
    const ours = (c) => c.tool === tool && c.id === id && (scope === 'all' || c.kind !== 'process');
    const found = (await survey()).filter(ours);
    const busy = now() - mtimeMs < BUSY_MS || found.some((c) => c.busy);
    if (!found.length) {
      if (scope === 'all' && now() - mtimeMs < LIVE_MS) return refuse({ code: 'not-found', busy, error: NOT_FOUND });
      return { status: 200, body: { stopped: [], busy } };
    }
    if (busy && !confirmBusy) {
      return refuse({ code: 'busy', busy, copies: found.map(copyView), error: `${TOOL_LABELS[tool]} is still working ${where(found)}. Taking over stops that reply.` });
    }

    const stopped = [];
    const external = found.filter((c) => c.kind === 'process');
    const terminalIds = [...new Set(found.filter((c) => c.kind === 'terminal').map((c) => c.terminal.id))];
    const [{ sent }] = await Promise.all([
      stopProcesses(external.map((c) => c.proc), { kill: send, isAlive, sleep, force }),
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
    const pids = found.filter((c) => c.proc).map((c) => c.proc.pid);
    if (left.length) {
      log('conversation-takeover-failed', { tool, conversationId: id, pids, remaining: left.filter((c) => c.proc).map((c) => c.proc.pid), force, ...who });
      const canForce = !force && left.every((c) => c.kind === 'process');
      const names = left.map((c) => copyView(c).label).join(', ');
      return refuse({
        code: 'still-running', busy, canForce, stopped, remaining: left.map(copyView),
        error: canForce
          ? `${names} did not close when asked. Force quit stops it at once, and its last reply may be lost.`
          : `${names} did not close. Close it on the Mac, then try again.`,
      });
    }
    log('conversation-taken-over', { tool, conversationId: id, pids, stopped: stopped.map((s) => s.kind), force, ...who });
    return { status: 200, body: { stopped, busy } };
  }

  return { survey, takeOver };
}
