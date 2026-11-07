import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { probeWindowAccess, snapshot } from './apps.js';
import { findBin } from './chat/env.js';

const OSASCRIPT = process.env.POCKET_DEV_OSASCRIPT || '/usr/bin/osascript';
const FIREWALL = process.env.POCKET_DEV_FIREWALL || '/usr/libexec/ApplicationFirewall/socketfilterfw';
const PANE = 'x-apple.systempreferences:com.apple.preference.security?';
const ASK_WAIT_MS = 60_000;
const CHECK_WAIT_MS = Number(process.env.POCKET_DEV_PERMISSION_WAIT_MS) || 4_000;

// Each check reports one of these states, as the person sees it:
//   granted     allowed, nothing to do
//   missing     not allowed (or never allowed): `fix` says where to turn it on
//   waiting     macOS is asking on the Mac and nobody has answered yet
//   not-needed  the Mac does not enforce it right now (firewall off)
//   unknown     could not be told; `detail` says why

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 8000 }, (err, stdout, stderr) => resolve({ err, out: `${stdout}${stderr}` }));
});

async function hostName() {
  try { return (await snapshot()).host; } catch { return 'node'; }
}

// Automation and Accessibility share one probe. `ask` waits for a person to answer macOS's prompt; a plain check
// gives up quickly, so opening the panel never hangs on a prompt nobody has seen.
function windowAccessItems(result, host) {
  const where = (pane) => `System Settings → Privacy & Security → ${pane} → turn on ${host}`;
  const automation = {
    granted: { state: 'granted' },
    accessibility: { state: 'granted' },
    automation: { state: 'missing', fix: where('Automation') + ' → System Events', pane: 'Privacy_Automation' },
    waiting: { state: 'waiting', detail: 'macOS is asking on the Mac. Click Allow in the pop-up.' },
    error: { state: 'unknown', detail: 'The check failed to run.' },
  }[result];
  const accessibility = {
    granted: { state: 'granted' },
    accessibility: { state: 'missing', fix: where('Accessibility'), pane: 'Privacy_Accessibility' },
    automation: { state: 'unknown', detail: 'Allow System Events control first; this one is checked after it.' },
    waiting: { state: 'unknown', detail: 'Answer the System Events pop-up first.' },
    error: { state: 'unknown', detail: 'The check failed to run.' },
  }[result];
  return { automation, accessibility };
}

// Reading a folder only Full Disk Access can open is the honest test. Safari's folder exists on every Mac.
function fullDiskState(home = os.homedir()) {
  for (const dir of ['Library/Safari', 'Library/Mail', 'Library/Messages']) {
    try {
      fs.readdirSync(path.join(home, dir));
      return { state: 'granted' };
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') return { state: 'missing', fix: 'System Settings → Privacy & Security → Full Disk Access → turn on node', pane: 'Privacy_AllFiles' };
    }
  }
  return { state: 'unknown', detail: 'No protected folder was found to test with.' };
}

