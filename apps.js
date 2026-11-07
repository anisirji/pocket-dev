import { execFile } from 'node:child_process';

const OSASCRIPT = process.env.POCKET_DEV_OSASCRIPT || '/usr/bin/osascript';
const QUIT_WAIT_MS = 8000;
const TERM_WAIT_MS = 3000;
const KILL_WAIT_MS = 1000;

const SYSTEM_APPS = new Set([
  'Finder', 'Dock', 'SystemUIServer', 'loginwindow', 'WindowServer',
  'ControlCenter', 'NotificationCenter', 'Spotlight', 'Pocket Dev',
]);

// NSWorkspace lists exactly what the Mac's own Force Quit window lists (regular, Dock-visible apps),
// and unlike System Events it needs no Automation permission.
const LIST_APPS = `
ObjC.import('AppKit');
JSON.stringify($.NSWorkspace.sharedWorkspace.runningApplications.js
  .filter((a) => a.activationPolicy === $.NSApplicationActivationPolicyRegular)
  .map((a) => ({
    name: a.localizedName.js,
    bundleId: a.bundleIdentifier.js || null,
    pid: a.processIdentifier,
    frontmost: a.active,
    hidden: a.hidden,
  })));`;

// terminate sends the app a normal quit, so it can still ask "Save changes?" or refuse.
const QUIT_APP = `
function run([pid]) {
  ObjC.import('AppKit');
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid));
  return JSON.stringify(app.js ? app.terminate : false);
}`;

const LIST_WINDOWS = `
function run([pid]) {
  const proc = Application('System Events').processes.whose({ unixId: Number(pid) })[0];
  return JSON.stringify(proc.windows().map((w) => {
    let document = null;
    try { document = w.attributes.byName('AXDocument').value(); } catch {}
    return { title: w.name(), document };
  }));
}`;

// Counting Finder's windows touches the same two permissions the window list needs.
const PROBE_WINDOWS = `Application('System Events').processes.byName('Finder').windows.length; 'ok'`;

function run(file, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

const jxa = async (script, ...args) => JSON.parse(await run(OSASCRIPT, ['-l', 'JavaScript', '-e', script, ...args]));

function permissionNeeded(err) {
  const text = `${err.stderr ?? ''} ${err.message}`;
  if (/-1743|Not authorized to send Apple events/i.test(text)) return 'needs-automation';
  // -1719 alone is also "invalid index", so only the assistive-access wording counts.
  if (/-25211|assistive access/i.test(text)) return 'needs-accessibility';
  return null;
}

export function permissionHelp(access, host) {
  if (access === 'needs-automation') {
    return `Pocket Dev may not control System Events. On the Mac, open System Settings → Privacy & Security → Automation → ${host} and turn on System Events.`;
  }
  return `Pocket Dev needs Accessibility to read window names. On the Mac, open System Settings → Privacy & Security → Accessibility and turn on ${host}.`;
}

async function processTable() {
  const table = new Map();
  for (const line of (await run('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss='])).split('\n')) {
    const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
    if (pid) table.set(pid, { ppid, cpu, rssKB: rss });
  }
  return table;
}

// Chrome, VS Code and friends spread across helper processes, so an app's usage is its whole process tree.
function treeUsage(table, children, root) {
  const usage = { cpu: 0, rssKB: 0 };
  for (const stack = [root]; stack.length;) {
    const pid = stack.pop();
    const row = table.get(pid);
    if (!row) continue;
    usage.cpu += row.cpu;
    usage.rssKB += row.rssKB;
    stack.push(...(children.get(pid) ?? []));
  }
  return usage;
}

function ancestry(table) {
  const pids = new Set();
  for (let pid = process.pid; pid > 1 && !pids.has(pid); pid = table.get(pid)?.ppid ?? 0) pids.add(pid);
  return pids;
}

function protectedReason(app, ancestors) {
  if (SYSTEM_APPS.has(app.name)) return 'system';
  if (ancestors.has(app.pid)) return 'hosts-pocket-dev';
  return null;
}

