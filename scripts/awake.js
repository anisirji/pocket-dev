#!/usr/bin/env node
// Keeps the Mac awake or lets it sleep, through the running Pocket Dev server.
// Usage: npm run awake -- on|plugged|off|status. `sleep` asks the server to put the Mac to sleep (scripts/sleep.sh uses it).
// Exits 3 when no server is running, 1 when the server refuses, 2 on a bad argument.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_SECRET_HEADER, readLocalSecret } from '../local-secret.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = { on: 'always', always: 'always', plugged: 'plugged', off: 'off', status: null, sleep: null };
const MODE_TEXT = {
  off: 'Off. The Mac sleeps on its normal schedule.',
  plugged: 'When plugged in. The Mac stays awake on the charger and sleeps as usual on battery.',
  always: 'Always. The Mac stays awake on battery too.',
};

const command = process.argv[2] ?? 'status';
if (!(command in COMMANDS)) {
  console.error('usage: npm run awake -- on|plugged|off|status');
  process.exit(2);
}

function configuredPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || 7777; } catch { return 7777; }
}

const port = configuredPort();

function notRunning() {
  console.error(`Pocket Dev is not running on port ${port}.`);
  console.error('Start it with: npm start (or npm run service:install to keep it running).');
  console.error('Set PORT if it runs on a different port.');
  process.exit(3);
}

async function request(method, body, action = '') {
  let secret;
  try { secret = readLocalSecret(); } catch { notRunning(); }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/local/power${action}`, {
      method,
      headers: { [LOCAL_SECRET_HEADER]: secret, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    notRunning();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Pocket Dev refused the request (HTTP ${res.status}): ${data.error ?? 'unknown error'}`);
    if (res.status === 403) console.error('Restart Pocket Dev so it writes a fresh local secret, then try again.');
    process.exit(1);
  }
  return data;
}

function describe(s) {
  const power = s.onAC ? 'plugged in' : 'on battery';
  const battery = s.battery === null ? '' : `, battery ${s.battery}%${s.charging ? ' and charging' : ''}`;
  const keeper = s.caffeinatePid ? `caffeinate is running (pid ${s.caffeinatePid})` : 'caffeinate is not running';
  const now = s.stayingAwake ? 'staying awake' : 'the Mac may sleep';
  const lid = s.lidSleepDisabled
    ? 'stays awake. Turn it off with: npm run lid -- off'
    : 'the Mac sleeps. Change with: npm run lid -- on (needs your Mac password)';
  return [
    `Keep awake: ${MODE_TEXT[s.awake]}`,
    `Power:      ${power}${battery}.`,
    `Right now:  ${now}; ${keeper}.`,
    `Lid closed: ${lid}`,
  ].join('\n');
}

if (command === 'sleep') {
  const { sleepingInMs } = await request('POST', undefined, '/sleep');
  console.log(`Pocket Dev puts the Mac to sleep in ${sleepingInMs / 1000} s. Open the lid or press a key on the Mac to wake it.`);
} else {
  const mode = COMMANDS[command];
  console.log(describe(mode ? await request('PUT', { awake: mode }) : await request('GET')));
}
