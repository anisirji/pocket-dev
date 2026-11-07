import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests can stub the system tools; the defaults are the real ones.
const PMSET = process.env.POCKET_DEV_PMSET || '/usr/bin/pmset';
const IOREG = process.env.POCKET_DEV_IOREG || '/usr/sbin/ioreg';
const OSASCRIPT = process.env.POCKET_DEV_OSASCRIPT || '/usr/bin/osascript';
const UPDATE_CHECK = process.env.POCKET_DEV_UPDATE_CHECK || path.join(REPO_DIR, 'scripts', 'update-check.sh');
// Still running this long after asking macOS to shut down means an app (usually "Save changes?") stopped it.
const SHUTDOWN_BLOCKED_MS = Number(process.env.POCKET_DEV_SHUTDOWN_BLOCKED_MS) || 45_000;
const SESSION_EXIT_MS = 5000;
const AUTOMATION_HELP = 'macOS needs permission: on the Mac, allow node to control System Events (System Settings → Privacy & Security → Automation).';
const CAFFEINATE = '/usr/bin/caffeinate';
const RESPAWN_MS = 1000;
const SLEEP_DELAY_MS = 2000;
// A power request this long after a sleep request means the Mac woke up, or never slept.
const WAKE_GRACE_MS = 10_000;

// -s holds the system awake only while on AC power; -i also blocks idle sleep on battery.
// -w <pid> (added at spawn) makes caffeinate exit with the server, so it can never outlive Pocket Dev.
const MODE_FLAGS = { off: null, plugged: ['-s'], always: ['-i', '-s'] };
const AWAKE_MODES = Object.keys(MODE_FLAGS);
const DEFAULT_MODE = 'plugged';

let config;
let mode = DEFAULT_MODE;
let child = null;
let sleepRequestedAt = null;
// null, or { state: 'pending' | 'blocked' | 'error', at, apps?, error? }
let shutdown = null;

// caffeinate is held off from a sleep request until the Mac is back, so it cannot block the sleep.
const wantedMode = () => (sleepRequestedAt ? 'off' : mode);

function spawnChild(target) {
  const flags = MODE_FLAGS[target];
  if (!flags) return;
  const proc = spawn(CAFFEINATE, [...flags, '-w', String(process.pid)], { stdio: 'ignore' });
  const own = { proc, mode: target };
  child = own;
  proc.on('error', (err) => {
    console.error(`caffeinate failed to start: ${err.message}`);
    if (child === own) child = null;
  });
  proc.on('exit', (code, signal) => {
    if (child !== own) return;
    console.error(`caffeinate exited unexpectedly (${signal ?? code}); restarting it`);
    child = null;
    setTimeout(converge, RESPAWN_MS);
  });
}

function converge() {
  const target = wantedMode();
  if ((child?.mode ?? 'off') === target) return;
  if (child) {
    const { proc } = child;
    child = null;
    proc.kill();
  }
  spawnChild(target);
}

export function startPower(openedConfig) {
  config = openedConfig;
  const saved = config.read().awake;
  mode = AWAKE_MODES.includes(saved) ? saved : DEFAULT_MODE;
  converge();
}

// update() throws when config.json is malformed; the mode then stays as it was.
function setAwake(next) {
  if (config.read().awake !== next) config.update({ awake: next });
  mode = next;
  converge();
}

const pmset = async (...args) => (await run(PMSET, args, { timeout: 5000 })).stdout;
// Only an explicit "idle" from update-check.sh counts as no update; a broken check refuses sleep and shutdown.
async function updateInProgress() {
  try {
    return (await run(UPDATE_CHECK, [], { timeout: 10_000 })).stdout.trim() !== 'idle';
  } catch {
    return true;
  }
}
const updateRefusal = (doing) => `A macOS update is being installed. ${doing} now could interrupt it. Try again after it finishes.`;

// Macs without a lid have no AppleClamshellState key, which reads as open.
const lidClosed = async () => /"AppleClamshellState" = Yes/.test((await run(IOREG, ['-r', '-k', 'AppleClamshellState', '-d', '4'], { timeout: 5000 })).stdout);

// "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t82%; charging; 0:45 remaining present: true"
function parseBatt(text) {
  const onAC = text.includes("'AC Power'");
  const m = /InternalBattery[^\t]*\t(\d+)%; ([^;]+);(?: (\d+):(\d+) remaining)?/.exec(text);
  if (!m) return { onAC, battery: null, charging: false, timeRemaining: null };
  const [, percent, state, hours, minutes] = m;
  const estimating = state === 'charging' || state === 'discharging';
  return {
    onAC,
    battery: Number(percent),
    charging: state === 'charging',
    timeRemaining: estimating && hours !== undefined ? Number(hours) * 60 + Number(minutes) : null,
  };
}

