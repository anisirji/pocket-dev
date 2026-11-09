import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { ADMIN_URL_PATH } from './admin.js';
import { listProcesses, findCopies, readClaudeSessions, copyView } from './takeover.js';
import { findConversation, resumeArgv, claudeSessionsDir } from './history.js';

// `pocket-dev takeover <id>` and `--last`: continue a conversation in this Mac terminal. Pocket Dev's own copy (a phone
// terminal or chat) closes first, through the running server's Admin API, so only one program writes the conversation.

const USAGE = 'usage: pocket-dev takeover <conversation id> | --last';
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const TOOL_LABELS = { claude: 'Claude', codex: 'Codex' };

function readAdminUrl() {
  try { return JSON.parse(fs.readFileSync(ADMIN_URL_PATH, 'utf8')).url; } catch { return null; }
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

class Refusal extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Returns the exit code. Every dependency is replaceable, so tests never reach a real server, process or program.
export async function takeoverCommand(args, {
  adminUrl = readAdminUrl, fetch: request = fetch, run = spawnSync, listProcesses: list = listProcesses,
  claudeSessions = () => readClaudeSessions(claudeSessionsDir()), lookup = findConversation, ask = askYesNo,
  out = console.log, err = console.error, uid = process.getuid?.() ?? 0, selfPid = process.pid, home = os.homedir(),
} = {}) {
  const [target, ...extra] = args;
  if (!target || extra.length || (target !== '--last' && !ID_RE.test(target))) {
    err(USAGE);
    return 2;
  }

  // Answers null when no server is running there, and throws a Refusal with the server's reason when it says no.
  const base = adminUrl();
  async function admin(method, pathname, body) {
    let res;
    try {
      res = await request(base + pathname, {
        method,
        headers: body ? { 'content-type': 'application/json', 'x-pocket-admin': '1' } : {},
        body: body && JSON.stringify(body),
      });
    } catch {
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Refusal(data.error ?? `Pocket Dev answered ${res.status}.`, res.status);
    return data;
  }

  try {
    const state = base ? await admin('GET', '/api/state') : null;
    const items = state?.sections?.find((s) => s.id === 'conversations')?.items ?? [];
    const item = target === '--last' ? items[0] : items.find((i) => i.conversationId === target);
    if (target === '--last' && !item) {
      err(state ? 'No conversation is open in a Pocket Dev terminal or chat.' : 'Pocket Dev is not running, so there is nothing to take over with --last.');
      return 1;
    }
    const conversation = item ? { tool: item.tool, id: item.conversationId, cwd: item.cwd } : await lookup(target);
    if (!conversation) {
      err(`No conversation ${target} in ~/.claude or ~/.codex.`);
      return 1;
    }
    const tool = TOOL_LABELS[conversation.tool];

    if (item) {
      if (item.busy && !(await ask(`${tool} is still working on this in Pocket Dev. Taking over stops that reply. Take it over? [y/N] `))) {
        err('Nothing was changed.');
        return 1;
      }
      // 404 means the copy closed on its own since the list was read.
      const closed = await admin('POST', `/api/sections/conversations/${encodeURIComponent(item.id)}`, {})
        .catch((e) => { if (e.status === 404) return { gone: true }; throw e; });
      if (closed === null) {
        err('Could not reach Pocket Dev to close its copy. Nothing was changed.');
        return 1;
      }
      if (!closed.gone) out(`Closed Pocket Dev's copy: ${item.details[0]}.`);
    } else if (!state) {
      out('Pocket Dev is not running. Checking this Mac only.');
    }

    const left = findCopies({ processes: await list(), uid, selfPid, sessions: claudeSessions() })
      .filter((c) => c.tool === conversation.tool && c.id === conversation.id);
    if (left.length) {
      err(`This conversation is still open in ${left.map((c) => copyView(c).label).join(', ')}. Close it there, then run this again.`);
      return 1;
    }

    const exists = conversation.cwd && fs.statSync(conversation.cwd, { throwIfNoEntry: false })?.isDirectory();
    const cwd = exists ? conversation.cwd : home;
    if (!exists) out(`${conversation.cwd ?? 'Its folder'} no longer exists, so it continues in your home folder.`);
    const [bin, binArgs] = resumeArgv(conversation.tool, conversation.id);
    out(`Continuing in ${cwd}: ${bin} ${binArgs.join(' ')}`);
    const result = run(bin, binArgs, { cwd, stdio: 'inherit' });
    if (result.error) {
      err(result.error.code === 'ENOENT' ? `${bin} is not installed, or not on PATH.` : result.error.message);
      return 1;
    }
    return result.status ?? 1;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    err(e.message);
    return 1;
  }
}
