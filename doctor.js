import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PACKAGE_ROOT, STATE_DIR } from './paths.js';
import { TOOLS, MIN_NODE, createContext, detectTool, gatherFacts, fixFor, parseVersion } from './setup.js';
import { loadPty, REPAIR_COMMAND } from './pty-loader.js';

// `pocket-dev doctor`: one table of what is wrong with this installation and the exact command for each problem.
// Every check is a function of a context (platform, a command runner, file lookups, a terminal probe), so each
// operating system and each broken state is tested from any computer. `--fix` repairs only node-pty, and only after
// showing the command and asking. It never uses sudo and never runs a downloaded script.

const PACKAGE = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const NPM_ID = { id: 'npm', bin: 'npm' };
const TIMEOUT = 8000;
const PROBE_MS = 1000;
const NODE_PTY_RANGE = PACKAGE.optionalDependencies?.['node-pty'] ?? 'latest';
export const INSTALL_COMMAND = 'npm install -g @anisirji/pocket-dev';

const pathsFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const same = (platform, a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (platform, child, parent) => {
  const P = pathsFor(platform);
  const rel = P.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
};

// ---- How Pocket Dev was installed ------------------------------------------------------------------------------------

// kind: global | local | npx | checkout | folder. from: registry | github | null. `where` is the project folder for local.
export function detectInstall(ctx, globalRoot) {
  const P = pathsFor(ctx.platform);
  const root = ctx.realpath(ctx.packageRoot);
  const segments = root.split(/[\\/]/);
  // The npm registry package holds only the files listed in package.json "files"; a GitHub install holds the whole repository.
  const origin = () => (ctx.exists(P.join(root, 'test')) || ctx.exists(P.join(root, '.gitattributes')) ? 'github' : 'registry');
  if (segments.includes('_npx')) return { kind: 'npx', from: null };
  if (globalRoot && inside(ctx.platform, root, ctx.realpath(globalRoot))) return { kind: 'global', from: origin() };
  const at = segments.lastIndexOf('node_modules');
  if (at !== -1) return { kind: 'local', from: null, where: segments.slice(0, at).join(P.sep) || P.sep };
  if (ctx.exists(P.join(root, '.git'))) return { kind: 'checkout', from: null };
  return { kind: 'folder', from: null };
}

function installRow(ctx, globalRoot) {
  const found = detectInstall(ctx, globalRoot);
  const row = { id: 'install', title: 'How it was installed', level: 'recommended', found };
  const P = pathsFor(ctx.platform);
  if (found.kind === 'global') return { ...row, ok: true, detail: `global${found.from === 'github' ? ', from GitHub' : ''} (${ctx.packageRoot})` };
  if (found.kind === 'checkout') return { ...row, ok: true, detail: `run from a source folder (${ctx.packageRoot})` };
  const cleanup = found.kind === 'local'
    ? ctx.platform === 'win32' ? `Remove-Item -Recurse -Force "${P.join(found.where, 'node_modules', '@anisirji')}"` : `rm -rf "${P.join(found.where, 'node_modules', '@anisirji')}"`
    : null;
  const detail = {
    local: `local, inside the project folder ${found.where}: the pocket-dev command exists only there`,
    npx: 'through npx: a temporary copy that npm throws away',
    folder: `from a plain folder (${ctx.packageRoot}), not from npm`,
  }[found.kind];
  const note = found.kind === 'local'
    ? `Install it for the whole computer instead. Do not leave out the -g, and keep the @anisirji/ in the name. To remove this copy: ${cleanup}`
    : 'Install it for the whole computer, then use the pocket-dev command.';
  return { ...row, ok: false, detail, fix: { command: INSTALL_COMMAND, note } };
}

// ---- npm's global folder and PATH --------------------------------------------------------------------------------------

async function npmFacts(ctx) {
  const npm = ctx.find(NPM_ID);
  if (!npm) return { npm: null };
  const ask = async (args) => {
    const r = await ctx.run(npm, args, { timeout: TIMEOUT, env: ctx.childEnv });
    return r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop().trim() || null : null;
  };
  const [prefix, globalRoot] = await Promise.all([ask(['config', 'get', 'prefix']), ask(['root', '-g'])]);
  return { npm, prefix, globalRoot };
}

const pathList = (ctx) => (ctx.platform === 'win32' ? ctx.env.Path ?? ctx.env.PATH ?? '' : ctx.env.PATH ?? '').split(ctx.platform === 'win32' ? ';' : ':').filter(Boolean);
const trimSep = (s) => s.replace(/[\\/]+$/, '');

function prefixRow(ctx, { npm, prefix }) {
  const row = { id: 'prefix', title: 'npm global folder on PATH', level: 'recommended' };
  if (!npm) return { ...row, ok: false, detail: 'npm was not found', fix: { command: null, note: `Install Node.js with npm from https://nodejs.org/en/download, then open a new terminal.` } };
  if (!prefix) return { ...row, ok: false, detail: 'npm did not say where it installs global packages', fix: { command: 'npm config get prefix', note: 'Run it yourself and read the folder it prints.' } };
  const P = pathsFor(ctx.platform);
  const bin = ctx.platform === 'win32' ? prefix : P.join(prefix, 'bin');
  if (pathList(ctx).some((dir) => same(ctx.platform, trimSep(dir), trimSep(bin)))) return { ...row, ok: true, detail: `${bin} is on PATH` };
  const command = ctx.platform === 'win32'
    ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${bin}', 'User')`
    : `echo 'export PATH="${bin}:$PATH"' >> ~/.zshrc   (or ~/.bashrc)`;
  return { ...row, ok: false, detail: `${bin} is where npm puts commands (npm config get prefix), but it is not on PATH`,
    fix: { command, note: `PATH is the list of folders your terminal searches for commands. Add that folder, then open a new terminal.` } };
}

// PATH only: unlike setup's lookup this does not add folders a terminal would not search.
export function onPath(ctx, name) {
  const P = pathsFor(ctx.platform);
  const exts = ctx.platform === 'win32' ? (ctx.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of pathList(ctx)) for (const ext of exts) {
    const file = P.join(dir, name + ext);
    if (ctx.exists(file)) return file;
  }
  return null;
}

// A Windows shim (.cmd) names the package it runs inside its text; a Mac or Linux link points into its folder. The
// other `pocket-dev` package (2020) lives in node_modules/pocket-dev, ours in node_modules/@anisirji/pocket-dev.
export function foreignCommand(ctx, file) {
  let text = '';
  try { text = (ctx.readFile ?? ((f) => fs.readFileSync(f, 'utf8')))(file); } catch {}
  const haystack = `${ctx.realpath ? ctx.realpath(file) : file}\n${text.length < 20_000 ? text : ''}`;
  if (/@anisirji[\\/]pocket-dev/.test(haystack)) return false;
  return /node_modules[\\/]pocket-dev[\\/]/.test(haystack);
}

function commandRow(ctx) {
  const row = { id: 'command', title: 'pocket-dev command', level: 'recommended' };
  const file = onPath(ctx, 'pocket-dev');
  if (file && foreignCommand(ctx, file)) return { ...row, ok: false, detail: `${file} belongs to a different npm package also named pocket-dev, not this one`,
    fix: { command: `npm uninstall -g pocket-dev && ${INSTALL_COMMAND}`, note: 'Then open a new terminal. Until then this tool also runs under its other name: pocketdev-app start' } };
  if (file) return { ...row, ok: true, detail: file };
  return { ...row, ok: false, detail: 'typing pocket-dev would say "not recognised"',
    fix: { command: INSTALL_COMMAND, note: 'If it is already installed this way, the npm global folder is not on PATH: see the row above, then open a new terminal.' } };
}

// ---- Terminals (node-pty) --------------------------------------------------------------------------------------------

// Loads node-pty and really starts the computer's shell for a second. Resolves { available, reason, detail }.
export async function probeTerminals({ shell, shellArgs, cwd = os.homedir(), env = process.env, importer, wait = PROBE_MS } = {}) {
  const status = await loadPty({ importer, env });
  if (!status.available) return { available: false, reason: status.reason };
  let proc;
  try {
    proc = status.pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
  } catch (err) {
    const helper = /posix_spawnp/.test(err.message) ? ' (its helper file may not be executable, or the shell path is wrong)' : '';
    return { available: false, reason: `the terminal component loaded but could not start ${shell}: ${String(err.message).split('\n')[0]}${helper}` };
  }
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('running'), wait);
    proc.onData(() => { clearTimeout(timer); resolve('output'); });
    proc.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode === 0 ? 'exited' : `exit ${exitCode}`); });
  });
  try { proc.kill(); } catch {}
  if (outcome.startsWith('exit ')) return { available: false, reason: `the shell ${shell} stopped at once (${outcome})` };
  return { available: true, detail: `started ${shell} and stopped it` };
}