function parseAssertions(text, caffeinatePid) {
  const count = (name) => Number(new RegExp(`^\\s+${name}\\s+(\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  const ownLine = new RegExp(`^\\s+pid ${caffeinatePid}\\(caffeinate\\): \\S+ \\S+ (\\w+)`, 'gm');
  return {
    PreventSystemSleep: count('PreventSystemSleep'),
    PreventUserIdleSystemSleep: count('PreventUserIdleSystemSleep'),
    heldByPocketDev: caffeinatePid ? [...text.matchAll(ownLine)].map((m) => m[1]) : [],
  };
}

export async function powerStatus() {
  const caffeinatePid = child?.proc.pid ?? null;
  const [batt, settings, assertions, closed, updating] = await Promise.all([
    pmset('-g', 'batt'), pmset('-g'), pmset('-g', 'assertions'), lidClosed(), updateInProgress(),
  ]);
  const power = parseBatt(batt);
  return {
    awake: mode,
    caffeinatePid,
    ...power,
    stayingAwake: caffeinatePid !== null && (mode === 'always' || power.onAC),
    lidSleepDisabled: /^\s*SleepDisabled\s+1\s*$/m.test(settings),
    lidClosed: closed,
    repoDir: REPO_DIR,
    shutdown,
    updateInProgress: updating,
    assertions: parseAssertions(assertions, caffeinatePid),
  };
}

function sleepNow(wss) {
  if (sleepRequestedAt && Date.now() - sleepRequestedAt < SLEEP_DELAY_MS) return;
  sleepRequestedAt = Date.now();
  converge();
  setTimeout(() => {
    for (const ws of wss.clients) ws.close(1001, 'mac-sleeping');
    run(PMSET, ['sleepnow']).catch((err) => console.error(`pmset sleepnow failed: ${err.message}`));
  }, SLEEP_DELAY_MS);
}

function restoreAfterSleep() {
  if (!sleepRequestedAt || Date.now() - sleepRequestedAt < WAKE_GRACE_MS) return;
  sleepRequestedAt = null;
  converge();
}

const osascript = (script) => run(OSASCRIPT, ['-e', script], { timeout: 60_000 });

function osascriptError(err) {
  const text = `${err.stderr ?? ''}${err.message}`;
  if (/-1743|Not authorized to send Apple events/.test(text)) return AUTOMATION_HELP;
  // The first shutdown makes macOS ask on the Mac; nobody answers it from the phone, so osascript times out.
  if (err.killed) return `macOS may be asking on the Mac for permission. ${AUTOMATION_HELP}`;
  return `osascript failed: ${text.trim()}`;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function endSessions(sessions) {
  const pids = [...sessions.values()].map((s) => s.pty.pid);
  const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch {} };
  for (const pid of pids) signalGroup(pid, 'SIGHUP');
  const deadline = Date.now() + SESSION_EXIT_MS;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) signalGroup(pid, 'SIGKILL');
}

async function shutDown({ wss, sessions }) {
  const at = Date.now();
  shutdown = { state: 'pending', at };
  await endSessions(sessions);
  for (const ws of wss.clients) ws.close(1001, 'mac-shutting-down');
  try {
    await osascript('tell application "System Events" to shut down');
  } catch (err) {
    shutdown = { state: 'error', at, error: osascriptError(err) };
    return;
  }
  setTimeout(async () => {
    if (shutdown?.at !== at) return;
    let apps = [];
    try {
      apps = (await osascript('tell application "System Events" to get name of (processes where background only is false)')).stdout.trim().split(', ').filter(Boolean);
    } catch {}
    shutdown = { state: 'blocked', at, apps };
  }, SHUTDOWN_BLOCKED_MS).unref();
}

// `action` is the path segment after /power: undefined, 'sleep', or 'shutdown'.
export async function handlePowerApi(req, res, action, { readJson, sendJson, wss, sessions }) {
  restoreAfterSleep();
  const route = `${req.method} ${action ?? ''}`;
  if ((route === 'POST sleep' || route === 'POST shutdown') && await updateInProgress()) {
    return sendJson(res, 409, { error: updateRefusal(action === 'sleep' ? 'Sleeping' : 'Shutting down'), updateInProgress: true });
  }
  if (route === 'POST sleep') {
    sleepNow(wss);
    return sendJson(res, 202, { sleepingInMs: SLEEP_DELAY_MS });
  }
  if (route === 'POST shutdown') {
    if (shutdown?.state !== 'pending') shutDown({ wss, sessions });
    return sendJson(res, 202, { shutdown });
  }
  if (route === 'DELETE shutdown') {
    shutdown = null;
    return sendJson(res, 204);
  }
  if (action !== undefined) return sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'GET') return sendJson(res, 200, await powerStatus());
  if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use GET or PUT' });
  const { awake } = await readJson(req);
  if (!AWAKE_MODES.includes(awake)) return sendJson(res, 400, { error: `awake must be one of: ${AWAKE_MODES.join(', ')}` });
  setAwake(awake);
  return sendJson(res, 200, await powerStatus());
}
