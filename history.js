import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createTakeover, readClaudeSessions, readCodexLocks, copyView, LIVE_MS, BUSY_MS } from './takeover.js';
import { readAgents, sessionFile } from './terminal-agents.js';
import { platform } from './platform.js';
import { listAntigravity, findAntigravity, antigravityMessages, ANTIGRAVITY_NOTE } from './antigravity-history.js';
import { listCopilot, findCopilot, copilotMessages, COPILOT_NOTE } from './copilot-history.js';

const LINE_MAX = 256_000;
const CHUNK = 4 << 20;
const PARALLEL = 8;
const TITLE_MAX = 120;
const TEXT_MAX = 1500;
const DETAIL_MESSAGES = 20;
const HANDOVER_TICK_MS = 1500;
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

// Antigravity has no jsonl to scan: its sessions come from agy's summaries database (antigravity-history.js), already shaped
// like the summaries the two readers above build.
const antigravity = { custom: true, resumeArgv: (id) => ['agy', ['--conversation', id]] };
// GitHub Copilot keeps a folder per session (copilot-history.js), also shaped like those summaries.
const copilot = { custom: true, resumeArgv: (id) => ['copilot', ['--resume', id]] };

// The tools whose sessions are not a jsonl to scan: how each lists, finds and shows a conversation.
const CUSTOM = {
  antigravity: { list: listAntigravity, find: findAntigravity, messages: antigravityMessages, note: ANTIGRAVITY_NOTE },
  copilot: { list: listCopilot, find: findCopilot, messages: copilotMessages, note: COPILOT_NOTE },
};

const TOOLS = { claude, codex, antigravity, copilot };
const TOOL_LABELS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'Copilot' };

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
  const lists = await Promise.all(tools.filter((tool) => !TOOLS[tool].custom).map(async (tool) => (await TOOLS[tool].files()).map((f) => ({ tool, ...f }))));
  const entries = await Promise.all(lists.flat().map(async (f) => ({ ...f, st: await fs.promises.stat(f.file).catch(() => null) })));
  return entries.filter((e) => e.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
}

// Walks files newest-first and stops once `limit` sessions qualify, so old multi-hundred-MB sessions
// are never read for the list. Sorting by mtime approximates sorting by last message time.
async function listSessions(tools, limit, held = new Map(), accept = () => true) {
  const [entries, names, ...custom] = await Promise.all([statAll(tools), codex.names(), ...Object.keys(CUSTOM).map((tool) => (tools.includes(tool) ? CUSTOM[tool].list() : []))]);
  const picked = [];
  for (let i = 0; i < entries.length && picked.length < limit; i += PARALLEL) {
    const batch = entries.slice(i, i + PARALLEL);
    for (const s of await Promise.all(batch.map((e) => summarize(e.tool, e, e.st)))) {
      if (listable(s) && picked.length < limit) {
        const item = view(s, held, names);
        if (accept(item)) picked.push(item);
      }
    }
  }
  picked.push(...custom.flat().filter(listable).map((s) => view(s, held, names)).filter(accept));
  return picked.sort((a, b) => b.lastActive.localeCompare(a.lastActive)).slice(0, limit);
}

async function findSession(tool, id) {
  if (TOOLS[tool].custom) {
    const s = await CUSTOM[tool].find(id);
    return s && listable(s) ? s : null;
  }
  const f = (await TOOLS[tool].files()).find((x) => x.id === id);
  const st = f && await fs.promises.stat(f.file).catch(() => null);
  if (!st) return null;
  const s = await summarize(tool, f, st);
  return listable(s) ? s : null;
}

// Chat messages and tool steps in one native record.
function messagesOf(tool, o, cwd) {
  if (tool !== 'copilot') return TOOLS[tool].messages(o, cwd);
  if (!['user.message', 'assistant.message'].includes(o.type)) return [];
  const text = typeof o.data?.content === 'string' ? o.data.content.trim() : '';
  return text ? [{ role: o.type === 'user.message' ? 'user' : 'assistant', text, time: o.timestamp ?? null }] : [];
}

