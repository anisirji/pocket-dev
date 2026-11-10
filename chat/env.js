import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// launchd gives the service a short PATH, so also look where the installers put these CLIs.
const EXTRA_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local')];

// Windows has no executable bit and npm leaves .cmd shims, so look for the real .exe, including the one an npm
// install of Claude Code keeps beside its shim.
function binCandidates(dir, name) {
  if (process.platform !== 'win32') return [path.join(dir, name)];
  return [path.join(dir, `${name}.exe`), path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${name}.exe`)];
}

export function findBin(name) {
  // The standalone Codex installer uses ~/.local/bin. launchd puts /usr/local/bin first,
  // where an older npm installation may start the terminal UI instead of app-server.
  const preferred = name === 'codex' ? [path.join(os.homedir(), '.local/bin')] : [];
  for (const dir of [...preferred, ...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_BIN_DIRS]) {
    for (const file of binCandidates(dir, name)) {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

// The server may itself run inside a Claude Code terminal or a shell that exports ANTHROPIC_MODEL. A chat engine must
// not think it is a nested session or pick up a stale model, so drop what describes the parent session.
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.*|AI_AGENT|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL)$/;

export function engineEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  env.PATH = [...new Set([...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...EXTRA_BIN_DIRS])].join(path.delimiter);
  env.LANG ??= 'en_US.UTF-8';
  return env;
}

// Chats started from Pocket Dev never sign commits or pull requests as Claude. includeCoAuthoredBy is the older name
// for the same switch, kept so a Claude Code build from before `attribution` obeys it too.
export const ENGINE_SETTINGS = { attribution: { commit: '', pr: '' }, includeCoAuthoredBy: false };

export const OUTPUT_MAX = 8000;
export const INPUT_MAX = 4000;

export function cap(text, max = OUTPUT_MAX) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2) ?? '';
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

// A line diff good enough for showing one edit on a phone: trim the shared head and tail, show the rest as -/+.
export function lineDiff(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctx = (lines) => lines.map((l) => ` ${l}`);
  return [
    ...ctx(a.slice(Math.max(0, head - 2), head)),
    ...a.slice(head, a.length - tail).map((l) => `-${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+${l}`),
    ...ctx(a.slice(a.length - tail, a.length - tail + 2)),
  ].join('\n');
}
