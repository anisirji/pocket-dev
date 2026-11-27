#!/usr/bin/env node
// Records fixed native authorization commands. Never calls a real power tool or opens an OS prompt.
import fs from 'node:fs';
const file = process.env.POCKET_DEV_POWER_FIXTURE;
const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (value) => fs.writeFileSync(file, JSON.stringify(value));
const record = (value) => fs.appendFileSync(`${file}.log`, JSON.stringify(value) + '\n');
const args = process.argv.slice(2);
if (args[0] === '-e') {
  const script = args[1]; record({ script });
  while (state().hold) await new Promise((resolve) => setTimeout(resolve, 20));
  const value = state();
  if (value.cancel) { console.error('User canceled. (-128)'); process.exit(1); }
  if (value.fail) { console.error('Administrator authorization failed.'); process.exit(1); }
  if (value.closed && script.includes('Open the laptop lid')) { console.error('Open the laptop lid before changing lid sleep.'); process.exit(1); }
  if (script.includes('disablesleep 1')) value.disabled = true;
  if (script.includes('disablesleep 0')) value.disabled = false;
  if (script.includes('/sbin/shutdown')) record({ forceShutdown: true });
  write(value);
} else if (args[0] === '-r') console.log(`"AppleClamshellState" = ${state().closed ? 'Yes' : 'No'}`);
else if (args[0] === '-g' && args[1] === 'batt') console.log("Now drawing from 'AC Power'");
else if (args[0] === '-g' && args[1] === 'assertions') console.log('');
else if (args[0] === '-g') console.log(` SleepDisabled ${state().disabled ? 1 : 0}`);
else if (args[0] === 'sleepnow') record({ sleep: true });
else console.log(state().updating ? 'installing' : 'idle');