// macOS hides other apps' window titles until Screen Recording is allowed, and no script can ask for the answer
// directly, so the check looks for any titled window that is not ours. With no other window open it cannot tell.
const SCREEN_PROBE = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const system = ['universalAccessAuthWarn', 'UserNotificationCenter', 'SecurityAgent', 'loginwindow', 'Dock', 'WindowManager', 'Window Server', 'Control Center', 'Notification Center'];
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
const mine = $.NSProcessInfo.processInfo.processIdentifier;
const others = list.filter((w) => w.kCGWindowOwnerPID !== mine && w.kCGWindowLayer === 0 && !system.includes(w.kCGWindowOwnerName));
JSON.stringify({ windows: others.length, titled: others.filter((w) => w.kCGWindowName).length });`;

async function screenRecordingState(host) {
  const { err, out } = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', SCREEN_PROBE]);
  let seen;
  try { seen = JSON.parse(out.trim().split('\n').pop()); } catch { seen = null; }
  if (err || !seen) return { state: 'unknown', detail: 'The check failed to run.' };
  if (seen.titled > 0) return { state: 'granted' };
  if (seen.windows === 0) return { state: 'unknown', detail: 'No other window is open to test with. Open any app and check again.' };
  return {
    state: 'missing',
    fix: `System Settings → Privacy & Security → Screen Recording → turn on ${host}`,
    pane: 'Privacy_ScreenCapture',
    detail: 'Without it the phone’s Screen view shows only the wallpaper.',
  };
}

async function firewallState() {
  const global = await run(FIREWALL, ['--getglobalstate']);
  if (global.err && !global.out) return { state: 'unknown', detail: 'Could not read the firewall.' };
  if (/disabled|State = 0/i.test(global.out)) return { state: 'not-needed', detail: 'The Mac firewall is off, so nothing blocks your phone.' };
  const app = await run(FIREWALL, ['--getappblocked', process.execPath]);
  if (/permitted/i.test(app.out)) return { state: 'granted' };
  return {
    state: 'missing',
    fix: 'System Settings → Network → Firewall → Options → allow incoming connections for node',
    pane: 'Firewall',
    detail: /blocked/i.test(app.out) ? 'Incoming connections to node are blocked.' : 'The firewall is on and node is not in its list.',
  };
}

async function toolStates() {
  const gh = findBin('gh');
  const ghLogin = gh ? !(await run(gh, ['auth', 'status'])).err : false;
  const tool = (name, found, extra) => ({
    state: found ? 'granted' : 'missing',
    ...(found ? extra : { fix: `Install ${name}, then run it once to log in. Chats and Git features that need it show an error until then.` }),
  });
  return {
    claude: tool('Claude Code (claude)', findBin('claude')),
    codex: tool('Codex (codex)', findBin('codex')),
    gh: gh && !ghLogin ? { state: 'missing', fix: 'Run: gh auth login' } : tool('the GitHub CLI (gh)', gh),
  };
}

const ITEMS = [
  { id: 'automation', group: 'mac', title: 'Control System Events', why: 'Lets the phone shut the Mac down and read window names in Open apps.' },
  { id: 'accessibility', group: 'mac', title: 'Accessibility', why: 'Lets Open apps show each app’s window names.' },
  { id: 'fullDisk', group: 'mac', title: 'Full Disk Access', why: 'Lets Files open protected folders such as Mail and Safari. Optional.', optional: true },
  { id: 'screenRecording', group: 'mac', title: 'Screen Recording', why: 'Lets the phone’s Screen view show this Mac’s screen. Optional.', optional: true },
  { id: 'firewall', group: 'mac', title: 'Incoming connections', why: 'Lets your phone reach this Mac while the firewall is on.' },
  { id: 'claude', group: 'tools', title: 'Claude Code', why: 'Chats with Claude.', optional: true },
  { id: 'codex', group: 'tools', title: 'Codex', why: 'Chats with Codex.', optional: true },
  { id: 'gh', group: 'tools', title: 'GitHub CLI', why: 'Pull requests in Git. Needs gh auth login.', optional: true },
];

// A plain check never waits on a prompt for long. `ask` is for the button that is meant to raise the prompt.
export async function checkPermissions({ ask = false } = {}) {
  const host = hostName();
  const [probe, hostLabel, screenRecording, firewall, tools] = await Promise.all([
    probeWindowAccess(ask ? ASK_WAIT_MS : CHECK_WAIT_MS), host, host.then(screenRecordingState), firewallState(), toolStates(),
  ]);
  const found = { ...windowAccessItems(probe, hostLabel), fullDisk: fullDiskState(), screenRecording, firewall, ...tools };
  return ITEMS.map((item) => ({ ...item, ...found[item.id] }));
}

// Opens the System Settings page where the person turns a permission on. Only the Mac's own admin page calls this.
export function openPane(pane) {
  spawn('open', [`${PANE}${pane}`], { stdio: 'ignore', detached: true }).unref();
}
