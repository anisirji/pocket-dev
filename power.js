import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PMSET = '/usr/bin/pmset';
const CAFFEINATE = '/usr/bin/caffeinate';
const RESPAWN_MS = 1000;

// -s holds the system awake only while on AC power; -i also blocks idle sleep on battery.
// -w <pid> (added at spawn) makes caffeinate exit with the server, so it can never outlive Pocket Dev.
const MODE_FLAGS = { off: null, plugged: ['-s'], always: ['-i', '-s'] };
export const AWAKE_MODES = Object.keys(MODE_FLAGS);
const DEFAULT_MODE = 'plugged';

let configPath;
let mode = DEFAULT_MODE;
let child = null;

function spawnChild() {
  const flags = MODE_FLAGS[mode];
  if (!flags) return;
  const proc = spawn(CAFFEINATE, [...flags, '-w', String(process.pid)], { stdio: 'ignore' });
  const own = { proc, mode };
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
  if (child?.mode === mode) return;
  if (child) {
    const { proc } = child;
    child = null;
    proc.kill();
  }
  spawnChild();
}

function saveMode() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.awake === mode) return;
  config.awake = mode;
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
}

export function startPower(path, savedMode) {
  configPath = path;
  mode = AWAKE_MODES.includes(savedMode) ? savedMode : DEFAULT_MODE;
  converge();
}

function setAwake(next) {
  mode = next;
  saveMode();
  converge();
}

const pmset = async (...args) => (await run(PMSET, args, { timeout: 5000 })).stdout;

// "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t82%; charging; 0:45 remaining present: true"
export function parseBatt(text) {
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

async function powerStatus() {
  const caffeinatePid = child?.proc.pid ?? null;
  const [batt, settings, assertions] = await Promise.all([pmset('-g', 'batt'), pmset('-g'), pmset('-g', 'assertions')]);
  const power = parseBatt(batt);
  return {
    awake: mode,
    caffeinatePid,
    ...power,
    stayingAwake: caffeinatePid !== null && (mode === 'always' || power.onAC),
    lidSleepDisabled: /^\s*SleepDisabled\s+1\s*$/m.test(settings),
    assertions: parseAssertions(assertions, caffeinatePid),
  };
}

export async function handlePowerApi(req, res, { readJson, sendJson }) {
  if (req.method === 'GET') return sendJson(res, 200, await powerStatus());
  if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use GET or PUT' });
  const { awake } = await readJson(req);
  if (!AWAKE_MODES.includes(awake)) return sendJson(res, 400, { error: `awake must be one of: ${AWAKE_MODES.join(', ')}` });
  setAwake(awake);
  return sendJson(res, 200, await powerStatus());
}
