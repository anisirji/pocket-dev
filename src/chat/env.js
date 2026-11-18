import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// launchd gives the service a short PATH, so also look where the installers put these CLIs.
const EXTRA_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local')];

// Windows: PATH is split on ";", a program is name.exe, .cmd or .bat (PATHEXT), and a window or server that was already open when
// something was installed still has the old PATH. So the machine and user PATH are read from the registry too, and the usual
// install folders are tried. A Windows app alias such as winget.exe cannot be stat'ed (EACCES) but can be lstat'ed.
const REG_KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];

export function registryPathDirs(env = process.env, run = execFileSync) {
  const dirs = [];
  for (const key of REG_KEYS) {
    try {
      const out = run('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1]?.trim();
      if (value) dirs.push(...value.replace(/%([^%]+)%/g, (m, v) => env[v] ?? env[v.toUpperCase()] ?? m).split(';').filter(Boolean));
    } catch {}
  }
  return dirs;
}

export function windowsBinCandidates(name, { env = process.env, registryDirs = registryPathDirs(env) } = {}) {
  const exts = (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const known = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, name),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], name),
    env.APPDATA && path.win32.join(env.APPDATA, 'npm'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'),
  ].filter(Boolean);
  const dirs = [...(env.PATH ?? env.Path ?? '').split(';'), ...registryDirs, ...known].filter(Boolean);
  const seen = new Set();
  return dirs.flatMap((dir) => exts.map((ext) => path.win32.join(dir, name + ext))).filter((f) => !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase()));
}

export const lstatExists = (f) => { try { return !!fs.lstatSync(f); } catch { return false; } };

// npm's claude.cmd is only a shim and the Agent SDK needs the real binary it launches, which sits beside it.
export function nativeBin(file) {
  if (!file || !/\.(cmd|bat)$/i.test(file)) return file;
  const real = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return fs.existsSync(real) ? real : file;
}

export function findBin(name, { platform = process.platform, candidates, isFile } = {}) {
  if (platform === 'win32') {
    return (candidates ?? windowsBinCandidates(name)).find(isFile ?? lstatExists) ?? null;
  }
  // The standalone Codex installer uses ~/.local/bin. launchd puts /usr/local/bin first,
  // where an older npm installation may start the terminal UI instead of app-server.
  const preferred = name === 'codex' ? [path.join(os.homedir(), '.local/bin')] : [];
  for (const dir of [...preferred, ...(process.env.PATH ?? '').split(':'), ...EXTRA_BIN_DIRS]) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

// The server may itself run inside a Claude Code terminal or a shell that exports ANTHROPIC_MODEL. A chat engine must
// not think it is a nested session or pick up a stale model, so drop what describes the parent session.
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.*|AI_AGENT|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL)$/;

export function engineEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  env.PATH = [...new Set([...(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean), ...EXTRA_BIN_DIRS])].join(path.delimiter);
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
