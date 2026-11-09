import { platform } from './platform.js';

const QUIT_WAIT_MS = 8000;
const TERM_WAIT_MS = 3000;
const KILL_WAIT_MS = 1000;

export const permissionNeeded = (err) => platform.windowPermission(err);

export function permissionHelp(access, host) {
  if (access === 'needs-automation') {
    return `Pocket Dev may not control System Events. On the Mac, open System Settings → Privacy & Security → Automation → ${host} and turn on System Events.`;
  }
  return `Pocket Dev needs Accessibility to read window names. On the Mac, open System Settings → Privacy & Security → Accessibility and turn on ${host}.`;
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
  if (platform.systemApps().has(app.name)) return 'system';
  if (ancestors.has(app.pid)) return 'hosts-pocket-dev';
  return null;
}

export async function snapshot() {
  const cap = platform.capabilities().apps;
  if (!cap.available) return { apps: [], host: 'node', unsupported: cap.reason };
  const [raw, table] = await Promise.all([platform.listApps(), platform.processTable()]);
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

async function windowAccess() {
  if (!platform.capabilities().appWindows.available) return 'ok';
  const result = await platform.probeWindowAccess();
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
  await platform.quitApp(app.pid);
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
      const [{ apps, unsupported }, access] = await Promise.all([snapshot(), windowAccess()]);
      return sendJson(res, 200, { apps, windowAccess: access, ...(unsupported && { unsupported }) });
    }

    if (req.method === 'GET' && action === 'windows') {
      const found = await findApp(res, key);
      if (!found) return;
      const noWindows = platform.capabilities().appWindows;
      if (!noWindows.available) return sendJson(res, 200, { windowAccess: 'ok', windows: [], unsupported: noWindows.reason });
      try {
        const windows = await platform.appWindows(key);
        return sendJson(res, 200, { windowAccess: 'ok', windows: windows.map(windowView) });
      } catch (err) {
        const access = permissionNeeded(err);
        if (!access) throw err;
        return sendJson(res, 200, { windowAccess: access, help: permissionHelp(access, found.host), windows: [] });
      }
    }

    if (req.method === 'POST' && ACTIONS[action]) {
      const noApps = platform.capabilities().apps;
      if (!noApps.available) return sendJson(res, 501, { error: `Not available on this system: ${noApps.reason}`, unsupported: true });
      const found = await findApp(res, key);
      if (!found) return;
      if (found.app.protected) {
        return sendJson(res, 403, { error: `${found.app.name} is protected: ${found.app.protectedReason === 'system' ? `it is part of ${platform.osName}` : 'Pocket Dev runs inside it'}.` });
      }
      return sendJson(res, 200, await ACTIONS[action](found.app));
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
}
