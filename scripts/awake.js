#!/usr/bin/env node
// Keeps the Mac awake or lets it sleep, through the running Pocket Dev server.
// Usage: npm run awake -- on|plugged|off|status. `sleep` asks the server to put the Mac to sleep (scripts/sleep.sh uses it).
// Exits 3 when no server is running, 1 when the server refuses, 2 on a bad argument.
import { localRequest } from './local-api.js';

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

async function request(method, body, action = '') {
  const res = await localRequest(method, `/api/local/power${action}`, body);
  if (!res) {
    console.error('Pocket Dev is not running.');
    console.error('Start it with: npm start (or npm run service:install to keep it running).');
    process.exit(3);
  }
  if (!res.ok) {
    console.error(`Pocket Dev on port ${res.port} refused the request (HTTP ${res.status}): ${res.data.error ?? 'unknown error'}`);
    if (res.status === 403) console.error('Restart Pocket Dev so it writes a fresh local secret, then try again.');
    process.exit(1);
  }
  return res.data;
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
