import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_ARGS } from './update.js';
import { PACKAGE_ROOT, STATE_DIR } from '../core/paths.js';
import { LABEL } from '../core/launchd.js';
import { PASS_THROUGH } from '../core/platform-service.js';

// Windows refuses to rename a folder while a program runs from it (EBUSY), and npm install -g renames the package
// folder before it writes the new one. The server, its terminal host (node-pty), the service loop and any Claude Code
// binary from the agent SDK all run from that folder, so the install can never happen from inside Pocket Dev. Instead
// Pocket Dev writes this script to its state folder and hands it over: the script stops every program running from the
// package folder, runs npm, records the result, and starts Pocket Dev again, old or new.

export const SCRIPT_FILE = 'update-windows.ps1';
export const RESULT_FILE = 'update-result.json';
export const LOG_FILE = 'update-windows.log';
// A result older than this is about some earlier update, not the one the page is waiting for.
const RESULT_MAX_AGE_MS = 30 * 60_000;
const CARRIED = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'TEMP', 'TMP', 'npm_config_prefix'];

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// node: node.exe. npm: npm.cmd. root: the package folder. stateDir: where the script, its log and the result go.
// task: the scheduled task's name when it is installed. runTask: start the task again afterwards. startHere: start
// `pocket-dev start` in a new window afterwards (this copy was not the service). env: settings the new start keeps.
// keep: process ids left running, such as the `pocket-dev update` command waiting for the result.
export function windowsUpdateScript({ node, npm, root, stateDir, from, task = null, runTask = false, startHere = false, env = {}, keep = [] }) {
  const log = path.win32.join(stateDir, LOG_FILE);
  const result = path.win32.join(stateDir, RESULT_FILE);
  const install = INSTALL_ARGS.join(' ');
  return `$ErrorActionPreference = 'Continue'
${Object.entries(env).map(([k, v]) => `$env:${k} = ${psQuote(v)}`).join('\n')}
$root = ${psQuote(root)}
$log = ${psQuote(log)}
Set-Location -LiteralPath ${psQuote(stateDir)}
Set-Content -LiteralPath $log -Value "Updating Pocket Dev ${from} $(Get-Date -Format o)" -Encoding UTF8
Start-Sleep -Seconds 2

# 1. Stop Pocket Dev: the task's loop, then every program started from the package folder, until none is left.
${task ? `schtasks /End /TN ${psQuote(task)} 2>&1 | Out-Null` : '# No background task is installed.'}
$needle = $root.ToLower()
$keep = @(${[0, ...keep].map(Number).join(', ')})
$deadline = (Get-Date).AddSeconds(30)
do {
  $left = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $keep -notcontains $_.ProcessId -and (("$($_.CommandLine)".ToLower().Contains($needle)) -or ("$($_.ExecutablePath)".ToLower().StartsWith($needle))${task ? ` -or ("$($_.CommandLine)".ToLower().Contains('\\pocket-dev\\service-run.ps1'))` : ''})
  })
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 700
} while ((Get-Date) -lt $deadline)

# 2. Install. An antivirus scan can hold a file for a moment, so a failed attempt is tried again.
$code = 1
for ($try = 1; $try -le 3 -and $code -ne 0; $try++) {
  if ($try -gt 1) { Start-Sleep -Seconds 5 }
  Add-Content -LiteralPath $log -Value "npm ${install} (attempt $try)" -Encoding UTF8
  $npmRun = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /s /c ""{0}" ${install} >> "{1}" 2>&1"' -f ${psQuote(npm)}, $log) -WindowStyle Hidden -PassThru
  $null = $npmRun.Handle
  $npmRun.WaitForExit()
  $code = $npmRun.ExitCode
}

# 3. Record what happened for the Admin page, then start Pocket Dev again whatever the outcome.
$to = $null
try { $to = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version } catch {}
$tail = @(Get-Content -LiteralPath $log -Tail 12 -ErrorAction SilentlyContinue)
@{ ok = ($code -eq 0); code = $code; from = ${psQuote(from)}; to = $to; output = $tail; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -LiteralPath ${psQuote(result)} -Encoding UTF8
${runTask ? `schtasks /Run /TN ${psQuote(task)} 2>&1 | Out-Null` : ''}
${startHere ? `Start-Process -FilePath ${psQuote(node)} -ArgumentList @(${psQuote(path.win32.join(root, 'bin', 'pocket-dev.js'))}, 'start', '--no-open') -WorkingDirectory $HOME` : ''}
`;
}

