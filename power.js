import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from './platform.js';

export { parseBatteryC, parseThermal } from './platform.js';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
// Still running this long after asking macOS to shut down means an app (usually "Save changes?") stopped it.
const SHUTDOWN_BLOCKED_MS = Number(process.env.POCKET_DEV_SHUTDOWN_BLOCKED_MS) || 45_000;
const SESSION_EXIT_MS = 5000;
const RESPAWN_MS = 1000;
const SLEEP_DELAY_MS = 2000;
// A power request this long after a sleep request means the Mac woke up, or never slept.
const WAKE_GRACE_MS = 10_000;

// The program that holds the system awake exits with the server (platform.keepAwakeCommand), so it can never outlive Pocket Dev.
const AWAKE_MODES = ['off', 'plugged', 'always'];
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
  const command = platform.keepAwakeCommand(target, process.pid);
  if (!command) return;
  const proc = spawn(command.cmd, command.args, { stdio: 'ignore' });
  const own = { proc, mode: target };
  child = own;
  proc.on('error', (err) => {
    console.error(`keep-awake program failed to start: ${err.message}`);
    if (child === own) child = null;
  });
  proc.on('exit', (code, signal) => {
    if (child !== own) return;
    console.error(`keep-awake program exited unexpectedly (${signal ?? code}); restarting it`);
    child = null;
    setTimeout(converge, RESPAWN_MS);
  });
}

// A system without a way to hold itself awake runs nothing and says so in powerStatus().unsupported.
function converge() {
  if (!platform.capabilities().keepAwake.available) return;
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

const updateRefusal = (doing) => `A macOS update is being installed. ${doing} now could interrupt it. Try again after it finishes.`;

const BATTERY_ALERT_DEFAULT = 20;
const BATTERY_CRITICAL = 10;
const TEMPERATURE_ALERT_DEFAULT = 40;
const TEMPERATURE_CRITICAL_MARGIN = 5;
const wholeNumber = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

// What deserves an alert on the phone, most urgent first. Pure, so the thresholds are easy to test.
export function alertsFor({ onAC, charging, battery, temperature }, limits) {
  const alerts = [];
  if (battery !== null && !(onAC || charging) && battery <= limits.batteryPercent) {
    const critical = battery <= BATTERY_CRITICAL;
    alerts.push({
      key: 'battery',
      level: critical ? 'critical' : 'warning',
      text: critical
        ? `${platform.host.Mac} battery is critically low (${battery}%). It may shut down and you could lose open work. Plug it in now.`
        : `${platform.host.Mac} battery is ${battery}% and not charging. Save your work and plug it in.`,
    });
  }
  const { batteryC, thermal } = temperature;
  const hotThermal = thermal === 'serious' || thermal === 'critical';
  const hotBattery = batteryC !== null && batteryC >= limits.temperatureC;
  if (hotThermal || hotBattery) {
    const critical = thermal === 'critical' || (batteryC !== null && batteryC >= limits.temperatureC + TEMPERATURE_CRITICAL_MARGIN);
    const detail = [batteryC !== null && `battery ${batteryC.toFixed(1)} °C`, thermal && thermal !== 'nominal' && `thermal ${thermal}`].filter(Boolean).join(', ');
    alerts.push({
      key: 'hot',
      level: critical ? 'critical' : 'warning',
      text: `${platform.host.Mac} is ${critical ? 'very hot' : 'hot'} (${detail}). Close heavy apps or let it cool.`,
    });
  }
  return alerts.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
}

// The small, cheap reading the phone polls every 30 s: battery, temperature, and any alerts. powerStatus is heavier.
export async function vitals() {
  const [power, temperature] = await Promise.all([platform.battery(), platform.temperatures()]);
  const saved = config.read();
  const limits = {
    batteryPercent: wholeNumber(saved.batteryAlertPercent, 5, 90, BATTERY_ALERT_DEFAULT),
    temperatureC: wholeNumber(saved.temperatureAlertC, 30, 70, TEMPERATURE_ALERT_DEFAULT),
  };
  return { ...power, temperature, limits, alerts: alertsFor({ ...power, temperature }, limits) };
}

// What the phone's power screen offers; any of these this system cannot do is listed in powerStatus().unsupported.
const POWER_FEATURES = ['keepAwake', 'sleepNow', 'shutDown', 'temperature', 'lid', 'lidSleep'];

export async function powerStatus() {
  const caffeinatePid = child?.proc.pid ?? null;
  const [power, lid, assertions, updating, temperature] = await Promise.all([
    platform.battery(), platform.lid(), platform.sleepHolds(caffeinatePid), platform.updateInProgress(), platform.temperatures(),
  ]);
  return {
    awake: mode,
    caffeinatePid,
    ...power,
    stayingAwake: caffeinatePid !== null && (mode === 'always' || power.onAC),
    lidSleepDisabled: lid.sleepDisabled ?? false,
    lidClosed: lid.closed ?? false,
    repoDir: REPO_DIR,
    shutdown,
    updateInProgress: updating,
    temperature,
    assertions,
    unsupported: platform.unsupported(POWER_FEATURES),
  };
}

function sleepNow(wss) {
  if (sleepRequestedAt && Date.now() - sleepRequestedAt < SLEEP_DELAY_MS) return;
  sleepRequestedAt = Date.now();
  converge();
  setTimeout(() => {
    for (const ws of wss.clients) ws.close(1001, 'mac-sleeping');
    platform.sleepNow().catch((err) => console.error(`Sleep failed: ${err.message}`));
  }, SLEEP_DELAY_MS);
}

function restoreAfterSleep() {
  if (!sleepRequestedAt || Date.now() - sleepRequestedAt < WAKE_GRACE_MS) return;
  sleepRequestedAt = null;
  converge();
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
    await platform.shutDown();
  } catch (err) {
    shutdown = { state: 'error', at, error: err.message };
    return;
  }
  setTimeout(async () => {
    if (shutdown?.at !== at) return;
    let apps = [];
    try {
      apps = await platform.openAppNames();
    } catch {}
    shutdown = { state: 'blocked', at, apps };
  }, SHUTDOWN_BLOCKED_MS).unref();
}

// `action` is the path segment after /power: undefined, 'sleep', or 'shutdown'.
export async function handlePowerApi(req, res, action, { readJson, sendJson, wss, sessions }) {
  restoreAfterSleep();
  const route = `${req.method} ${action ?? ''}`;
  const feature = { 'POST sleep': 'sleepNow', 'POST shutdown': 'shutDown', 'PUT ': 'keepAwake' }[route];
  const cap = feature && platform.capabilities()[feature];
  if (cap && !cap.available) return sendJson(res, 501, { error: `Not available on this system: ${cap.reason}`, unsupported: true });
  if ((route === 'POST sleep' || route === 'POST shutdown') && await platform.updateInProgress()) {
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
  if (action === 'vitals' && req.method === 'GET') return sendJson(res, 200, await vitals());
  if (action !== undefined) return sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'GET') return sendJson(res, 200, await powerStatus());
  if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use GET or PUT' });
  const { awake } = await readJson(req);
  if (!AWAKE_MODES.includes(awake)) return sendJson(res, 400, { error: `awake must be one of: ${AWAKE_MODES.join(', ')}` });
  setAwake(awake);
  return sendJson(res, 200, await powerStatus());
}
