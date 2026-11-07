import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Tests install a throwaway job under another label; the service scripts read the same variable.
export const LABEL = process.env.LABEL || 'dev.pocket.server';
const DOMAIN = `gui/${process.getuid()}`;
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const STARTED_AT = Date.now() - process.uptime() * 1000;
const CODE_DIRS = ['.', 'chat', 'public', 'scripts'];
const CODE_FILE = /\.(js|mjs|css|html|sh|json)$/;
// config.json is data the app writes, not code, so saving a setting never counts as an update.
const NOT_CODE = new Set(['config.json']);

// True when a source file on disk is newer than this process, so a restart would load different code.
export function updateReady() {
  let newest = 0;
  for (const dir of CODE_DIRS) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isFile() || !CODE_FILE.test(entry.name) || (dir === '.' && NOT_CODE.has(entry.name))) continue;
      newest = Math.max(newest, fs.statSync(path.join(ROOT, dir, entry.name)).mtimeMs);
    }
  }
  return newest > STARTED_AT + 1000;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function launchctl(...args) {
  try {
    return (await run('launchctl', args)).stdout;
  } catch {
    return null;
  }
}

// `launchctl print-disabled` lists overrides as `"label" => disabled` (older macOS: `=> true`). No entry means enabled.
export async function serviceStatus() {
  const [overrides, job] = await Promise.all([launchctl('print-disabled', DOMAIN), launchctl('print', `${DOMAIN}/${LABEL}`)]);
  const override = new RegExp(`"${escapeRe(LABEL)}" => (\\w+)`).exec(overrides ?? '')?.[1];
  const installed = fs.existsSync(PLIST);
  const pid = Number(/^\tpid = (\d+)$/m.exec(job ?? '')?.[1]) || null;
  return {
    label: LABEL,
    installed,
    autostart: installed && override !== 'disabled' && override !== 'true',
    running: pid !== null,
    pid,
    // The job runs node directly; a plist from before the power feature ran it under caffeinate, so accept the parent too.
    isThisServer: pid !== null && (pid === process.pid || pid === process.ppid),
    updateReady: updateReady(),
  };
}

// Enabling or disabling changes only what happens at the next login; it never starts or stops the running job.
export async function setAutostart(enabled) {
  await run('launchctl', [enabled ? 'enable' : 'disable', `${DOMAIN}/${LABEL}`]);
}

export async function installService({ port, force }) {
  try {
    const { stdout, stderr } = await run(path.join(ROOT, 'scripts', 'install-service.sh'), force ? ['--force'] : [], {
      cwd: ROOT, env: { ...process.env, LABEL, PORT: String(port) }, timeout: 60_000,
    });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message };
  }
}

// Exiting is the restart: launchd's KeepAlive starts the service again on whatever code is on disk, within about 10 s.
export function restartThisServer() {
  process.exit(0);
}

// launchd would restart a service that just exits (KeepAlive), so a service unloads itself instead.
export async function stopThisServer() {
  if ((await serviceStatus()).isThisServer) {
    spawn('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    process.exit(0);
  }
}
