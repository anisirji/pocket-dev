import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from './platform.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Tests install a throwaway job under another label; the service scripts read the same variable.
export const LABEL = process.env.LABEL || 'dev.pocket.server';
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

// Whether the background service is installed, set to start at login, and running. On a system with no way to run a
// service the answer is "not installed" plus `unsupported`, the reason.
export async function serviceStatus() {
  const cap = platform.capabilities().service;
  const status = cap.available ? await platform.serviceStatus({ label: LABEL }) : { installed: false, autostart: false, running: false, pid: null };
  const { installed, pid } = status;
  return {
    label: LABEL,
    installed,
    autostart: installed && status.autostart,
    running: status.running,
    pid,
    // The job runs node directly; a plist from before the power feature ran it under caffeinate, so accept the parent too.
    // A system that cannot give the pid (the Windows task) marks the service's own process with POCKET_DEV_SERVICE.
    isThisServer: pid !== null
      ? pid === process.pid || pid === process.ppid
      : installed && status.running && process.env.POCKET_DEV_SERVICE === LABEL,
    updateReady: updateReady(),
    ...(cap.available ? {} : { unsupported: cap.reason }),
  };
}

// Enabling or disabling changes only what happens at the next login; it never starts or stops the running job.
export async function setAutostart(enabled) {
  await platform.setAutostart(enabled, { label: LABEL });
}

export async function installService({ port, force }) {
  try {
    return { ok: true, output: await platform.installService({ port, force, label: LABEL }) };
  } catch (err) {
    return { ok: false, output: err.output ?? err.message };
  }
}

// Exiting is the restart: the service manager (KeepAlive, Restart=always, the Windows task's loop) starts it again on
// whatever code is on disk, within about 10 s.
export function restartThisServer() {
  process.exit(0);
}

// The service manager would restart a service that just exits, so a service unloads itself instead.
export async function stopThisServer() {
  if ((await serviceStatus()).isThisServer) {
    platform.stopService({ label: LABEL });
  } else {
    process.exit(0);
  }
}