// Writes the script and starts it outside Pocket Dev's own process tree: through WMI it is a child of the WMI host, so
// ending the scheduled task (which can end the whole tree) cannot stop it halfway. A plain detached start is the
// fallback. Resolves { ok, error }.
export async function startWindowsUpdate(opts, { run = runPowerShell, write = fs.writeFileSync, mkdir = fs.mkdirSync } = {}) {
  const script = path.join(opts.stateDir, SCRIPT_FILE);
  mkdir(opts.stateDir, { recursive: true });
  try { fs.rmSync(path.join(opts.stateDir, RESULT_FILE), { force: true }); } catch { /* nothing to clear */ }
  // PowerShell 5.1 reads a script without a byte order mark as ANSI.
  write(script, `﻿${windowsUpdateScript(opts)}`, 'utf8');
  const commandLine = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const viaWmi = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(opts.stateDir)} }; exit $r.ReturnValue`;
  // Encoded, so no quote in a path is ever re-read by Windows' command-line parsing.
  if ((await run(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(viaWmi, 'utf16le').toString('base64')], { wait: true })).code === 0) return { ok: true };
  const fallback = await run(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { wait: false });
  return fallback.code === 0 ? { ok: true } : { ok: false, error: fallback.error || 'Windows did not start the update helper.' };
}

function runPowerShell(args, { wait }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true, detached: !wait, cwd: process.env.TEMP || undefined });
    } catch (err) { return resolve({ code: null, error: err.message }); }
    child.on('error', (err) => resolve({ code: null, error: err.message }));
    if (!wait) { child.unref(); return resolve({ code: 0 }); }
    child.on('close', (code) => resolve({ code }));
  });
}

// What the last update left behind, once: the file is removed after it is read. Null when there is none, or when it
// is too old to be about the update the page is waiting for.
export function takeWindowsUpdateResult(stateDir, { now = Date.now } = {}) {
  const file = path.join(stateDir, RESULT_FILE);
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  try { fs.rmSync(file, { force: true }); } catch { /* read once is enough */ }
  if (!result || typeof result.at !== 'number' || now() - result.at > RESULT_MAX_AGE_MS) return null;
  const output = (Array.isArray(result.output) ? result.output : [result.output]).filter((l) => typeof l === 'string' && l.trim());
  return { ok: result.ok === true, code: result.code, from: result.from, to: result.to, output };
}

// The script's options for this copy. service is serviceStatus(): the task is ended when it is installed and started
// again when it was running. startHere: start `pocket-dev start` afterwards, for a copy that ran in a terminal window.
export function windowsUpdateOptions({ from, npm, service, startHere, keep = [], env = process.env }) {
  const runTask = Boolean(service.installed && (service.running || service.isThisServer));
  // A process started through WMI may not get this session's environment, and npm finds its global folder from these.
  const kept = Object.fromEntries([...PASS_THROUGH, 'PORT', ...CARRIED].filter((k) => env[k]).map((k) => [k, env[k]]));
  return {
    node: process.execPath, npm, root: PACKAGE_ROOT, stateDir: STATE_DIR, from,
    task: service.installed ? LABEL : null, runTask, startHere: Boolean(startHere) && !runTask, env: kept, keep,
  };
}

// For a command typed in a terminal: waits for the script's result. Null when it did not finish in time.
export async function waitForWindowsUpdate(stateDir, { timeoutMs = 10 * 60_000, everyMs = 1000, now = Date.now, take = takeWindowsUpdateResult } = {}) {
  const end = now() + timeoutMs;
  while (now() < end) {
    const r = take(stateDir);
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}
