import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT, STATE_DIR, resolveConfigPath } from '../paths.js';
import { openConfig } from '../config.js';
import { KEYS } from '../config-keys.js';
import { INTERNET_KINDS, readNetwork, networkError, isToken, hasToken, writeToken } from '../network.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const HELP = `pocket-dev ${VERSION}: control this computer from your phone's browser

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
  setup [--check] [--yes] [--dry-run] [--only <step>]
                                                   Guided setup: install and log in Git, Claude Code, Codex, GitHub CLI,
                                                   cloudflared, then password, phone access and start at login
  doctor [--fix] [--yes]                           Check this installation (Node, PATH, terminals, tools, port); --fix repairs terminals
  qr                                               Print a one-time login QR code
  admin                                            Open the admin page (this computer only)
  connect | disconnect                             Open or close phone access
  message [text] [--to NAME] [--file PATH]         Send to Messages as this computer (text or piped stdin)
  internet status|off|quick                        Internet access: show it, turn it off, or allow a Quick link
  internet domain --hostname <host> --token-stdin  Your own domain through a Cloudflare tunnel; the token
                                                   comes from stdin, or from a file with --token-file <path>
  awake on|plugged|off|status                      Keep this computer awake
  takeover <id> | --last                           Continue a phone conversation in this terminal
  version | help

Settings you can change with config set:
${Object.entries(KEYS).map(([key, { help }]) => `  ${key.padEnd(16)} ${help}`).join('\n')}

The password is changed on the admin page (pocket-dev admin).`;
const INTERNET_USAGE = 'usage: pocket-dev internet status|off|quick | domain --hostname <host> (--token-stdin | --token-file <path>)';

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

// Talks to the running server's admin page when there is one. Null means Pocket Dev is not running.
async function adminApi(method, endpoint, body) {
  let url;
  try { ({ url } = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'admin.json'), 'utf8'))); } catch { return null; }
  let res;
  try {
    res = await fetch(url + endpoint, {
      method, signal: AbortSignal.timeout(5000),
      headers: body ? { 'content-type': 'application/json', 'x-pocket-admin': '1' } : {},
      body: body && JSON.stringify(body),
    });
  } catch {
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `The admin page answered ${res.status}.`);
  return data;
}

function printInternet({ wifi, internet, hasToken: saved, tunnel }) {
  console.log(`Internet access: ${internet.kind}${internet.hostname ? ` (${internet.hostname})` : ''}`);
  console.log(`Tunnel token: ${saved ? 'saved' : 'none'}`);
  console.log(`Wi-Fi access: ${wifi ? 'on' : 'off'}`);
  if (!tunnel) return console.log('Link: Pocket Dev is not running.');
  console.log(`Link: ${tunnel.status}${tunnel.url ? ` at ${tunnel.url}` : ''}${tunnel.error ? ` (${tunnel.error})` : ''}`);
}

// The token is a secret, so it is read from stdin or a file and never taken as an argument that would show in the
// shell history and in ps.
async function internet([action = 'status', ...rest]) {
  const store = openConfig(resolveConfigPath());
  if (action === 'status') {
    const live = await adminApi('GET', '/api/state');
    return printInternet(live?.network ?? { ...readNetwork(store), hasToken: hasToken(), tunnel: null });
  }
  if (!INTERNET_KINDS.includes(action)) fail(INTERNET_USAGE, 2);
  if (rest.includes('--token')) fail('The token never goes on the command line. Use --token-stdin or --token-file <path>.', 2);
  const changes = { internet: { kind: action, hostname: null } };
  if (action === 'domain') {
    changes.internet.hostname = flagValue(rest, '--hostname') ?? readNetwork(store).internet.hostname;
    const file = flagValue(rest, '--token-file');
    if (rest.includes('--token-stdin')) changes.token = fs.readFileSync(0, 'utf8').trim();
    else if (file) changes.token = fs.readFileSync(file, 'utf8').trim();
    if (changes.token !== undefined && !isToken(changes.token)) fail('The token is one long code without spaces. Copy only the token from the install command.', 2);
  }
  const live = await adminApi('PUT', '/api/network', { ...changes, by: 'cli' });
  if (live) return printInternet(live);
  const next = { wifi: readNetwork(store).wifi, internet: { kind: action, hostname: changes.internet.hostname?.trim().toLowerCase() || null } };
  const invalid = networkError(next, { hasToken: hasToken() || changes.token !== undefined });
  if (invalid) fail(invalid, 2);
  if (changes.token !== undefined) writeToken(changes.token);
  store.update({ network: next });
  printInternet({ ...next, hasToken: hasToken(), tunnel: null });
  console.log('Applies when Pocket Dev starts.');
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

// Ctrl+C stops between steps. Every change setup makes is a finished write, so nothing is left half done.
async function setup(args) {
  const { createRealContext, runSetup } = await import('../setup.js');
  process.once('SIGINT', () => { console.log('\nStopped. Nothing is half done; run pocket-dev setup again to continue.'); process.exit(130); });
  try { return await runSetup(args, await createRealContext()); } catch (err) {
    if (err.code === 'SIGINT') { console.log('Stopped. Nothing is half done; run pocket-dev setup again to continue.'); return 130; }
    throw err;
  }
}

// `doctor` shares setup's detection and its terminal question-and-answer plumbing.
async function doctor(args) {
  const { createRealContext } = await import('../setup.js');
  const { doctorCommand } = await import('../doctor.js');
  return doctorCommand(args, await createRealContext());
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'start': await start(args); break;
  case 'config': config(args); break;
  case 'service': service(args); break;
  case 'setup': process.exit(await setup(args)); break;
  case 'doctor': process.exit(await doctor(args)); break;
  case 'qr': runScript('qr.js'); break;
  case 'admin': runScript('admin.js', ['open']); break;
  case 'connect': case 'disconnect': runScript('admin.js', [command]); break;
  case 'internet': await internet(args); break;
  case 'awake': runScript('awake.js', args); break;
  case 'takeover': process.exit(await (await import('../takeover-cli.js')).takeoverCommand(args)); break;
  case 'message': runScript('message.js', args); break;
  case 'version': case '--version': case '-v': console.log(VERSION); break;
  case undefined: case 'help': case '--help': case '-h': console.log(HELP); break;
  default: fail(`Unknown command "${command}".\n\n${HELP}`, 2);
}