async function terminalsRow(ctx) {
  const row = { id: 'terminals', title: 'Terminals (node-pty)', level: 'required' };
  const probe = await ctx.probeTerminals();
  if (probe.available) return { ...row, ok: true, detail: probe.detail ?? 'works' };
  return { ...row, ok: false, detail: probe.reason, fix: { command: REPAIR_COMMAND, note: 'Repairs node-pty (npm rebuild, or installs it again). Everything except terminals works meanwhile.' } };
}

// ---- Tools, state folder, port, firewall -------------------------------------------------------------------------------

async function toolRows(ctx, facts) {
  const rows = [];
  for (const tool of TOOLS) {
    const d = await detectTool(tool, ctx);
    if (tool.id === 'node') {
      const old = d.status === 'outdated';
      rows.push({ id: 'node', title: tool.title, level: 'required', ok: d.status === 'ok', detail: d.detail,
        fix: d.status === 'ok' ? null : { command: ctx.platform === 'win32' ? 'winget install OpenJS.NodeJS' : null, note: old ? `Pocket Dev needs Node ${MIN_NODE} or newer.` : 'Node.js with npm: https://nodejs.org/en/download', link: 'https://nodejs.org/en/download' } });
      continue;
    }
    const fix = fixFor(tool, d, { ...facts, npmFound: !!facts.npm }, ctx.platform);
    const login = d.loggedIn === true ? ', logged in' : d.loggedIn === false ? ', not logged in' : '';
    rows.push({ id: tool.id, title: tool.title, level: tool.level, ok: d.status === 'ok', detail: d.installed ? `installed${d.version ? ` ${d.version}` : ''}${login}` : 'not installed', fix: fix && { command: fix.command, note: fix.note, link: fix.link } });
  }
  return rows;
}