export async function snapshot() {
  const [raw, table] = await Promise.all([jxa(LIST_APPS), processTable()]);
  const ancestors = ancestry(table);
  const children = new Map();
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const apps = raw.map((app) => {
    const usage = treeUsage(table, children, app.pid);
    const reason = protectedReason(app, ancestors);
    return {
      ...app,
      cpu: Math.round(usage.cpu),
      memMB: Math.round(usage.rssKB / 1024),
      protected: reason !== null,
      protectedReason: reason,
    };
  });
  apps.sort((a, b) => b.frontmost - a.frontmost || b.memMB - a.memMB);
  // TCC asks about the responsible process: the GUI app Pocket Dev was started from, or node under launchd.
  const host = apps.find((a) => ancestors.has(a.pid))?.name ?? 'node';
  return { apps, host };
}

// 'granted'; 'automation' or 'accessibility' for the one still missing (Automation is checked first, so a missing
// Automation hides the Accessibility answer); 'waiting' when macOS is asking on the Mac and nobody has answered; 'error'.
export async function probeWindowAccess(timeout = 15_000) {
  try {
    await run(OSASCRIPT, ['-l', 'JavaScript', '-e', PROBE_WINDOWS], timeout);
    return 'granted';
  } catch (err) {
    const needed = permissionNeeded(err);
    if (needed) return needed.replace('needs-', '');
    return err.killed ? 'waiting' : 'error';
  }
}

async function windowAccess() {
  const result = await probeWindowAccess();
  return result === 'automation' || result === 'accessibility' ? `needs-${result}` : 'ok';
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function waitForExit(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

async function quit(app) {
  await jxa(QUIT_APP, String(app.pid));
  if (await waitForExit(app.pid, QUIT_WAIT_MS)) return { result: 'quit' };
  return { result: 'still-running', reason: 'probably waiting for "Save changes?" on the Mac or refused' };
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

async function forceQuit(app) {
  signal(app.pid, 'SIGTERM');
  if (await waitForExit(app.pid, TERM_WAIT_MS)) return { result: 'quit', signal: 'SIGTERM' };
  signal(app.pid, 'SIGKILL');
  if (await waitForExit(app.pid, KILL_WAIT_MS)) return { result: 'quit', signal: 'SIGKILL' };
  return { result: 'still-running', reason: 'did not exit after SIGKILL' };
}

// AXDocument is a file:// URL for document apps; anything else (a web URL, say) passes through as is.
function windowView({ title, document }) {
  const path = document?.startsWith('file://') ? decodeURIComponent(new URL(document).pathname) : document;
  return { title: title ?? '', ...(path && { document: path }) };
}

const ACTIONS = { quit, 'force-quit': forceQuit };

export function createAppsApi({ sendJson }) {
  async function findApp(res, key) {
    if (!/^\d+$/.test(key)) {
      sendJson(res, 400, { error: 'pid must be a whole number' });
      return null;
    }
    const { apps, host } = await snapshot();
    const app = apps.find((a) => a.pid === Number(key));
    if (!app) sendJson(res, 404, { error: `No open app has pid ${key}` });
    return app ? { app, host } : null;
  }

  return async function handleApps(req, res, url) {
    const [, , , key, action, extra] = url.pathname.split('/');
    if (extra !== undefined) return sendJson(res, 404, { error: 'Not found' });

    if (req.method === 'GET' && key === undefined) {
      const [{ apps }, access] = await Promise.all([snapshot(), windowAccess()]);
      return sendJson(res, 200, { apps, windowAccess: access });
    }

    if (req.method === 'GET' && action === 'windows') {
      const found = await findApp(res, key);
      if (!found) return;
      try {
        const windows = await jxa(LIST_WINDOWS, key);
        return sendJson(res, 200, { windowAccess: 'ok', windows: windows.map(windowView) });
      } catch (err) {
        const access = permissionNeeded(err);
        if (!access) throw err;
        return sendJson(res, 200, { windowAccess: access, help: permissionHelp(access, found.host), windows: [] });
      }
    }

    if (req.method === 'POST' && ACTIONS[action]) {
      const found = await findApp(res, key);
      if (!found) return;
      if (found.app.protected) {
        return sendJson(res, 403, { error: `${found.app.name} is protected: ${found.app.protectedReason === 'system' ? 'it is part of macOS' : 'Pocket Dev runs inside it'}.` });
      }
      return sendJson(res, 200, await ACTIONS[action](found.app));
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
}
