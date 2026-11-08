import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTakeover, readClaudeSessions, copyView, LIVE_MS, BUSY_MS } from './takeover.js';

const LINE_MAX = 256_000;
const CHUNK = 4 << 20;
const PARALLEL = 8;
const TITLE_MAX = 120;
const TEXT_MAX = 1500;
const DETAIL_MESSAGES = 20;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const claudeDir = () => process.env.POCKET_DEV_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
export const claudeSessionsDir = () => path.join(path.dirname(claudeDir()), 'sessions');
const codexDir = () => process.env.POCKET_DEV_CODEX_DIR || path.join(os.homedir(), '.codex');

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

// Calls onLine with a Buffer for every complete line in [start, end). Lines longer than LINE_MAX are skipped:
// they are tool output or pasted images, never the text a person needs to recognise a session.
// Returns the offset just past the last newline, so a half-written final line is read next time.
async function scanLines(file, start, end, onLine) {
  const fh = await fs.promises.open(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = start;
  let lineStart = start;
  let parts = [];
  let partLen = 0;
  try {
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let from = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
        if (partLen + nl - from <= LINE_MAX) {
          const line = parts.length ? Buffer.concat([...parts, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
          if (line.length) onLine(line);
        }
        parts = [];
        partLen = 0;
        from = nl + 1;
        lineStart = pos + from;
      }
      partLen += bytesRead - from;
      if (partLen <= LINE_MAX) parts.push(Buffer.from(chunk.subarray(from)));
      else parts = [];
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return lineStart;
}

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

const SHELL_TOOLS = /^(Bash|shell|exec_command|local_shell)$/;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/;

function toolNote(name, input, cwd) {
  const file = input?.file_path ?? input?.notebook_path ?? input?.path;
  const arg = input?.command ?? input?.cmd ?? file ?? input?.pattern ?? input?.url
    ?? Object.values(input ?? {}).find((v) => typeof v === 'string') ?? '';
  let flat = oneLine(Array.isArray(arg) ? arg.join(' ') : String(arg));
  if (cwd) flat = flat.replaceAll(`${cwd}/`, '').replaceAll(`cd ${cwd} && `, '');
  // A path's tail (the file name) matters more than its head.
  const text = arg === file && flat.length > 80 ? `…${flat.slice(-79)}` : clip(flat, 80);
  if (EDIT_TOOLS.test(name)) return `✏️ ${name} ${text}`.trimEnd();
  return `▶ ${SHELL_TOOLS.test(name) ? 'ran ' : ''}${name}${text ? `: ${text}` : ''}`;
}

// Codex's code-mode tool wraps shell calls in JavaScript: text(await tools.exec_command({cmd:"ls"})).
function codexScriptNote(name, script, cwd) {
  const cmd = /exec_command\(\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(script);
  const command = cmd && parse(cmd[1]);
  return typeof command === 'string' ? toolNote('exec_command', { cmd: command }, cwd) : toolNote(name, { input: script }, cwd);
}

// Tags Claude Code and IDEs wrap around injected context: <command-name>, <local-command-stdout>,
// <system-reminder>, <ide_opened_file>, <task-notification>, ...
const isInjected = (text) => /^\s*(<[A-Za-z][\w-]*[\s>/]|Caveat:|\[Request interrupted)/.test(text);

const has = (line, needles) => needles.some((n) => line.includes(n));

const CLAUDE_TITLE_LINE = /^\{"type":"(ai-title|summary|custom-title|relocated)"/;
const CLAUDE_MESSAGE_TYPES = ['"type":"user"', '"type":"assistant"'];
const CLAUDE_TOOL_TYPES = ['"type":"tool_result"', '"type":"tool_use"'];

const claude = {
  // Cheap byte test before JSON.parse: tool calls, tool results and bookkeeping lines never change the summary.
  summaryLine: (line) => CLAUDE_TITLE_LINE.test(line.toString('latin1', 0, 32))
    || (has(line, CLAUDE_MESSAGE_TYPES) && !has(line, CLAUDE_TOOL_TYPES)),

  async files() {
    const root = claudeDir();
    const dirs = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      for (const name of await fs.promises.readdir(path.join(root, dir.name)).catch(() => [])) {
        if (name.endsWith('.jsonl')) out.push({ id: name.slice(0, -6), file: path.join(root, dir.name, name) });
      }
    }
    return out;
  },

  messages(o, cwd) {
    if (o.isSidechain || o.isMeta || o.isCompactSummary) return [];
    const time = o.timestamp;
    const content = o.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (o.type === 'user') {
      const text = blocks.filter((b) => b.type === 'text' && !isInjected(b.text)).map((b) => b.text.trim()).join('\n\n');
      return text ? [{ role: 'user', text, time }] : [];
    }
    if (o.type !== 'assistant') return [];
    return blocks.flatMap((b) => {
      if (b.type === 'text' && b.text.trim()) return [{ role: 'assistant', text: b.text.trim(), time }];
      if (b.type === 'tool_use') return [{ role: 'tool', text: toolNote(b.name, b.input, cwd), time }];
      return [];
    });
  },

  observe(acc, o) {
    if (o.type === 'custom-title' && o.customTitle) acc.customTitle = o.customTitle;
    if ((o.type === 'ai-title' && o.aiTitle) || (o.type === 'summary' && o.summary)) acc.title = o.aiTitle || o.summary;
    // Sessions move between dirs (worktrees, cd); resume only finds them from the dir the file is filed under.
    const cwd = o.cwd || o.relocatedCwd;
    if (typeof cwd === 'string' && !acc.cwdLocked) {
      acc.cwd ??= cwd;
      if (cwd.replace(/[^A-Za-z0-9]/g, '-') === path.basename(path.dirname(acc.file))) {
        acc.cwd = cwd;
        acc.cwdLocked = true;
      }
    }
  },

  resumeArgv: (id) => ['claude', ['--resume', id]],
};

const CODEX_INJECTED = /^\s*(<[A-Za-z][\w-]*[\s>/]|# (AGENTS\.md|Context from my IDE|Files (mentioned|pasted) by|Environment variables))/;

function codexUserText(text) {
  const asked = /## My request(?: for Codex)?:\s*\n/g;
  let last = -1;
  for (let m = asked.exec(text); m; m = asked.exec(text)) last = m.index + m[0].length;
  if (last !== -1) return text.slice(last).trim();
  return CODEX_INJECTED.test(text) ? '' : text.trim();
}

let codexIndex = { key: '', names: new Map() };

// Codex writes the record type in the first ~100 bytes: {"timestamp":…,"ordinal":…,"type":"response_item","payload":{"type":"message"
const CODEX_SUMMARY_LINE = /"type":"(session_meta|response_item","payload":\{"type":"message)"/;

const codex = {
  summaryLine: (line) => CODEX_SUMMARY_LINE.test(line.toString('latin1', 0, 200)),

  async files() {
    const out = [];
    const walk = async (dir) => {
      for (const ent of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(full);
        else {
          const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(ent.name);
          if (m) out.push({ id: m[1], file: full });
        }
      }
    };
    await walk(path.join(codexDir(), 'sessions'));
    return out;
  },

  // Codex keeps its generated thread names outside the rollout files.
  async names() {
    const file = path.join(codexDir(), 'session_index.jsonl');
    const st = await fs.promises.stat(file).catch(() => null);
    const key = st ? `${st.size}:${st.mtimeMs}` : '';
    if (key === codexIndex.key) return codexIndex.names;
    const names = new Map();
    if (st) await scanLines(file, 0, st.size, (line) => {
      const o = parse(line.toString());
      if (o?.id && o.thread_name) names.set(o.id, o.thread_name);
    });
    codexIndex = { key, names };
    return names;
  },

  messages(o, cwd) {
    const p = o.payload;
    if (o.type !== 'response_item' || !p) return [];
    const time = o.timestamp;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const texts = (p.content ?? []).filter((b) => typeof b.text === 'string').map((b) => b.text);
      const text = (p.role === 'user' ? texts.map(codexUserText) : texts.map((t) => t.trim())).filter(Boolean).join('\n\n');
      return text ? [{ role: p.role, text, time }] : [];
    }
    if (p.type === 'function_call') return [{ role: 'tool', text: toolNote(p.name, parse(p.arguments) ?? {}, cwd), time }];
    if (p.type === 'custom_tool_call') return [{ role: 'tool', text: codexScriptNote(p.name, String(p.input ?? ''), cwd), time }];
    return [];
  },

  observe(acc, o) {
    if (o.type !== 'session_meta') return;
    acc.cwd = o.payload?.cwd ?? acc.cwd;
    // Subagent threads (spawned workers, the approval guardian) are not conversations a person resumes.
    if (o.payload?.source?.subagent) acc.hidden = true;
  },

  resumeArgv: (id) => ['codex', ['resume', id]],
};

const TOOLS = { claude, codex };
const TOOL_LABELS = { claude: 'Claude', codex: 'Codex' };

// [program, args] that continue a conversation in a terminal.
export const resumeArgv = (tool, id) => TOOLS[tool].resumeArgv(id);
// The id passed ID_RE and names a file in the store, so the command is safe to type into a shell.
const resumeCommand = (tool, id) => resumeArgv(tool, id).flat().join(' ');

// Per-file summaries, extended in place as the jsonl grows (both tools only ever append).
const summaries = new Map();

const freshSummary = (tool, id, file) => ({
  tool, id, file, offset: 0, size: -1, mtimeMs: 0,
  cwd: null, cwdLocked: false, title: null, customTitle: null, firstPrompt: null,
  lastActive: null, messageCount: 0, hidden: false,
});

const scanning = new Map();

// Concurrent requests (and the startup warm-up) share one scan per file instead of racing on the summary.
function summarize(tool, entry, st) {
  const s = summaries.get(entry.file);
  if (s && s.size === st.size && s.mtimeMs === st.mtimeMs) return s;
  if (!scanning.has(entry.file)) {
    scanning.set(entry.file, extend(tool, entry, st).finally(() => scanning.delete(entry.file)));
  }
  return scanning.get(entry.file);
}

async function extend(tool, { id, file }, st) {
  let s = summaries.get(file);
  if (!s || st.size < s.offset) s = freshSummary(tool, id, file);
  const adapter = TOOLS[tool];
  s.offset = await scanLines(file, s.offset, st.size, (line) => {
    const o = adapter.summaryLine(line) && parse(line.toString());
    if (!o) return;
    adapter.observe(s, o);
    for (const m of adapter.messages(o)) {
      if (m.role === 'tool') continue;
      s.messageCount++;
      if (m.time) s.lastActive = m.time;
      if (m.role === 'user' && !s.firstPrompt) s.firstPrompt = m.text;
    }
  });
  s.size = st.size;
  s.mtimeMs = st.mtimeMs;
  summaries.set(file, s);
  return s;
}

// Copies of each conversation that are running now, by `${tool}:${id}`, from one survey().
function byConversation(copies) {
  const held = new Map();
  for (const c of copies) held.set(`${c.tool}:${c.id}`, [...(held.get(`${c.tool}:${c.id}`) ?? []), c]);
  return held;
}

// A conversation is live while a program has it open (see takeover.js) or its file was written in the last two
// minutes, which also covers a program the survey cannot identify. `openIn` says where: 'mac' when another program on
// the Mac has it, 'pocket-dev' when only a Pocket Dev terminal or chat has it, null when only the file says so.
function view(s, held, names) {
  const title = s.customTitle || names.get(s.id) || s.title || s.firstPrompt || '(untitled)';
  const copies = held.get(`${s.tool}:${s.id}`) ?? [];
  return {
    tool: s.tool,
    id: s.id,
    cwd: s.cwd,
    project: s.cwd ? path.basename(s.cwd) : '',
    title: clip(oneLine(title), TITLE_MAX),
    lastActive: s.lastActive ?? new Date(s.mtimeMs).toISOString(),
    messageCount: s.messageCount,
    live: copies.length > 0 || Date.now() - s.mtimeMs < LIVE_MS,
    openIn: copies.some((c) => c.kind === 'process') ? 'mac' : copies.length ? 'pocket-dev' : null,
  };
}

const listable = (s) => !s.hidden && s.messageCount > 0 && Boolean(s.firstPrompt || s.title || s.customTitle);

async function statAll(tools) {
  const lists = await Promise.all(tools.map(async (tool) => (await TOOLS[tool].files()).map((f) => ({ tool, ...f }))));
  const entries = await Promise.all(lists.flat().map(async (f) => ({ ...f, st: await fs.promises.stat(f.file).catch(() => null) })));
  return entries.filter((e) => e.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
}

// Walks files newest-first and stops once `limit` sessions qualify, so old multi-hundred-MB sessions
// are never read for the list. Sorting by mtime approximates sorting by last message time.
async function listSessions(tools, limit, held = new Map()) {
  const [entries, names] = await Promise.all([statAll(tools), codex.names()]);
  const picked = [];
  for (let i = 0; i < entries.length && picked.length < limit; i += PARALLEL) {
    const batch = entries.slice(i, i + PARALLEL);
    for (const s of await Promise.all(batch.map((e) => summarize(e.tool, e, e.st)))) {
      if (listable(s) && picked.length < limit) picked.push(view(s, held, names));
    }
  }
  return picked.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

async function findSession(tool, id) {
  const f = (await TOOLS[tool].files()).find((x) => x.id === id);
  const st = f && await fs.promises.stat(f.file).catch(() => null);
  if (!st) return null;
  const s = await summarize(tool, f, st);
  return listable(s) ? s : null;
}

// Reads backwards in growing windows until the tail holds enough text messages, so a 150 MB
// session costs a few hundred KB instead of a full parse.
async function lastMessages(s) {
  const adapter = TOOLS[s.tool];
  let window = 512 * 1024;
  for (;;) {
    const start = Math.max(0, s.offset - window);
    const msgs = [];
    let skipFirst = start > 0;
    await scanLines(s.file, start, s.offset, (line) => {
      if (skipFirst) { skipFirst = false; return; }
      const o = parse(line.toString());
      if (o) msgs.push(...adapter.messages(o, s.cwd));
    });
    const texts = msgs.filter((m) => m.role !== 'tool').length;
    if (texts >= DETAIL_MESSAGES || start === 0) return collapse(msgs);
    window *= 4;
  }
}

function collapse(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (m.role === 'tool' && prev?.role === 'tool') prev.text += `\n${m.text}`;
    else out.push({ ...m });
  }
  let texts = 0;
  let from = out.length;
  while (from > 0 && texts < DETAIL_MESSAGES) if (out[--from].role !== 'tool') texts++;
  return out.slice(from).map((m) => ({
    role: m.role,
    text: m.role === 'tool' ? m.text.split('\n').slice(-8).join('\n') : clip(m.text, TEXT_MAX),
    time: m.time ?? null,
  }));
}

// The CLI has only the id.
export async function findConversation(id) {
  if (!ID_RE.test(id ?? '')) return null;
  for (const tool of Object.keys(TOOLS)) {
    const s = await findSession(tool, id);
    if (s) return { tool, id: s.id, cwd: s.cwd };
  }
  return null;
}

const toBool = (v, name) => {
  if (v === undefined || typeof v === 'boolean') return v ?? false;
  throw Object.assign(new Error(`${name} must be true or false`), { status: 400 });
};

// Mount after the auth check. `own` reaches Pocket Dev's own copies of a conversation, { terminals, endTerminal, chats,
// releaseChat } as createTakeover describes them; `system` replaces process listing and signals in tests. `deviceFor`
// and `log` name the device that takes a conversation over in the security log.
export function createHistoryApi({ createSession, sessionView, sendJson, readJson, deviceFor, log, own = {}, system = {} }) {
  const takeover = createTakeover({ claudeSessions: () => readClaudeSessions(claudeSessionsDir()), log, ...own, ...system });
  // The list and the detail still load when the process table cannot be read; take over itself reports the error.
  const survey = () => takeover.survey().catch(() => []);
  // The first scan reads a few hundred MB of jsonl; do it at startup so the phone's first list is warm.
  listSessions(Object.keys(TOOLS), 30).catch(() => {});

  async function handleHistory(req, res, pathname) {
    const [, , , tool, id, action] = pathname.split('/');
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && !tool) {
      const filter = url.searchParams.get('tool') || 'all';
      if (filter !== 'all' && !Object.hasOwn(TOOLS, filter)) return sendJson(res, 400, { error: 'tool must be all, claude or codex' });
      const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 30));
      return sendJson(res, 200, await listSessions(filter === 'all' ? Object.keys(TOOLS) : [filter], limit, byConversation(await survey())));
    }

    if (!Object.hasOwn(TOOLS, tool)) return sendJson(res, 400, { error: 'Unknown tool' });
    if (!ID_RE.test(id ?? '')) return sendJson(res, 400, { error: 'Bad session id' });
    const route = `${req.method} ${action ?? ''}`;
    if (!['GET ', 'POST resume', 'POST takeover'].includes(route)) return sendJson(res, 404, { error: 'Not found' });

    const s = await findSession(tool, id);
    if (!s) return sendJson(res, 404, { error: 'No such conversation' });

    if (route === 'GET ') {
      const [copies, names] = await Promise.all([survey(), codex.names()]);
      const mine = copies.filter((c) => c.tool === tool && c.id === s.id);
      const busy = Date.now() - s.mtimeMs < BUSY_MS || mine.some((c) => c.busy);
      return sendJson(res, 200, { ...view(s, byConversation(mine), names), busy, copies: mine.map(copyView), messages: await lastMessages(s) });
    }

    // Closes every running copy, so the continue the phone sends next is the only writer.
    if (route === 'POST takeover') {
      const device = deviceFor(req);
      if (!device) return sendJson(res, 403, { error: 'Only your own devices can take over a conversation.' });
      const body = await readJson(req);
      const r = await takeover.takeOver({
        tool, id: s.id, mtimeMs: s.mtimeMs, force: toBool(body.force, 'force'), confirmBusy: toBool(body.confirmBusy, 'confirmBusy'),
        note: 'Continued in another Pocket Dev tab', who: { by: 'phone', deviceId: device.id, name: device.name, ip: device.ip },
      });
      return sendJson(res, r.status, r.body);
    }

    const cwdExists = s.cwd && fs.statSync(s.cwd, { throwIfNoEntry: false })?.isDirectory();
    const project = !s.cwd ? id.slice(0, 8) : s.cwd === os.homedir() ? '~' : path.basename(s.cwd);
    const session = await createSession(cwdExists ? s.cwd : os.homedir(), `${tool} · ${project}`, resumeCommand(tool, s.id));
    const note = cwdExists ? undefined : `${s.cwd || 'The original folder'} no longer exists, so this terminal starts in your home folder.`;
    return sendJson(res, 201, { ...sessionView(session), note });
  }

  // The Admin page's "Open in Pocket Dev": conversations a Pocket Dev terminal or chat has open, each with the command
  // that moves it to a terminal on the Mac. That command, `pocket-dev takeover`, calls act() to close Pocket Dev's copy.
  // The page has no button for it, so the section has no `action`.
  handleHistory.openHere = {
    title: 'Open in Pocket Dev',
    empty: 'No conversation is open in a Pocket Dev terminal or chat.',
    async list() {
      const held = byConversation((await takeover.survey()).filter((c) => c.kind === 'terminal' || c.kind === 'chat'));
      const names = await codex.names();
      const items = await Promise.all([...held.values()].map(async (copies) => {
        const { tool, id } = copies[0];
        const s = await findSession(tool, id);
        const cwd = s?.cwd ?? copies[0].chat?.cwd ?? copies[0].terminal?.cwd ?? null;
        return {
          id: `${tool}:${id}`,
          label: s ? view(s, held, names).title : copies[0].chat?.title || copies[0].terminal?.title || id,
          details: [`${TOOL_LABELS[tool]} in ${copies.map((c) => copyView(c).label.replace(/^Pocket Dev /, '')).join(', ')}`, ...(cwd ? [cwd] : []), `On the Mac, run: pocket-dev takeover ${id}`],
          tool, conversationId: id, cwd,
          busy: Boolean(s && Date.now() - s.mtimeMs < BUSY_MS) || copies.some((c) => c.busy || c.chat?.status === 'running'),
          activeAt: Math.max(...copies.map((c) => c.chat?.updatedAt ?? c.terminal?.activeAt ?? 0)),
        };
      }));
      return items.sort((a, b) => b.activeAt - a.activeAt);
    },
    async act(item) {
      const [tool, id] = item.split(':');
      if (!Object.hasOwn(TOOLS, tool) || !ID_RE.test(id ?? '')) return false;
      const s = await findSession(tool, id);
      const r = await takeover.takeOver({ tool, id, mtimeMs: s?.mtimeMs ?? 0, scope: 'pocket-dev', confirmBusy: true, note: 'Continued on your Mac', who: { by: 'mac' } });
      if (r.status !== 200) throw Object.assign(new Error(r.body.error), { status: r.status });
      return r.body.stopped.length > 0;
    },
  };
  return handleHistory;
}