function stateRow(ctx) {
  const row = { id: 'state', title: 'Settings folder writable', level: 'required' };
  const problem = ctx.checkWritable(ctx.stateDir);
  if (!problem) return { ...row, ok: true, detail: ctx.stateDir };
  return { ...row, ok: false, detail: `${ctx.stateDir}: ${problem}`, fix: { command: null, note: 'Pocket Dev saves its passwords and devices here. Fix the folder\'s permissions, or point it elsewhere with the POCKET_DEV_STATE_DIR environment variable.' } };
}

async function portRow(ctx) {
  const row = { id: 'port', title: `Port ${ctx.port} free`, level: 'recommended' };
  if (await ctx.portFree(ctx.port)) return { ...row, ok: true, detail: 'free' };
  return { ...row, ok: false, detail: 'something is already using it (Pocket Dev itself, if it is running)', fix: { command: 'pocket-dev config set port 7778', note: 'Only needed when Pocket Dev is not already running. Restart it afterwards.' } };
}

function firewallRow(ctx) {
  if (ctx.platform !== 'win32') return null;
  return { id: 'firewall', title: 'Windows Firewall', level: 'info', ok: true, info: true,
    detail: 'cannot be checked here. Windows asks once to let Node.js through: choose Private networks and Allow',
    fix: { command: `New-NetFirewallRule -DisplayName "Pocket Dev" -Direction Inbound -Program "${process.execPath}" -Action Allow -Profile Private`, note: 'Only if the phone cannot open the address on the same Wi-Fi. Run in PowerShell as administrator.' } };
}

// ---- The run ---------------------------------------------------------------------------------------------------------

