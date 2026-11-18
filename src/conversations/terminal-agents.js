import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Helper agents that a Claude Code session in a terminal has started, read from the session's own files. Claude Code writes
// one JSON line per event to ~/.claude/projects/<folder>/<session>.jsonl and keeps each agent's own log and a small
// meta.json next to it in <session>/subagents/. Three facts decide an agent's state:
//   - the Agent (or Task) call, and its result. A foreground agent is done when the result arrives.
//   - for a background agent the result only says it was launched ({ isAsync, agentId }). The end comes later as a
//     <task-notification> line with a status.
//   - subagents/agent-<agentId>.meta.json says finished: true when the agent is over, and its .jsonl keeps growing while it works.
// Nothing here is written back and nothing outside the session's own files is read.

export const TAIL_BYTES = 6 * 1024 * 1024;
// The same minute and a half the Chat panel uses for an agent whose state nobody reported.
export const ACTIVE_MS = 90_000;
// An agent with a meta file that is not finished may be quiet for a long tool call; give up on it after this long.
export const QUIET_MS = 15 * 60_000;
const LATEST_BYTES = 96 * 1024;
const MAX_AGENTS = 24;

const HELPERS = new Set(['Agent', 'Task']);
const NOTIFICATION = { completed: 'completed', failed: 'failed', killed: 'failed', stopped: 'failed', error: 'failed' };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const claudeProjectsDir = () => process.env.POCKET_DEV_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');

// The jsonl of one conversation: the folder is named after the working directory, so look in each folder for the id.
export function sessionFile(sessionId, root = claudeProjectsDir()) {
  if (!ID_RE.test(sessionId ?? '')) return null;
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The last `max` bytes of a file as whole lines. A cut line at the start is dropped.
export function tailLines(file, max = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const NOTE = /<task-notification>([\s\S]*?)<\/task-notification>/;
const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim();

// Pure: session lines in, one record per agent call out, in the order they were started.
export function parseAgents(lines) {
  const agents = new Map();
  // Claude Code does not always write a launch result after the call it answers, so results for calls not seen yet wait here.
  const early = new Map();
  const launch = (agent, agentId) => {
    agent.async = true;
    if (typeof agentId === 'string' && ID_RE.test(agentId)) agent.agentId = agentId;
  };
  const note = (toolUseId, status) => {
    const agent = agents.get(toolUseId);
    if (agent && NOTIFICATION[status]) agent.ended = NOTIFICATION[status];
  };
  for (const line of lines) {
    if (!line) continue;
    const launches = line.includes('"name":"Agent"') || line.includes('"name":"Task"');
    const notice = line.includes('<task-notification>');
    const result = line.includes('"tool_result"');
    if (!launches && !notice && !result) continue;
    if (result && !launches && !notice && !line.includes('Async agent launched') && ![...agents.keys()].some((id) => line.includes(id))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (notice) {
      const text = typeof o.content === 'string' ? o.content : JSON.stringify(o.message?.content ?? '');
      const m = text.match(NOTE);
      if (m) note(tag(m[1], 'tool-use-id'), tag(m[1], 'status'));
    }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      // Claude Code writes some calls twice; the first record stands.
      if (b.type === 'tool_use' && HELPERS.has(b.name) && typeof b.id === 'string' && !agents.has(b.id)) {
        const input = b.input ?? {};
        agents.set(b.id, {
          id: b.id,
          label: String(input.description || input.name || input.subagent_type || b.name).slice(0, 160),
          name: typeof input.name === 'string' ? input.name : null,
          startedAt: Date.parse(o.timestamp) || null,
          agentId: null, async: false, resultAt: null, failed: false, ended: null,
        });
        if (early.has(b.id)) launch(agents.get(b.id), early.get(b.id));
      } else if (b.type === 'tool_result') {
        const launched = o.toolUseResult;
        // The launch result is written twice and only the first copy carries toolUseResult, so the text counts too.
        const asyncLaunch = (launched && typeof launched === 'object' && launched.isAsync) || JSON.stringify(b.content ?? '').includes('Async agent launched');
        const agent = agents.get(b.tool_use_id);
        if (!agent) {
          if (asyncLaunch && typeof b.tool_use_id === 'string') early.set(b.tool_use_id, launched?.agentId ?? early.get(b.tool_use_id));
        } else if (asyncLaunch) {
          launch(agent, launched?.agentId);
        } else {
          agent.resultAt = Date.parse(o.timestamp) || Date.now();
          agent.failed = b.is_error === true;
        }
      }
    }
  }
  return [...agents.values()];
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// What an agent last did, from the end of its own log: the newest tool call it made.
function latestOf(file) {
  for (const line of tailLines(file, LATEST_BYTES).reverse()) {
    if (!line.includes('"tool_use"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const use = (Array.isArray(o.message?.content) ? o.message.content : []).filter((b) => b.type === 'tool_use').pop();
    if (!use) continue;
    const i = use.input ?? {};
    const what = i.description || i.file_path || i.path || i.pattern || i.command || '';
    return `${use.name}${what ? ` ${String(what).split('\n')[0]}` : ''}`.slice(0, 120);
  }
  return null;
}

// Settles each record into running, completed or failed. `sessionActiveAt` is when the session file last changed.
export function settle(records, { dir, now = Date.now(), sessionActiveAt = 0 } = {}) {
  return records.map((r) => {
    const base = { id: r.id, label: r.label };
    if (r.ended) return { ...base, status: r.ended };
    if (!r.async) {
      if (r.resultAt !== null) return { ...base, status: r.failed ? 'failed' : 'completed' };
      const quiet = now - Math.max(sessionActiveAt, r.startedAt ?? 0);
      return { ...base, status: quiet < QUIET_MS ? 'running' : 'stopped' };
    }
    const log = dir && r.agentId ? path.join(dir, `agent-${r.agentId}.jsonl`) : null;
    const meta = dir && r.agentId ? readMeta(path.join(dir, `agent-${r.agentId}.meta.json`)) : null;
    if (meta?.finished === true) return { ...base, status: 'completed' };
    const activeAt = Math.max(log ? mtime(log) ?? 0 : 0, sessionActiveAt);
    const limit = meta ? QUIET_MS : ACTIVE_MS;
    if (now - activeAt >= limit) return { ...base, status: 'stopped' };
    const latest = log ? latestOf(log) : null;
    return { ...base, status: 'running', ...(latest && { latest }) };
  });
}

// The agents of one session file, newest last. "stopped" means the agent went quiet without an end being recorded, for
// example because the session was closed, so it is shown as not running.
export function readAgents(file, { now = Date.now() } = {}) {
  const sessionActiveAt = mtime(file);
  if (sessionActiveAt === null) return [];
  const dir = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
  const records = parseAgents(tailLines(file));
  return settle(records.slice(-MAX_AGENTS), { dir, now, sessionActiveAt });
}