// Import is separate from the small Resume preview: the chat needs every readable user and assistant message,
// including long messages and old turns. Reading a line at a time avoids loading a large rollout into memory at once.
export async function readConversationMessages(tool, id) {
  if (!Object.hasOwn(TOOLS, tool) || !ID_RE.test(id ?? '')) return { messages: [] };
  const s = await findSession(tool, id);
  if (!s) return { messages: [] };
  if (tool === 'antigravity') return { messages: [], note: ANTIGRAVITY_NOTE };
  const messages = [];
  const input = fs.createReadStream(s.file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const o = parse(line);
      if (o) messages.push(...messagesOf(tool, o, s.cwd).filter((m) => m.role !== 'tool'));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { messages };
}

// What a program appended to a conversation's file since byte `from`: its messages, and `activity`, the tool step it is on
// (null after a message, undefined when nothing says). Only whole lines are read; `end` is where the next read starts.
async function readAppended(s, from) {
  const { size } = await fs.promises.stat(s.file);
  if (size < from) from = 0;
  const buf = Buffer.alloc(size - from);
  const fh = await fs.promises.open(s.file, 'r');
  try { await fh.read(buf, 0, buf.length, from); } finally { await fh.close(); }
  const whole = buf.lastIndexOf(10) + 1;
  const messages = [];
  let activity;
  for (const line of buf.subarray(0, whole).toString('utf8').split('\n')) {
    const o = parse(line);
    for (const m of o ? messagesOf(s.tool, o, s.cwd) : []) {
      if (m.role === 'tool') activity = m.text;
      else { messages.push(m); activity = null; }
    }
  }
  return { messages, activity, end: from + whole };
}

// Codex marks a turn in its rollout: task_started opens it, task_complete or turn_aborted closes it. The last of them in the
// tail says whether the thread is replying now; null when the file is missing or the tail has none.
const CODEX_TURN = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/;
const CODEX_TURN_TAIL_MAX = 16 << 20;
const codexFiles = new Map();
export async function codexInTurn(id) {
  if (!codexFiles.has(id)) for (const f of await codex.files()) codexFiles.set(f.id, f.file);
  const file = codexFiles.get(id);
  const st = file && await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  for (let window = 256 * 1024; ; window *= 4) {
    const start = Math.max(0, st.size - window);
    let last = null;
    let skipFirst = start > 0;
    await scanLines(file, start, st.size, (line) => {
      if (skipFirst) { skipFirst = false; return; }
      last = CODEX_TURN.exec(line.toString('latin1', 0, 200))?.[1] ?? last;
    });
    if (last) return last === 'task_started';
    if (start === 0 || window >= CODEX_TURN_TAIL_MAX) return null;
  }
}

// Reads backwards in growing windows until the tail holds enough text messages, so a 150 MB
// session costs a few hundred KB instead of a full parse.
async function lastMessages(s) {
  if (TOOLS[s.tool].custom) return CUSTOM[s.tool].messages(s);
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
// and `log` name the device that takes a conversation over in the security log. `resumeChat`, `mirrorChat` and
// `endChatHold` are the chat API's resumeSession, mirrorNative and endHold.
export function createHistoryApi({
  createSession, sessionView, sendJson, readJson, deviceFor, log, own = {}, system = {}, listChats = () => [],
  resumeChat, mirrorChat = () => false, endChatHold = () => false, handoverTickMs = HANDOVER_TICK_MS,
  isOwner = (req) => !req.roomPeer && Boolean(deviceFor(req)),
}) {
  const takeover = createTakeover({
    claudeSessions: () => readClaudeSessions(claudeSessionsDir()), codexLocks: () => readCodexLocks(path.join(codexDir(), 'thread-writer-locks')),
    codexBusy: codexInTurn, log, ...own, ...system,
  });
  // The list and the detail still load when the process table cannot be read; take over itself reports the error.
  const survey = () => takeover.survey().catch(() => []);
  const opening = new Set();
  // `${tool}:${id}` -> { chatId, stop } for the chat waiting for a program on the computer to finish with that conversation.
  const handovers = new Map();
  // The first scan reads a few hundred MB of jsonl; do it at startup so the phone's first list is warm.
  listSessions(Object.keys(TOOLS), 30).catch(() => {});

  async function unifiedChats(req, res, url) {
    if (!isOwner(req)) return sendJson(res, 403, { error: 'Only your own devices can see computer conversations.' });
    const offsetText = url.searchParams.get('offset') ?? '0';
    if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText)) || Number(offsetText) > 100_000) {
      return sendJson(res, 400, { error: 'offset must be an integer from 0 to 100000' });
    }
    const offset = Number(offsetText);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 30));
    const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
    if (query.length > 200) return sendJson(res, 400, { error: 'Search must be up to 200 characters.' });
    const matches = (item) => !query || [item.title, item.cwd, item.project, item.tool, TOOL_LABELS[item.tool]].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
    const chats = listChats();
    const represented = new Set();
    for (const chat of chats) {
      if (chat.sessionId) represented.add(`${chat.tool}:${chat.sessionId}`);
      for (const ref of chat.sessionRefs ?? []) if (ref.tool && (ref.id || ref.sessionId)) represented.add(`${ref.tool}:${ref.id || ref.sessionId}`);
    }
    const items = await listSessions(Object.keys(TOOLS), offset + limit + 1, byConversation(await survey()), (item) => !represented.has(`${item.tool}:${item.id}`) && matches(item));
    return sendJson(res, 200, { chats: chats.filter(matches), computer: items.slice(offset, offset + limit), hasMore: items.length > offset + limit });
  }

  async function openChat(req, res, tool, id, s) {
    if (!isOwner(req)) return sendJson(res, 403, { error: 'Only your own devices can open computer conversations.' });
    if (!resumeChat) return sendJson(res, 503, { error: 'Chat continuation is not available.' });
    const key = `${tool}:${id}`;
    const waiting = handovers.has(key) && listChats().find((c) => c.id === handovers.get(key).chatId);
    if (waiting) return sendJson(res, 200, { chat: waiting });
    if (opening.has(key)) return sendJson(res, 409, { code: 'opening', error: 'This conversation is already opening. Try again in a moment.' });
    opening.add(key);
    try {
      const body = await readJson(req);
      const force = toBool(body.force, 'force');
      const copies = await takeover.survey();
      const existing = listChats().find((c) => c.tool === tool && c.sessionId === id);
      const bound = (own.chats?.() ?? []).some((c) => c.id === existing?.id && c.tool === tool && c.sessionId === id);
      // Opening another view of an already-running Pocket Dev chat shares that chat. It must not stop its reply.
      if (existing && bound && !copies.some((c) => c.tool === tool && c.id === id && (c.kind === 'process' || c.kind === 'terminal' || (c.kind === 'chat' && c.chat?.id !== existing.id)))) {
        return sendJson(res, 200, { chat: existing });
      }
      if (!s) return sendJson(res, 404, { error: 'No such conversation' });
      const device = deviceFor(req);
      const who = { by: 'phone', deviceId: device.id, name: device.name, ip: device.ip };
      const result = await takeover.takeOver({ tool, id, mtimeMs: s.mtimeMs, force, note: 'Continued in Pocket Dev chat', who });
      if (result.status !== 200 && result.body.code !== 'busy') return sendJson(res, result.status, result.body);
      const title = view(s, new Map(), await codex.names()).title;
      const extra = CUSTOM[tool]?.note && { note: CUSTOM[tool].note };
      if (result.status === 200) return sendJson(res, 200, { chat: await resumeChat({ tool, id, cwd: s.cwd, title }), ...extra });
      // A program on the computer is still replying. The chat opens now, follows that reply, and takes over once it is idle.
      const offset = s.file ? (await fs.promises.stat(s.file).catch(() => null))?.size ?? 0 : 0;
      let handover;
      const chat = await resumeChat({ tool, id, cwd: s.cwd, title, heldBy: result.body.holder, stopHolder: () => handover.stop() });
      handover = watchHandover({ key, s, chatId: chat.id, offset, who });
      return sendJson(res, 200, { chat, ...extra });
    } finally {
      opening.delete(key);
    }
  }

  // Every tick copies what the program wrote into the chat, then tries the take over again; it succeeds once nothing is
  // replying, and any other refusal leaves the conversation on the computer. Stop asks the program to stop its reply now.
  // Ticks and Stop run one after another, so two take overs never signal the same program at once.
  function watchHandover({ key, s, chatId, offset, who }) {
    const { tool, id } = s;
    let activity = null;
    let ended = false;
    let queue = Promise.resolve();
    const mirror = async () => {
      if (!s.file) return mirrorChat(chatId, [], null);
      const read = await readAppended(s, offset);
      offset = read.end;
      if (read.activity !== undefined) activity = read.activity;
      return mirrorChat(chatId, read.messages, activity);
    };
    const end = (hold) => {
      ended = true;
      if (handovers.get(key) === handover) handovers.delete(key);
      try {
        if (hold) endChatHold(chatId, hold);
      } catch (err) {
        console.warn(`Could not end the hold on chat ${chatId}: ${err.message}`);
      }
    };
    const serial = (step) => (queue = queue.then(() => (ended ? undefined : step())).catch((err) => {
      end({ note: `Could not continue here: ${err.message}. Open it from Chats to try again.`, failed: true });
    }));
    const attempt = async (stopping) => {
      if (!(await mirror())) return end();
      const st = s.file && await fs.promises.stat(s.file).catch(() => null);
      const r = await takeover.takeOver({ tool, id, mtimeMs: st?.mtimeMs ?? s.mtimeMs, confirmBusy: stopping, note: 'Continued in Pocket Dev chat', who });
      if (r.status === 200) {
        await mirror();
        if (!stopping) return end({ note: `Continued here from your ${platform.host.mac}` });
        // SIGKILL is what Windows does when the program has no console for a Ctrl+C, or ignores it: an end mid-write.
        const cut = r.body.busy && r.body.stopped.some((c) => c.signals?.includes('SIGKILL'));
        return end({ note: `Stopped the reply on your ${platform.host.mac}.${cut ? ' Its last step may be lost.' : ''} The conversation continues here.` });
      }
      // A program that did not close after Stop keeps the hold; the ticks go on waiting for it.
      if (r.body.code === 'busy' || (stopping && r.body.code === 'still-running')) return undefined;
      return end({ note: `${r.body.error} Open it from Chats to continue here.`, failed: true });
    };
    const tick = () => serial(() => attempt(false)).then(() => { if (!ended) setTimeout(tick, handoverTickMs).unref(); });
    setTimeout(tick, handoverTickMs).unref();
    const handover = { chatId, stop: () => serial(() => attempt(true)) };
    handovers.set(key, handover);
    return handover;
  }

  // The helper agents of the Claude Code session running in one Pocket Dev terminal. The phone asks every few seconds, so
  // the process table is read at most once in a while and the session file is read from its end only. A terminal that is
  // not running Claude Code, and Codex, answer with no agents.
  const AGENTS_SURVEY_MS = 4000;
  let agentSurvey = { at: 0, copies: [] };
  async function terminalAgents(req, res, url) {
    if (!deviceFor(req)) return sendJson(res, 403, { error: "Only your own devices can see a terminal's agents." });
    const terminalId = url.searchParams.get('terminalId') ?? '';
    if (!(own.terminals?.() ?? []).some((t) => t.id === terminalId)) return sendJson(res, 404, { error: 'No such terminal' });
    if (Date.now() - agentSurvey.at > AGENTS_SURVEY_MS) agentSurvey = { at: Date.now(), copies: await survey() };
    const copy = agentSurvey.copies.find((c) => c.kind === 'terminal' && c.tool === 'claude' && c.terminal.id === terminalId);
    const file = copy && sessionFile(copy.id);
    return sendJson(res, 200, { sessionId: copy?.id ?? null, agents: file ? readAgents(file) : [] });
  }

  // "Continue on Mac": closes Pocket Dev's own copy of a conversation so the Mac's Claude or Codex can resume it, and
  // answers with the command to run there. A terminal is named by its id; the conversation it holds is found from its
  // processes. A chat is named by tool and conversation id, and a chat that is asleep has no copy to close.
  async function continueOnMac(req, res) {
    const device = deviceFor(req);
    if (!device) return sendJson(res, 403, { error: `Only your own devices can continue a conversation on ${platform.host.the}.` });
    const body = await readJson(req);
    let { tool, id } = body;
    let terminal;
    if (typeof body.terminalId === 'string') {
      const copy = (await takeover.survey()).find((c) => c.kind === 'terminal' && c.terminal.id === body.terminalId);
      if (!copy) return sendJson(res, 404, { error: 'No Claude or Codex conversation is open in this terminal.' });
      ({ tool, id, terminal } = copy);
    }
    if (!Object.hasOwn(TOOLS, tool) || !ID_RE.test(id ?? '')) return sendJson(res, 400, { error: 'Name a terminal, or a tool and conversation id.' });
    const s = await findSession(tool, id);
    if (!s) return sendJson(res, 404, { error: 'This conversation has no history to resume yet. Send a message first.' });
    const r = await takeover.takeOver({
      tool, id: s.id, mtimeMs: s.mtimeMs, scope: 'pocket-dev', confirmBusy: toBool(body.confirmBusy, 'confirmBusy'),
      note: `Continued on your ${platform.host.mac}`, who: { by: 'phone', deviceId: device.id, name: device.name, ip: device.ip },
    });
    if (r.status !== 200) return sendJson(res, r.status, r.body);
    const cwd = s.cwd ?? terminal?.cwd ?? null;
    return sendJson(res, 200, { ...r.body, tool, id: s.id, cwd, command: resumeCommand(tool, s.id) });
  }

  async function handleHistory(req, res, pathname) {
    const [, , , tool, id, action] = pathname.split('/');
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && tool === 'chats' && !id) return unifiedChats(req, res, url);

    if (req.method === 'POST' && tool === 'mac' && !id) return continueOnMac(req, res);
    if (req.method === 'GET' && tool === 'agents' && !id) return terminalAgents(req, res, url);

    if (req.method === 'GET' && !tool) {
      const filter = url.searchParams.get('tool') || 'all';
      if (filter !== 'all' && !Object.hasOwn(TOOLS, filter)) return sendJson(res, 400, { error: `tool must be all, ${Object.keys(TOOLS).join(', ')}`.replace(/, ([a-z]+)$/, ' or $1') });
      const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 30));
      return sendJson(res, 200, await listSessions(filter === 'all' ? Object.keys(TOOLS) : [filter], limit, byConversation(await survey())));
    }

    if (!Object.hasOwn(TOOLS, tool)) return sendJson(res, 400, { error: 'Unknown tool' });
    if (!ID_RE.test(id ?? '')) return sendJson(res, 400, { error: 'Bad session id' });
    const route = `${req.method} ${action ?? ''}`;
    if (!['GET ', 'POST resume', 'POST takeover', 'POST open-chat'].includes(route)) return sendJson(res, 404, { error: 'Not found' });

    if (route === 'POST open-chat' && !isOwner(req)) return sendJson(res, 403, { error: 'Only your own devices can open computer conversations.' });

    const s = await findSession(tool, id);
    if (route === 'POST open-chat') return openChat(req, res, tool, id, s);

    if (!s) return sendJson(res, 404, { error: 'No such conversation' });

    if (route === 'GET ') {
      const [copies, names] = await Promise.all([survey(), codex.names()]);
      const mine = copies.filter((c) => c.tool === tool && c.id === s.id);
      const busy = Date.now() - s.mtimeMs < BUSY_MS || mine.some((c) => c.busy);
      return sendJson(res, 200, { ...view(s, byConversation(mine), names), busy, copies: mine.map(copyView), messages: await lastMessages(s), ...(CUSTOM[tool]?.note && { note: CUSTOM[tool].note }) });
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

  // The Admin page's "Open in Pocket Dev": conversations a Pocket Dev terminal or chat has open. "Continue on Mac" calls
  // act() to close Pocket Dev's copy, and the row shows the command that resumes it in a terminal here.
  handleHistory.openHere = {
    title: 'Open in Pocket Dev',
    empty: 'No conversation is open in a Pocket Dev terminal or chat.',
    action: 'Continue on Mac',
    warning: `Pocket Dev closes its copy so only one program writes the conversation. Then run the command shown in a terminal on ${platform.host.the}.`,
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
          details: [`${TOOL_LABELS[tool]} in ${copies.map((c) => copyView(c).label.replace(/^Pocket Dev /, '')).join(', ')}`, ...(cwd ? [cwd] : []), `Then run: ${resumeCommand(tool, id)}`],
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
      const r = await takeover.takeOver({ tool, id, mtimeMs: s?.mtimeMs ?? 0, scope: 'pocket-dev', confirmBusy: true, note: `Continued on your ${platform.host.mac}`, who: { by: 'mac' } });
      if (r.status !== 200) throw Object.assign(new Error(r.body.error), { status: r.status });
      return r.body.stopped.length > 0;
    },
  };
  return handleHistory;
}