export async function collectDoctor(ctx) {
  const facts = await gatherFacts(ctx);
  const npm = await npmFacts(ctx);
  const tools = await toolRows(ctx, facts);
  const [node, ...rest] = tools;
  const rows = [node, installRow(ctx, npm.globalRoot), prefixRow(ctx, npm), commandRow(ctx), await terminalsRow(ctx), ...rest, stateRow(ctx), await portRow(ctx), firewallRow(ctx)].filter(Boolean);
  return { rows, install: rows.find((r) => r.id === 'install').found, ok: rows.filter((r) => r.level === 'required').every((r) => r.ok) };
}

const paint = (ctx, code, text) => (ctx.color ? `\x1b[${code}m${text}\x1b[0m` : text);

export function printDoctor(ctx, { rows, ok }) {
  const w = (f) => Math.max(...rows.map((r) => f(r).length));
  const wt = w((r) => r.title), wl = w((r) => r.level);
  ctx.out(`Pocket Dev ${PACKAGE.version} doctor (${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[ctx.platform] ?? ctx.platform}, Node ${ctx.nodeVersion})`);
  ctx.out('');
  for (const r of rows) {
    const mark = r.info ? paint(ctx, 36, 'i') : r.ok ? paint(ctx, 32, '✓') : r.level === 'required' ? paint(ctx, 31, '✗') : paint(ctx, 33, '✗');
    ctx.out(`${mark} ${r.title.padEnd(wt)}  ${r.level.padEnd(wl)}  ${r.detail}`);
  }
  const todo = rows.filter((r) => r.fix && (!r.ok || r.info));
  if (todo.length) {
    ctx.out('');
    ctx.out('Next steps:');
    for (const r of todo) {
      ctx.out(`  ${r.title}: ${r.fix.command ? `run  ${r.fix.command}` : r.fix.note}`);
      if (r.fix.command) ctx.out(`    ${r.fix.note}`);
      if (r.fix.link) ctx.out(`    ${r.fix.link}`);
    }
  }
  ctx.out('');
  const broken = rows.filter((r) => !r.ok && r.level === 'required');
  ctx.out(ok ? 'Everything Pocket Dev requires is working.' : `Something required is not working: ${broken.map((r) => r.title).join(', ')}.`);
  return ok;
}

// ---- Repair ----------------------------------------------------------------------------------------------------------

const BUILD_TOOLS = {
  win32: ['A compiler is needed to build node-pty on this computer. Install the Windows Build Tools and Python, then run pocket-dev doctor --fix again:',
    '  winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"', '  winget install Python.Python.3.12'],
  darwin: ['A compiler is needed to build node-pty on this computer. Install the Xcode Command Line Tools, then run pocket-dev doctor --fix again:', '  xcode-select --install'],
  linux: ['A compiler is needed to build node-pty on this computer. Install the build tools, then run pocket-dev doctor --fix again (Pocket Dev does not run sudo for you):',
    '  Debian, Ubuntu: sudo apt install build-essential python3', '  Fedora: sudo dnf groupinstall "Development Tools" && sudo dnf install python3', '  Arch: sudo pacman -S base-devel python'],
};

// What `--fix` would run, in order. The first is cheap and enough when node-pty is there but broken; the second brings
// back a node-pty that never got unpacked (the usual Windows failure) without touching anything else.
export function repairPlan(ctx) {
  const npm = ctx.find(NPM_ID);
  if (!npm) return { steps: [], reason: 'npm was not found. Install Node.js from https://nodejs.org/en/download, open a new terminal and run pocket-dev doctor --fix again.' };
  const present = ctx.exists(pathsFor(ctx.platform).join(ctx.packageRoot, 'node_modules', 'node-pty', 'package.json'));
  const rebuild = { argv: [npm, 'rebuild', 'node-pty'], why: 'builds node-pty again in the Pocket Dev folder' };
  const install = { argv: [npm, 'install', '--no-save', '--no-audit', '--no-fund', `node-pty@${NODE_PTY_RANGE}`], why: 'installs node-pty into the Pocket Dev folder without changing anything else' };
  return { steps: present ? [rebuild, install] : [install] };
}

const show = (argv) => argv.map((a, i) => (i === 0 ? path.basename(a).replace(/\.cmd$/i, '') : a)).join(' ');

