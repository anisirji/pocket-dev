import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GitHub Copilot CLI keeps every session in its own folder, <copilot home>/session-state/<id>/: a small workspace.yaml
// (the id, the folder, the name and two times) and events.jsonl, the conversation as one event per line. Only those two
// files are read, and only read: nothing is opened for writing, and no token or setting file is touched.

const LIMIT = 300;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_MAX = 4000;
const SHOWN = 24;
const EVENTS_MAX = 4 * 1024 * 1024;

export const copilotDir = () => process.env.POCKET_DEV_COPILOT_DIR || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state');

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// The few `key: value` lines Copilot writes. A value may be quoted.
export function parseWorkspace(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const stamp = (file) => {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : '';
};

const contentOf = (data) => (typeof data?.content === 'string' ? data.content.trim() : '');

// Every user and assistant message in a session, in order. A very long session is read from its end.
function readMessages(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return [];
  let text;
  try {
    if (st.size > EVENTS_MAX) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(EVENTS_MAX);
        fs.readSync(fd, buf, 0, EVENTS_MAX, st.size - EVENTS_MAX);
        text = buf.toString('utf8').split('\n').slice(1).join('\n');
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const messages = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user.message' && e.type !== 'assistant.message') continue;
    const body = contentOf(e.data);
    if (body) messages.push({ role: e.type === 'user.message' ? 'user' : 'assistant', text: body, time: e.timestamp ?? null });
  }
  return messages;
}

let cache = { key: '', sessions: [] };

// Sessions a person resumes, newest first.
export async function listCopilot() {
  const dir = copilotDir();
  let names;
  try { names = fs.readdirSync(dir).filter((n) => ID_RE.test(n)); } catch { return []; }
  const key = [dir, ...names.map((n) => stamp(path.join(dir, n, 'workspace.yaml')) + stamp(path.join(dir, n, 'events.jsonl')))].join('|');
  if (key === cache.key) return cache.sessions;
  const sessions = [];
  for (const id of names) {
    let ws;
    try { ws = parseWorkspace(fs.readFileSync(path.join(dir, id, 'workspace.yaml'), 'utf8')); } catch { continue; }
    const events = path.join(dir, id, 'events.jsonl');
    const st = fs.statSync(events, { throwIfNoEntry: false });
    if (!st) continue;
    const title = oneLine(ws.name);
    const updated = Date.parse(ws.updated_at ?? '') || st.mtimeMs;
    // A user message is the first line of the conversation, so its count is the cheap signal that anything was said.
    const count = st.size > EVENTS_MAX ? Math.ceil(st.size / 4000) : readMessages(events).length;
    sessions.push({
      tool: 'copilot', id, file: events, offset: 0, size: -1, mtimeMs: st.mtimeMs,
      cwd: ws.cwd || null, cwdLocked: true, title: title || null, customTitle: null, firstPrompt: title || null,
      lastActive: new Date(updated).toISOString(), messageCount: count, hidden: false,
    });
  }
  sessions.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  cache = { key, sessions: sessions.slice(0, LIMIT) };
  return cache.sessions;
}

export const findCopilot = async (id) => (await listCopilot()).find((s) => s.id === id) ?? null;

// The detail view: the last messages, as Copilot recorded them.
export const copilotMessages = (s) => readMessages(s.file).slice(-SHOWN).map((m) => ({ ...m, text: clip(m.text, TEXT_MAX) }));
export const COPILOT_NOTE = null;
