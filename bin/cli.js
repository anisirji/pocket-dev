import fs from 'node:fs';
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

const SERVICE_USAGE = 'usage: pocket-dev service install|restart|uninstall|status|logs|autostart on|off|status';

// Prints the last lines of the log, then follows it until Ctrl+C. Plain Node, so it works the same on every system.
async function followLog(file, lines = 50) {
  if (!fs.existsSync(file)) fail(`There is no log yet at ${file}. Pocket Dev has not run as a service here: pocket-dev service install`);
  const tail = fs.readFileSync(file, 'utf8').split('\n');
  process.stdout.write(tail.slice(-lines - 1).join('\n'));
  let offset = fs.statSync(file).size;
  await new Promise(() => {
    fs.watchFile(file, { interval: 500 }, (stat) => {
      if (stat.size < offset) offset = 0;
      if (stat.size === offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        process.stdout.write(buf);
        offset = stat.size;
      } finally { fs.closeSync(fd); }
    });
  });
}

// A Mac runs the launchd scripts. Linux (systemd) and Windows (Task Scheduler) use the same service plan the setup
// step and the admin page use. Every failure prints why and exits non-zero.
async function service([action = 'status', ...rest]) {
  if (!['install', 'restart', 'uninstall', 'status', 'logs', 'autostart'].includes(action)) fail(SERVICE_USAGE, 2);
  if (process.platform === 'darwin' && action !== 'logs') {
    const script = { install: 'install-service.sh', restart: 'install-service.sh', uninstall: 'uninstall-service.sh', status: 'status.sh', autostart: 'autostart.sh' }[action];
    return runScript(script, action === 'install' || action === 'restart' || action === 'autostart' ? rest : []);
  }
  const { platform } = await import('../platform.js');
  const plan = platform.servicePlan();
  const log = process.env.LOG || plan.log;
  if (action === 'logs') return followLog(log);
  const svc = platform.capabilities().service;
  if (!svc.available) fail(`Background service is not available here: ${svc.reason}\nRun Pocket Dev in this terminal with: pocket-dev start`);
  try {
    if (action === 'install' || action === 'restart') {
      if (action === 'restart') for (const [cmd, args] of plan.commands.stop) spawnSync(cmd, args, { stdio: 'ignore' });
      const port = openConfig(resolveConfigPath()).read().port || process.env.PORT || 7777;
      console.log(await platform.installService({ port, force: action === 'restart' }));
    } else if (action === 'uninstall') {
      await platform.uninstallService();
      console.log('Removed. Pocket Dev no longer starts at login.');
    } else if (action === 'status') {
      const s = await platform.serviceStatus();
      console.log(`Installed: ${s.installed ? 'yes' : 'no'}\nStarts at login: ${s.autostart ? 'yes' : 'no'}\nRunning: ${s.running ? 'yes' : 'no'}${s.pid ? ` (pid ${s.pid})` : ''}\nLog: ${log}`);
    } else {
      const mode = rest[0];
      if (mode === 'status') {
        const s = await platform.serviceStatus();
        console.log(s.autostart ? 'Start at login: on' : 'Start at login: off');
      } else if (mode === 'on' || mode === 'off') {
        await platform.setAutostart(mode === 'on');
        console.log(`Start at login: ${mode}`);
      } else fail('usage: pocket-dev service autostart on|off|status', 2);
    }
  } catch (err) {
    fail(`service ${action} failed: ${String(err.message || err).trim()}`);
  }
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
  case 'service': await service(args); break;
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
  default: fail(`Unknown command "${command}". See '${path.basename(process.argv[1] ?? '', '.js') === 'pocketdev-app' ? 'pocketdev-app' : 'pocket-dev'} --help'.\n\n${HELP}`, 2);
}