// Resolves true when terminals work afterwards. Asks before each command unless opts.yes.
export async function repairTerminals(ctx, opts = {}) {
  const { steps, reason } = repairPlan(ctx);
  if (reason) { ctx.out(reason); return false; }
  const works = async () => (await ctx.probeTerminals()).available;
  for (const step of steps) {
    ctx.out(`  In ${ctx.packageRoot}:`);
    ctx.out(`  $ ${show(step.argv)}   (${step.why})`);
    if (!ctx.isTTY && !opts.yes) { ctx.out('  Not an interactive terminal: run that command yourself, or add --yes.'); return false; }
    const go = opts.yes ? true : await ctx.ask('  Run it? [Y/n] ', true);
    if (!go) { ctx.out('  Skipped.'); continue; }
    const r = await ctx.run(step.argv[0], step.argv.slice(1), { inherit: true, env: ctx.childEnv, cwd: ctx.packageRoot });
    ctx.log?.(`doctor ran: ${show(step.argv)} -> ${r.error ? `could not start (${r.error.code ?? 'error'})` : `exit ${r.code}`}`);
    if (await works()) { ctx.out('  ✓ Terminals work now. Restart Pocket Dev so it picks them up (pocket-dev service restart, or stop and run pocket-dev start).'); return true; }
    ctx.out(`  Terminals still do not work${r.code ? ` (npm exited ${r.code})` : ''}.`);
  }
  for (const line of BUILD_TOOLS[ctx.platform] ?? BUILD_TOOLS.linux) ctx.out(line);
  if (ctx.platform === 'win32') ctx.out('  If files kept going missing while npm unpacked, see the Windows steps in docs/SETUP.md (Troubleshooting).');
  return false;
}

// ---- Context and command ------------------------------------------------------------------------------------------

function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    return null;
  } catch (err) { return err.code ? `${err.code}` : String(err.message); }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    // The server binds every interface when Wi-Fi access is on; on Windows a 127.0.0.1 bind succeeds beside it.
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

function configuredPort(env = process.env) {
  if (Number(env.PORT)) return Number(env.PORT);
  try { return Number(JSON.parse(fs.readFileSync(env.POCKET_DEV_CONFIG || path.join(STATE_DIR, 'config.json'), 'utf8')).port) || 7777; } catch { return 7777; }
}

// The doctor's real lookups, as overrides for setup's context.
export async function doctorDefaults() {
  const { platform: host } = await import('./platform.js');
  const shell = host.defaultShell();
  return {
    packageRoot: PACKAGE_ROOT, stateDir: STATE_DIR, port: configuredPort(),
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    checkWritable, portFree,
    probeTerminals: () => probeTerminals({ shell, shellArgs: host.shellArgs(shell) }),
  };
}

// Fills in whatever a test did not supply.
export function withDoctorDefaults(ctx, defaults) {
  for (const [k, v] of Object.entries(defaults)) ctx[k] ??= v;
  return ctx;
}

export async function doctorCommand(args, ctx) {
  const bad = args.find((a) => !['--fix', '--yes', '-y'].includes(a));
  if (bad) { console.log(`Unknown option "${bad}". Usage: pocket-dev doctor [--fix] [--yes]`); return 2; }
  const opts = { fix: args.includes('--fix'), yes: args.includes('--yes') || args.includes('-y') };
  ctx.log ??= () => {};
  const report = await collectDoctor(ctx);
  printDoctor(ctx, report);
  const terminals = report.rows.find((r) => r.id === 'terminals');
  if (!opts.fix) {
    if (!terminals.ok) ctx.out('To repair terminals: pocket-dev doctor --fix');
    return report.ok ? 0 : 1;
  }
  ctx.out('');
  if (terminals.ok) { ctx.out('Nothing to repair: terminals work.'); return report.ok ? 0 : 1; }
  if (report.install.kind === 'npx') { ctx.out('This is a temporary npx copy, so repairing it would not last. Install it first:  ' + INSTALL_COMMAND); return 1; }
  ctx.out('Repair terminals');
  const fixed = await repairTerminals(ctx, opts);
  if (!fixed) return 1;
  return (await collectDoctor(ctx)).ok ? 0 : 1;
}
