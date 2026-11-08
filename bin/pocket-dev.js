#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT, resolveConfigPath } from '../paths.js';
import { openConfig } from '../config.js';
import { KEYS } from '../config-keys.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const HELP = `pocket-dev ${VERSION}: control this Mac from your phone's browser

Usage: pocket-dev <command>

  start [--port N] [--admin-port N] [--no-open]   Run the server in this terminal
  config list                                      Show the settings and where they are saved
  config get <key>                                 Show one setting
  config set <key> <value>                         Change a setting
  config unset <key>                               Go back to a setting's default
  config path                                      Print the config file path
  service install|restart                          Run in the background and start at login
  service uninstall|status|logs                    Remove it, check it, or follow its log
  service autostart on|off|status                  Start at login (or not)
  qr                                               Print a one-time login QR code
  admin                                            Open the admin page (this Mac only)
  connect | disconnect                             Open or close phone access
  message [text] [--to NAME] [--file PATH]         Send to Messages as the Mac (text or piped stdin)
  awake on|plugged|off|status                      Keep the Mac awake
  takeover <id> | --last                           Continue a phone conversation in this terminal
  version | help

Settings you can change with config set:
${Object.entries(KEYS).map(([key, { help }]) => `  ${key.padEnd(16)} ${help}`).join('\n')}

The password is changed on the admin page (pocket-dev admin).`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function runScript(file, args = []) {
  const script = path.join(PACKAGE_ROOT, 'scripts', file);
  const isShell = file.endsWith('.sh');
  const result = spawnSync(isShell ? script : process.execPath, isShell ? args : [script, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value.`, 2);
  return value;
}

async function start(args) {
  const port = flagValue(args, '--port');
  const adminPort = flagValue(args, '--admin-port');
  if (port) process.env.PORT = port;
  if (adminPort) process.env.POCKET_DEV_ADMIN_PORT = adminPort;
  if (args.includes('--no-open')) process.env.POCKET_DEV_NO_OPEN = '1';
  await import('../server.js');
}

function config([action, key, ...rest]) {
  if (action === 'path') return console.log(resolveConfigPath());
  const store = openConfig(resolveConfigPath());
  if (action === 'list' || action === undefined) {
    const shown = { ...store.read() };
    if ('passwordHash' in shown) shown.passwordHash = '<set>';
    console.log(`# ${store.file}`);
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (action === 'get') {
    if (!key) fail('usage: pocket-dev config get <key>', 2);
    if (key === 'passwordHash') fail('That value is private. Change the password on the admin page.');
    const value = store.read()[key];
    return console.log(value === undefined ? '(not set)' : typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (action === 'set' || action === 'unset') {
    const setting = KEYS[key];
    if (!setting) fail(`"${key ?? ''}" is not a setting you can change here. Settings: ${Object.keys(KEYS).join(', ')}.`, 2);
    let value;
    if (action === 'set') {
      if (rest.length !== 1) fail(`usage: pocket-dev config set ${key} <value>`, 2);
      try { value = setting.parse(rest[0]); } catch (err) { fail(`${key} ${err.message}.`, 2); }
    }
    try { store.update({ [key]: value }); } catch (err) { fail(err.message); }
    console.log(action === 'set' ? `${key} = ${JSON.stringify(value)}` : `${key} is back to its default`);
    if (setting.restart) console.log('Applies after a restart: pocket-dev service restart (or stop and run pocket-dev start).');
    return;
  }
  fail(`usage: pocket-dev config list|get|set|unset|path`, 2);
}

function service([action = 'status', ...rest]) {
  if (action === 'install' || action === 'restart') return runScript('install-service.sh', rest);
  if (action === 'uninstall') return runScript('uninstall-service.sh');
  if (action === 'status') return runScript('status.sh');
  if (action === 'autostart') return runScript('autostart.sh', rest);
  if (action === 'logs') {
    const log = process.env.LOG || path.join(os.homedir(), 'Library', 'Logs', 'pocket-dev.log');
    const result = spawnSync('tail', ['-n', '50', '-f', log], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  fail('usage: pocket-dev service install|restart|uninstall|status|logs|autostart', 2);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'start': await start(args); break;
  case 'config': config(args); break;
  case 'service': service(args); break;
  case 'qr': runScript('qr.js'); break;
  case 'admin': runScript('admin.js', ['open']); break;
  case 'connect': case 'disconnect': runScript('admin.js', [command]); break;
  case 'awake': runScript('awake.js', args); break;
  case 'takeover': process.exit(await (await import('../takeover-cli.js')).takeoverCommand(args)); break;
  case 'message': runScript('message.js', args); break;
  case 'version': case '--version': case '-v': console.log(VERSION); break;
  case undefined: case 'help': case '--help': case '-h': console.log(HELP); break;
  default: fail(`Unknown command "${command}".\n\n${HELP}`, 2);
}
