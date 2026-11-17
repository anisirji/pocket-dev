import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Antigravity (`agy`) keeps one SQLite file per conversation and a summaries database next to them. The conversation files
// hold their steps as protobuf, which is not a format to read here, so the list comes from the summaries database: the
// title, the folder, the step count and the time. The summaries database is copied to a private temp folder before it is
// opened, so agy's own files are never opened for writing and a database that agy has open does not lock or change.

const LIMIT = 300;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_MAX = 400;

export const agyDir = () => process.env.POCKET_DEV_AGY_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// '2026-11-16 11:53:21.090185+00:00' to milliseconds.
function toMs(value) {
  const ms = Date.parse(String(value ?? '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : 0;
}

function folderOf(uris) {
  let list;
  try { list = JSON.parse(uris); } catch { return null; }
  const uri = Array.isArray(list) ? list.find((u) => typeof u === 'string' && u.startsWith('file://')) : null;
  try { return uri ? fileURLToPath(uri) : null; } catch { return null; }
}

let sqlite;
async function loadSqlite() {
  if (sqlite === undefined) sqlite = await import('node:sqlite').catch(() => null);
  return sqlite;
}

const stamp = (file) => {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : '';
};

let cache = { key: '', sessions: [] };

// Conversations a person resumes, newest first. Sub-conversations that agy starts for its own helpers are left out.
export async function listAntigravity() {
  const dir = agyDir();
  const db = path.join(dir, 'conversation_summaries.db');
  const key = [dir, stamp(db), stamp(`${db}-wal`)].join('|');
  if (key === cache.key) return cache.sessions;
  const lib = await loadSqlite();
  if (!lib || !fs.existsSync(db)) return [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-agy-'));
  let rows = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(db + suffix)) fs.copyFileSync(db + suffix, path.join(temp, `s.db${suffix}`));
    }
    const conn = new lib.DatabaseSync(path.join(temp, 's.db'));
    try {
      rows = conn.prepare(`SELECT conversation_id AS id, title, preview, step_count AS steps, last_modified_time AS modified,
        workspace_uris AS uris FROM conversation_summaries
        WHERE nesting_depth = 0 AND parent_conversation_id = '' AND step_count > 0
        ORDER BY last_modified_time DESC LIMIT ${LIMIT}`).all();
    } finally { conn.close(); }
  } catch {
    rows = [];
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const sessions = rows.filter((r) => ID_RE.test(r.id)).map((r) => {
    const modified = toMs(r.modified);
    const file = path.join(dir, 'conversations', `${r.id}.db`);
    const title = oneLine(r.title) || oneLine(r.preview);
    return {
      tool: 'antigravity', id: r.id, file, offset: 0, size: -1,
      mtimeMs: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? modified,
      cwd: folderOf(r.uris), cwdLocked: true, title: title || null, customTitle: null, firstPrompt: title || null,
      lastActive: modified ? new Date(modified).toISOString() : null, messageCount: r.steps, hidden: false,
    };
  });
  cache = { key, sessions };
  return sessions;
}

export const findAntigravity = async (id) => (await listAntigravity()).find((s) => s.id === id) ?? null;

// The detail view: the conversation's title, as the one thing agy keeps in a form that can be read here.
export const antigravityMessages = (s) => (s.title ? [{ role: 'user', text: clip(s.title, TEXT_MAX), time: s.lastActive }] : []);
export const ANTIGRAVITY_NOTE = 'Antigravity keeps the full text in its own format, so only the title is shown here. Opening the conversation continues it.';
