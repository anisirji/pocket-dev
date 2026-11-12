import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR } from './paths.js';
import { findBin, engineEnv, lstatExists, windowsBinCandidates } from './chat/env.js';
import { findCloudflared, readNetwork, networkError } from './network.js';

// `pocket-dev setup`: one guided pass that takes a computer from nothing to a working, logged-in Pocket Dev.
// Detection and the plan for each tool are pure functions of a context (platform, a command runner, a lookup), so
// every operating system is tested from any computer. Nothing here reads, prints, stores or sends a credential: logins
// are handed to the tool's own command with the terminal attached, and status commands are only checked for yes or no.

export const MIN_NODE = 22;
// A running server keeps the PATH it started with, so a tool installed since then is invisible to its terminals and chats.
export const RESTART_NOTE = 'Restart Pocket Dev so it sees tools installed after it started: pocket-dev service restart (or stop it and run pocket-dev start).';
export const SETUP_LOG = path.join(STATE_DIR, 'setup.log');
// Written when a full guided setup ends, so the first start does not guide this computer again.
export const SETUP_DONE = path.join(STATE_DIR, 'setup-done');
const STATUS_TIMEOUT_MS = 8000;

const NODE_LINK = 'https://nodejs.org/en/download';
const CLOUDFLARED_LINK = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

// level: required (setup fails without it), recommended, optional. `npm` is the official package; `login` and
// `status` are the tool's own commands. Claude Code and Codex are each optional, but one of them is what the chat uses.
// `optIn` tools are accounts the person signs up for, so installing or logging in is never pre-selected, not even by --yes.
export const TOOLS = [
  { id: 'node', title: 'Node.js and npm', level: 'required', why: 'Runs Pocket Dev.' },
  { id: 'git', title: 'Git', level: 'recommended', bin: 'git', why: 'The Git screen and project history.' },
  { id: 'claude', title: 'Claude Code', level: 'optional', bin: 'claude', env: 'POCKET_DEV_CLAUDE', npm: '@anthropic-ai/claude-code', optIn: true,
    status: ['auth', 'status'], login: ['auth', 'login'], why: 'Chats with Claude.' },
  { id: 'codex', title: 'Codex', level: 'optional', bin: 'codex', env: 'POCKET_DEV_CODEX', npm: '@openai/codex', optIn: true,
    status: ['login', 'status'], login: ['login'], why: 'Chats with Codex.' },
  { id: 'gh', title: 'GitHub CLI', level: 'optional', bin: 'gh', optIn: true, status: ['auth', 'status'], login: ['auth', 'login'], why: 'Pull requests in Git.' },
  { id: 'cloudflared', title: 'cloudflared', level: 'optional', bin: 'cloudflared', env: 'POCKET_DEV_CLOUDFLARED', why: 'The internet link (Cloudflare tunnel).' },
];
export const STEP_IDS = [...TOOLS.map((t) => t.id), 'terminals', 'password', 'network', 'always-on', 'finish'];
const toolById = (id) => TOOLS.find((t) => t.id === id);

const NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

// ---- Finding and running programs ---------------------------------------------------------------------------------

// The same lookup the app uses: POCKET_DEV_CLAUDE, POCKET_DEV_CODEX or POCKET_DEV_CLOUDFLARED when set, otherwise
// findCloudflared or findBin's PATH plus the folders installers use. Windows looks along PATH with PATHEXT.
export function defaultFind(tool, { platform = process.platform, env = process.env, exists = lstatExists } = {}) {
  const override = tool.env && env[tool.env];
  if (override) return exists(override) ? override : null;
  if (tool.id === 'cloudflared') return findCloudflared();
  if (platform !== 'win32') return findBin(tool.bin);
  // Tests pass their own env, and then the registry is not read.
  return findBin(tool.bin, { platform, isFile: exists, candidates: windowsBinCandidates(tool.bin, { env, ...(env === process.env ? {} : { registryDirs: [] }) }) });
}

// Refuses a command line that carries a secret, so no future edit can put one in ps or the shell history.
const SECRET_ARG = /^--?(?:[a-z]+-)*(?:password|passwd|token|secret|api-?key|key)$|^(sk-|ghp_|gho_|github_pat_)|^[A-Za-z0-9_=-]{40,}$/i;
export function assertNoSecret(argv) {
  for (const arg of argv.slice(1)) if (SECRET_ARG.test(String(arg))) throw new Error('Refusing to run a command line that carries a secret.');
}

// On Windows only a real .exe can be started directly. A bare name such as `npm` is npm.cmd, and a .cmd or .bat needs cmd.exe.
export const needsShell = (cmd, platform = process.platform) => platform === 'win32' && !/\.(exe|com)$/i.test(String(cmd));

// Resolves { code, stdout, stderr, timedOut, error } and never rejects. `inherit` hands the terminal to the program.
export function realRun(cmd, args, { timeout = 0, inherit = false, env, cwd } = {}) {
  assertNoSecret([cmd, ...args]);
  return new Promise((resolve) => {
    const win = needsShell(cmd);
    let child;
    try {
      // A .cmd/.bat needs cmd.exe. One command string (not an args array with shell:true, which Node 24+ deprecates as DEP0190) keeps the quoting ours.
      const quote = (a) => (a === '' || /[\s&|<>()^"%]/.test(a)) ? `"${String(a).replace(/"/g, '""')}"` : a;
      const stdio = inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'];
      child = win
        ? spawn([cmd, ...args].map(quote).join(' '), { stdio, env, cwd, shell: true, windowsHide: !inherit })
        : spawn(cmd, args, { stdio, env, cwd, windowsHide: !inherit });
    } catch (error) { return resolve({ code: null, stdout: '', stderr: '', timedOut: false, error }); }
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, error: null, ...r }); } };
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout) : null;
    child.stdout?.on('data', (d) => { stdout = (stdout + d).slice(-20_000); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
  });
}

// ---- Detection ----------------------------------------------------------------------------------------------------

export const parseVersion = (text) => /\d+(?:\.\d+){1,3}/.exec(String(text))?.[0] ?? null;

// true: logged in, false: logged out, null: could not tell (timeout, program error). Only these three answers leave
// this function: the output itself, which can hold an email address or a token fragment, is never kept.
export function parseLogin(id, r) {
  if (r.timedOut || r.error) return null;
  const text = `${r.stdout}\n${r.stderr}`;
  if (id === 'claude') {
    try { return JSON.parse(r.stdout).loggedIn === true; } catch { return r.code === 0 && !/not logged in/i.test(text); }
  }
  if (id === 'codex') return r.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  return r.code === 0;
}

export async function detectTool(tool, ctx) {
  const base = { id: tool.id, title: tool.title, level: tool.level, why: tool.why, installed: false, version: null, loggedIn: null, status: 'missing', detail: '' };
  if (tool.id === 'node') {
    const major = Number(String(ctx.nodeVersion).split('.')[0]);
    const npm = ctx.find({ id: 'npm', bin: 'npm' });
    const npmVersion = npm ? parseVersion((await ctx.run(npm, ['--version'], { timeout: STATUS_TIMEOUT_MS, env: ctx.childEnv })).stdout) : null;
    const old = major < MIN_NODE;
    return { ...base, installed: !old && !!npmVersion, version: ctx.nodeVersion, detail: `Node ${ctx.nodeVersion}, ${npmVersion ? `npm ${npmVersion}` : 'npm not found'}`,
      status: old ? 'outdated' : npmVersion ? 'ok' : 'missing', npmFound: !!npm };
  }
  const file = ctx.find(tool);
  if (!file) return base;
  // On a Mac, /usr/bin/git is a stub that opens Apple's installer window when the command line tools are missing.
  if (tool.id === 'git' && ctx.platform === 'darwin' && file === '/usr/bin/git' && (await ctx.run('/usr/bin/xcode-select', ['-p'], { timeout: STATUS_TIMEOUT_MS })).code !== 0) return base;
  const v = await ctx.run(file, ['--version'], { timeout: STATUS_TIMEOUT_MS, env: ctx.childEnv });
  const found = { ...base, installed: true, version: parseVersion(`${v.stdout} ${v.stderr}`), path: file, status: 'ok' };
  if (!tool.status) return found;
  const s = await ctx.run(file, tool.status, { timeout: STATUS_TIMEOUT_MS, env: ctx.childEnv });
  const loggedIn = parseLogin(tool.id, s);
  return { ...found, loggedIn, status: loggedIn === true ? 'ok' : loggedIn === false ? 'logged-out' : 'unknown' };
}

// Facts the plans need: which package managers exist, and whether `npm install -g` can write without administrator rights.
export async function gatherFacts(ctx) {
  const has = {};
  for (const name of ['brew', 'winget', 'apt-get', 'dnf', 'pacman', 'zypper', 'systemctl']) has[name] = !!ctx.find({ id: name, bin: name });
  let npmWritable = null;
  const npm = ctx.find({ id: 'npm', bin: 'npm' });
  if (npm && ctx.platform !== 'win32') {
    const r = await ctx.run(npm, ['prefix', '-g'], { timeout: STATUS_TIMEOUT_MS, env: ctx.childEnv });
    const prefix = r.stdout.trim();
    if (r.code === 0 && prefix) npmWritable = ctx.writable(prefix) && ctx.writable(path.join(prefix, 'lib', 'node_modules'), true);
  }
  return { has, npmWritable, npm };
}

export async function detectAll(ctx, ids = TOOLS.map((t) => t.id)) {
  return Promise.all(ids.map((id) => detectTool(toolById(id), ctx)));
}

// ---- Plans --------------------------------------------------------------------------------------------------------

const cmd = (argv, source, extra = {}) => ({ action: 'run', argv, display: argv.join(' '), source, ...extra });
const manual = (reason, steps, link) => ({ action: 'manual', reason, steps, link });

const LINUX_PM = {
  git: { 'apt-get': 'sudo apt install git', dnf: 'sudo dnf install git', pacman: 'sudo pacman -S git', zypper: 'sudo zypper install git' },
  gh: { 'apt-get': 'sudo apt install gh', dnf: 'sudo dnf install gh', pacman: 'sudo pacman -S github-cli', zypper: 'sudo zypper install gh' },
  cloudflared: { pacman: 'sudo pacman -S cloudflared' },
};
const WINGET = { git: ['winget', 'install', '--id', 'Git.Git', '-e'], gh: ['winget', 'install', '--id', 'GitHub.cli', '-e'], cloudflared: ['winget', 'install', 'Cloudflare.cloudflared'] };
const BREW = { git: 'git', gh: 'gh', cloudflared: 'cloudflared' };
const LINKS = {
  git: { darwin: 'https://git-scm.com/download/mac', win32: 'https://git-scm.com/download/win', linux: 'https://git-scm.com/download/linux' },
  gh: { darwin: 'https://cli.github.com', win32: 'https://cli.github.com', linux: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md' },
  cloudflared: { darwin: CLOUDFLARED_LINK, win32: CLOUDFLARED_LINK, linux: CLOUDFLARED_LINK },
};

// What to do about a missing tool on this system. `run` plans are safe to run as the current user; `manual` plans are
// printed for the person to do themselves (administrator rights, or a package manager that is not there).
export function installPlan(id, { platform, has = {}, npmWritable = null, npmFound = true }) {
  const tool = toolById(id);
  if (id === 'node') {
    const how = { darwin: 'Run yourself: brew install node', win32: 'Run yourself: winget install OpenJS.NodeJS', linux: `Install Node ${MIN_NODE} or newer with your package manager, nvm or fnm` }[platform];
    return manual(`Pocket Dev needs Node ${MIN_NODE} or newer, with npm. Pocket Dev cannot update the Node that is running it.`,
      [how, `Or download it from ${NODE_LINK}`, 'Then run: pocket-dev setup'], NODE_LINK);
  }
  if (tool.npm) {
    if (!npmFound) return manual('npm is not installed, and it installs this tool.', [`Install Node.js with npm first (${NODE_LINK}), then run: pocket-dev setup`], NODE_LINK);
    const argv = ['npm', 'install', '-g', tool.npm];
    if (platform !== 'win32' && npmWritable === false) {
      return manual('npm cannot write to its global folder without administrator rights, and Pocket Dev does not run administrator commands.',
        [`Run yourself: sudo ${argv.join(' ')}`, 'Or use a Node installed in your home folder (nvm, fnm), then run: pocket-dev setup'], NODE_LINK);
    }
    return cmd(argv, `npm package ${tool.npm}`);
  }
  const link = LINKS[id]?.[platform];
  if (platform === 'darwin') {
    if (has.brew) return cmd(['brew', 'install', BREW[id]], `Homebrew formula ${BREW[id]}`);
    return manual('Homebrew is not installed. Pocket Dev does not run its installer script.',
      [id === 'git' ? 'Run yourself: xcode-select --install   (opens Apple\'s installer window)' : `Install Homebrew from https://brew.sh, then run: brew install ${BREW[id]}`,
        `Or download it from ${link}`, 'Then run: pocket-dev setup'], link);
  }
  if (platform === 'win32') {
    if (has.winget) return cmd(WINGET[id], `winget package ${WINGET[id].at(id === 'cloudflared' ? -1 : -2)}`, { note: 'Windows may ask for permission in its own window.' });
    return manual('winget is not installed (it comes with the App Installer from Microsoft).',
      [`Install App Installer from https://aka.ms/getwinget, then run: ${WINGET[id].join(' ')}`, `Or download it from ${link}`, 'Then run: pocket-dev setup'], link);
  }
  if (has.brew) return cmd(['brew', 'install', BREW[id]], `Homebrew formula ${BREW[id]}`);
  const pm = Object.keys(LINUX_PM[id] ?? {}).find((name) => has[name]);
  if (pm) return manual('Installing with your package manager needs administrator rights, and Pocket Dev does not run administrator commands.',
    [`Run yourself: ${LINUX_PM[id][pm]}`, `Other ways: ${link}`, 'Then run: pocket-dev setup'], link);
  return manual('No supported package manager was found for this tool.', [`Install it from ${link}`, 'Then run: pocket-dev setup'], link);
}

export const loginCommand = (tool, file = tool.bin) => (tool.login ? [file, ...tool.login] : null);
const shortLogin = (tool) => [tool.bin, ...tool.login].join(' ');

// What fixes a tool that is not fully ready, for the status table and for the phone: a command to run on this
// computer (or null), and a sentence. `fix` is null when the tool is fine.
export function fixFor(tool, d, facts, platform) {
  if (d.status === 'ok') return null;
  if (d.status === 'logged-out') return { kind: 'login', command: shortLogin(tool), note: 'Opens your browser to sign in.' };
  if (d.status === 'unknown') return { kind: 'check', command: tool.status ? `${tool.bin} ${tool.status.join(' ')}` : null, note: 'Could not check the login in time.' };
  const plan = installPlan(tool.id, { platform, ...facts });
  if (plan.action === 'run') return { kind: 'install', command: plan.display, note: plan.note ?? `Source: ${plan.source}.` };
  const first = plan.steps.find((s) => s.startsWith('Run yourself: '));
  return { kind: 'manual', command: first ? first.slice('Run yourself: '.length) : null, note: plan.reason, link: plan.link };
}

// The tools' state for the phone: no paths, no account details, no output of any command.
export async function collectStatus(ctx) {
  const facts = await gatherFacts(ctx);
  const states = await detectAll(ctx);
  return {
    platform: ctx.platform,
    tools: states.map((d) => {
      const tool = toolById(d.id);
      const fix = fixFor(tool, d, { ...facts, npmFound: d.npmFound ?? !!facts.npm }, ctx.platform);
      return { id: d.id, title: d.title, level: d.level, installed: d.installed, version: d.version, loggedIn: d.loggedIn, status: d.status,
        ...(fix && { fix: { kind: fix.kind, command: fix.command, note: fix.note, ...(fix.link && { link: fix.link }) } }) };
    }),
  };
}

// The phone asks often and each look runs a few programs, so one answer is shared for a short while.
export function cachedStatus(ctx = createContext(), ttlMs = 20_000, now = Date.now) {
  let at = 0, pending = null, last = null;
  return () => {
    if (last && now() - at < ttlMs) return Promise.resolve(last);
    pending ??= collectStatus(ctx).then((v) => { last = v; at = now(); return v; }).finally(() => { pending = null; });
    return pending;
  };
}

// ---- Context ------------------------------------------------------------------------------------------------------

function writable(file, dirIsOptional = false) {
  try { fs.accessSync(file, fs.constants.W_OK); return true; } catch (err) { return dirIsOptional && err.code === 'ENOENT'; }
}

export function createContext(overrides = {}) {
  const platformName = overrides.platform ?? process.env.POCKET_DEV_PLATFORM ?? process.platform;
  const env = overrides.env ?? process.env;
  const base = {
    platform: platformName, env, nodeVersion: process.versions.node, writable,
    childEnv: platformName === 'win32' ? env : engineEnv(),
    run: realRun,
    out: (line = '') => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    color: !env.NO_COLOR && !!process.stdout.isTTY,
  };
  const ctx = { ...base, ...overrides };
  ctx.find ??= (tool) => defaultFind(tool, { platform: ctx.platform, env: ctx.env });
  ctx.exists ??= fs.existsSync;
  return ctx;
}

// ---- Output -------------------------------------------------------------------------------------------------------

const paint = (ctx, code, text) => (ctx.color ? `\x1b[${code}m${text}\x1b[0m` : text);
const good = (ctx, t) => paint(ctx, 32, t);
const bad = (ctx, t) => paint(ctx, 31, t);
const dim = (ctx, t) => paint(ctx, 2, t);
const LEVEL_WORD = { required: 'required', recommended: 'recommended', optional: 'optional' };

function statusWords(d) {
  if (d.status === 'ok' && d.id === 'node') return { installed: d.detail, login: '-' };
  const installed = d.installed ? `installed${d.version ? ` ${d.version}` : ''}` : d.id === 'node' && d.status === 'outdated' ? d.detail : 'not installed';
  const login = !d.installed ? '-' : d.loggedIn === true ? 'logged in' : d.loggedIn === false ? 'not logged in' : d.status === 'unknown' ? 'could not check' : '-';
  return { installed, login };
}

function statusLine(ctx, d) {
  const { installed, login } = statusWords(d);
  const mark = d.status === 'ok' ? good(ctx, '✓') : d.level === 'required' ? bad(ctx, '✗') : paint(ctx, 33, '✗');
  return `${mark} ${d.title}: ${installed}${login === '-' ? '' : `, ${login}`}`;
}

// ---- Logging ------------------------------------------------------------------------------------------------------

// The log holds the command lines that ran and how they ended, nothing the programs printed.
export function makeLogger(file = SETUP_LOG, now = () => new Date().toISOString()) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${now()} ${line}\n`, { mode: 0o600 });
    } catch {}
  };
}

// ---- Steps --------------------------------------------------------------------------------------------------------

async function yes(ctx, opts, question, def = true, optIn = false) {
  if (optIn) def = false;
  const hint = def ? '[Y/n]' : '[y/N]';
  if (opts.yes) { ctx.out(`${question} ${hint} ${optIn ? 'no (--yes leaves this to you)' : `${def ? 'yes' : 'no'} (--yes)`}`); return def; }
  return ctx.ask(`${question} ${hint} `, def);
}

function printManual(ctx, plan) {
  ctx.out(`  ${plan.reason}`);
  for (const s of plan.steps) ctx.out(`    ${s}`);
  ctx.out('  Continuing with the next step.');
}

async function runShown(ctx, argv, why) {
  ctx.out(`  $ ${argv.join(' ')}`);
  const r = await ctx.run(argv[0], argv.slice(1), { inherit: true, env: ctx.childEnv });
  ctx.log(`ran: ${argv.join(' ')} -> ${r.error ? `could not start (${r.error.code ?? 'error'})` : `exit ${r.code}`}${why ? ` (${why})` : ''}`);
  return r;
}

async function toolStep(ctx, opts, tool, facts) {
  let d = await detectTool(tool, ctx);
  ctx.out(statusLine(ctx, d));
  if (d.status === 'ok') return d;
  const toolFacts = { ...facts, npmFound: d.npmFound ?? facts.npmFound };

  if (!d.installed) {
    const plan = installPlan(tool.id, { platform: ctx.platform, ...toolFacts });
    if (plan.action === 'manual') { printManual(ctx, plan); return d; }
    ctx.out(`  Will run: ${plan.display}`);
    ctx.out(`  Source: ${plan.source}.${plan.note ? ` ${plan.note}` : ''}`);
    if (opts.dry) { ctx.out('  (dry run: not asked, not run)'); return d; }
    if (!(await yes(ctx, opts, '  Install now?', true, tool.optIn))) { ctx.out('  Skipped. You can run setup again any time.'); return d; }
    const r = await runShown(ctx, plan.argv, `install ${tool.id}`);
    if (r.code !== 0) { ctx.out(`  The install did not finish (${r.error ? `could not start ${plan.argv[0]}` : `exit ${r.code}`}). Read the messages above, fix that, and run pocket-dev setup again.`); return d; }
    d = { ...await detectTool(tool, ctx), justInstalled: true };
    ctx.out(statusLine(ctx, d));
    if (!d.installed) { ctx.out('  Installed, but this window cannot see it yet. Open a new terminal and run pocket-dev setup again.'); return d; }
  }

  if (tool.login && d.status !== 'ok') {
    if (d.status === 'unknown') { ctx.out(`  Could not check the login in ${STATUS_TIMEOUT_MS / 1000} seconds. Check it yourself: ${tool.bin} ${tool.status.join(' ')}`); return d; }
    ctx.out(`  Will run: ${shortLogin(tool)}   (your browser opens; Pocket Dev never sees what you type there)`);
    if (opts.dry) { ctx.out('  (dry run: not asked, not run)'); return d; }
    if (!(await yes(ctx, opts, '  Log in now?', true, tool.optIn))) { ctx.out(`  Skipped. Later: ${shortLogin(tool)}`); return d; }
    await runShown(ctx, [d.path ?? tool.bin, ...tool.login], `login ${tool.id}`);
    d = { ...await detectTool(tool, ctx), justInstalled: d.justInstalled };
    ctx.out(statusLine(ctx, d));
  }
  return d;
}

const KNOWN_CONFIG = (ctx) => (ctx.readConfig ? ctx.readConfig() : {});

async function passwordStep(ctx, opts) {
  ctx.out('Password');
  if (ctx.env.POCKET_DEV_PASSWORD) { ctx.out('  The password comes from POCKET_DEV_PASSWORD on this computer; setup leaves it alone.'); return; }
  const has = !!KNOWN_CONFIG(ctx).passwordHash;
  if (opts.dry) { ctx.out(`  Would ${has ? 'ask whether to change the password' : 'ask you to choose a password'} (6 to 200 characters). Only a scrypt hash is saved.`); return; }
  if (has) {
    ctx.out('  A password is already set.');
    if (opts.yes || !(await ctx.ask('  Change it? [y/N] ', false))) return;
  } else if (opts.yes) {
    ctx.out('  No password yet. Pocket Dev makes one the first time it starts and prints it there; change it any time in Settings.');
    return;
  }
  const { newPasswordError } = await import('./auth.js');
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await ctx.secret('  New password (6 to 200 characters, typing is hidden): ');
    const problem = newPasswordError(first);
    if (problem) { ctx.out(`  ${problem}`); continue; }
    if (first !== await ctx.secret('  Type it again: ')) { ctx.out('  They did not match.'); continue; }
    await ctx.writePassword(first);
    ctx.log('password saved (hash only)');
    ctx.out('  Password saved. Other logged-in devices stay logged in; log them out in Settings if you want.');
    return;
  }
  ctx.out('  No password was saved. Run pocket-dev setup --only password to try again.');
}

async function networkStep(ctx, opts, cloudflaredInstalled) {
  ctx.out('Phone access');
  const config = { read: () => KNOWN_CONFIG(ctx) };
  const current = readNetwork(config);
  const label = current.internet.kind === 'off' ? 'Wi-Fi only' : current.internet.kind === 'quick' ? 'Wi-Fi and a Quick internet link' : `Wi-Fi and your own domain (${current.internet.hostname})`;
  ctx.out(`  Now: ${label}.`);
  if (current.internet.kind === 'domain') { ctx.out('  Your own domain is set. Change it with pocket-dev internet domain or on the admin page.'); return current; }
  if (opts.dry) { ctx.out('  Would ask whether to add an internet link (needs cloudflared).'); return current; }
  if (opts.yes) { ctx.out('  Keeping it as it is (--yes).'); return current; }
  const wantInternet = await ctx.ask('  Reach this computer from outside your Wi-Fi with an internet link? [y/N] ', current.internet.kind === 'quick');
  if (wantInternet && !cloudflaredInstalled) {
    ctx.out('  The internet link needs cloudflared, which is not installed. Keeping Wi-Fi only; run pocket-dev setup --only cloudflared, then this step again.');
    return current;
  }
  const next = { wifi: true, internet: { kind: wantInternet ? 'quick' : 'off', hostname: null } };
  if (next.internet.kind === current.internet.kind) { ctx.out('  Unchanged.'); return current; }
  const invalid = networkError(next, { hasToken: false });
  if (invalid) { ctx.out(`  ${invalid}`); return current; }
  await ctx.saveNetwork(next);
  ctx.log(`network set to ${next.internet.kind === 'off' ? 'wifi only' : 'wifi and quick link'}`);
  ctx.out(`  Saved: ${next.internet.kind === 'off' ? 'Wi-Fi only' : 'Wi-Fi and a Quick link. The link starts from the admin page (pocket-dev admin) once Pocket Dev runs.'}`);
  return next;
}

// Terminals need node-pty, which npm treats as optional so that a failed build never fails the install. Without
// ctx.terminals (tests, the phone's status) this step does nothing.
async function terminalsStep(ctx, opts) {
  if (!ctx.terminals) return true;
  ctx.out('Terminals (node-pty)');
  const status = await ctx.terminals.check();
  if (status.available) { ctx.out(`  ✓ Works: ${status.detail ?? 'a shell started'}.`); return true; }
  ctx.out(`  ✗ Terminals are not available: ${status.reason}.`);
  if (opts.dry) { ctx.out('  (dry run: would offer to repair it, same as: pocket-dev doctor --fix)'); return false; }
  if (!(await yes(ctx, opts, '  Repair it now?'))) { ctx.out('  Skipped. Later: pocket-dev doctor --fix'); return false; }
  return ctx.terminals.repair({ yes: opts.yes });
}

// What the Always on step explains. It changes none of these: each is a system setting, an administrator command or a
// security trade-off that stays the person's own choice.
const SLEEP_NOTE = {
  darwin: 'Keep awake stops idle sleep only while Pocket Dev runs. Check System Settings > Energy (or Battery > Options) so the Mac does not sleep or log out on its own.',
  win32: 'Keep awake stops idle sleep only while Pocket Dev runs. Windows can still hibernate: check Settings > System > Power, and Control Panel > Power Options > Change plan settings.',
  linux: 'Keep awake holds sleep only while Pocket Dev runs (systemd-inhibit). Check your desktop power settings for suspend when idle and the lid action.',
};
const AUTO_LOGIN_NOTE = {
  darwin: 'Automatic login (your choice; setup never turns it on): after a restart the Mac waits at the login screen, so Pocket Dev does not start. System Settings > Users & Groups > Automatically log in as. Anyone who can switch on this Mac then gets your account.',
  win32: 'Automatic login (your choice; setup never turns it on): after a restart Windows waits at the login screen, so Pocket Dev does not start. Anyone who can switch on this PC then gets your account. If you want it: press Win+R, run netplwiz, and untick "Users must enter a user name and password". Pocket Dev never stores your Windows password.',
  linux: 'Automatic login (your choice; setup never turns it on): your display manager (GDM, SDDM, LightDM) has the setting. Or run once yourself: loginctl enable-linger $USER, so the service starts before anyone logs in.',
};
const FIREWALL_NOTE = {
  darwin: 'Firewall: macOS may ask "Accept incoming network connections?" for node. Choose Allow, or the phone cannot connect.',
  win32: `Firewall: Windows asks once to let Node.js through. Choose Private networks and Allow. If the phone still cannot connect, run this yourself in PowerShell as administrator: New-NetFirewallRule -DisplayName "Pocket Dev" -Direction Inbound -Program "${process.execPath}" -Action Allow -Profile Private`,
  linux: 'Firewall: if one is on (ufw, firewalld), allow the Pocket Dev port yourself, for example: sudo ufw allow 7777/tcp',
};
const POWER_NOTE = 'Power back on after a power cut: software cannot do this. In the BIOS or firmware, set "Restore on AC power loss" (or "AC recovery") to "Power on".';
const HEADLESS_NOTE = 'Without a screen: Screen view is Mac-only today, and programs that need a desktop window do not work without a display.';
const ADDRESS_NOTE = {
  off: 'Address: Wi-Fi only. Internet access stays off unless you turn it on: pocket-dev internet quick, or your own domain with pocket-dev internet domain.',
  quick: 'Address: a Quick link gets a new address after every restart. For a fixed one, use your own domain (a free Cloudflare account and a domain): pocket-dev internet domain',
  domain: 'Address: your own domain stays the same after a restart.',
};
const AWAKE_WHY = { always: 'stays awake on battery too', plugged: 'stays awake on the charger' };

// Plan C10 and C13: one question, one list of changes, one confirm. Returns true when a server runs or is starting.
async function alwaysOnStep(ctx, opts) {
  ctx.out('Always on');
  const svc = ctx.service;
  const laptop = await ctx.hasBattery().catch(() => false);
  const before = svc.available ? await svc.status().catch(() => ({})) : {};
  const question = '  Should this computer always be reachable from your phone?';
  if (opts.dry) ctx.out(`${question} (would ask; the default is ${laptop ? 'no, it has a battery' : 'yes'})`);
  const reachable = opts.dry ? !laptop : await yes(ctx, opts, question, !laptop);
  const awake = reachable ? 'always' : 'plugged';

  const plan = [];
  if (ctx.keepAwake.available && (KNOWN_CONFIG(ctx).awake ?? 'plugged') !== awake) {
    plan.push({ label: `Keep this computer awake: ${awake} (${AWAKE_WHY[awake]}).`, lines: [`Will run: pocket-dev config set awake ${awake}`],
      apply: async () => { await ctx.saveAwake(awake); ctx.log(`awake set to ${awake}`); } });
  }
  if (svc.available && !(before.installed && before.autostart && before.running)) {
    plan.push({ label: 'Run Pocket Dev in the background and start it at login. This also starts it now.', lines: svc.describe(), apply: async () => {
      try {
        const message = await svc.install();
        ctx.log(`service installed (${svc.kind})`);
        for (const line of String(message).split('\n').filter(Boolean).slice(-3)) ctx.out(`  ${line}`);
      } catch (err) {
        ctx.log(`service install failed (${svc.kind})`);
        ctx.out(`  Could not set it up: ${String(err.message).split('\n').slice(-3).join(' ')}`);
      }
    } });
  }
  if (!svc.available) ctx.out(`  Start at login is not available here: ${svc.reason} Run Pocket Dev yourself with: pocket-dev start`);
  if (!ctx.keepAwake.available) ctx.out(`  Keep awake is not available here: ${ctx.keepAwake.reason}`);

  if (!plan.length) ctx.out('  The recommended settings are already in place.');
  else {
    ctx.out('  I will:');
    plan.forEach((item, i) => { ctx.out(`    ${i + 1}. ${item.label}`); for (const line of item.lines) ctx.out(`       ${line}`); });
    ctx.out('  Then I show the address and a QR code to log in. Nothing outside this list changes.');
    if (opts.dry) ctx.out('  (dry run: not asked, not run)');
    else {
      let chosen = plan;
      if (!(await yes(ctx, opts, '  Apply the recommended settings?'))) {
        chosen = [];
        for (const [i, item] of plan.entries()) if (await ctx.ask(`  ${i + 1}. ${item.label} [y/N] `, false)) chosen.push(item);
      }
      for (const item of chosen) await item.apply();
    }
  }

  ctx.out('');
  ctx.out('  Good to know (setup changes none of these):');
  const notes = [FIREWALL_NOTE[ctx.platform]];
  if (reachable) notes.push(SLEEP_NOTE[ctx.platform], AUTO_LOGIN_NOTE[ctx.platform], ...(laptop ? [] : [POWER_NOTE]), HEADLESS_NOTE);
  notes.push(ADDRESS_NOTE[readNetwork({ read: () => KNOWN_CONFIG(ctx) }).internet.kind]);
  for (const note of notes.filter(Boolean)) ctx.out(`  - ${note}`);

  const after = svc.available && !opts.dry ? await svc.status().catch(() => ({})) : before;
  const nowAwake = KNOWN_CONFIG(ctx).awake ?? 'plugged';
  const mark = (ok) => (ok ? good(ctx, '✓') : paint(ctx, 33, '✗'));
  ctx.out('');
  ctx.out(opts.dry ? '  Always on, as it is now:' : '  Always on, checked:');
  if (svc.available) {
    ctx.out(`  ${mark(after.installed && after.autostart)} Starts at login: ${after.installed && after.autostart ? 'yes' : 'no'}`);
    ctx.out(`  ${mark(after.running)} Running in the background: ${after.running ? 'yes' : 'no'}`);
  }
  if (ctx.keepAwake.available) ctx.out(`  ${mark(nowAwake === awake)} Keep awake: ${nowAwake}`);
  return !!(after.running || after.installed);
}

// A server that setup or the service just started needs a few seconds before it listens, so the key is asked for again.
const READY_TRIES = 10;

// Prints the addresses and a one-time QR code from the running server. Resolves false when no server answered.
export async function printPhoneLogin(ctx, { tries = 1 } = {}) {
  let res = null;
  for (let i = 0; i < tries && !res; i++) {
    if (i) await ctx.sleep(1000);
    res = await ctx.localApi('POST', '/api/qr-key');
  }
  if (!res?.ok) {
    ctx.out(res ? `  Pocket Dev refused the request (${res.status}).` : '  Pocket Dev is not running yet, so there is no address.');
    ctx.out('  Start it with: pocket-dev start   It prints the address and a QR code.');
    return false;
  }
  const url = new URL(res.data.url);
  ctx.out(`  On the same Wi-Fi: ${url.origin}`);
  const remote = await ctx.remoteUrl().catch(() => null);
  if (remote) ctx.out(`  From anywhere: ${remote}   (a QR code for this address: pocket-dev qr --link ${remote})`);
  if (!ctx.isTTY) { ctx.out('  For a login QR code, run in a terminal: pocket-dev qr'); return true; }
  ctx.out('');
  ctx.out(await ctx.qr(res.data.url));
  ctx.out(`  Scan this with your phone's camera to log in without the password. It works once and expires in ${res.data.expiresInMin} minutes (new code: pocket-dev qr).`);
  ctx.out('  Or open the address in your phone\'s browser and type the password. In the browser menu choose Add to Home Screen to keep it like an app.');
  return true;
}

// `pocket-dev start` when a copy already runs (often the background service setup installed).
export async function printAlreadyRunning(ctx) {
  ctx.out('Pocket Dev is already running in the background, so this did not start a second copy.');
  await printPhoneLogin(ctx, { tries: 3 });
  ctx.out('  To restart it: pocket-dev service restart');
}

// `started` is false when nothing was started in this run, so there is no server to wait for.
async function finishStep(ctx, opts, started) {
  ctx.out('Open it on your phone');
  if (opts.dry) { ctx.out('  Would print the addresses and a one-time QR code, valid for a few minutes.'); return; }
  if (await printPhoneLogin(ctx, { tries: started === false ? 1 : READY_TRIES })) ctx.out('  Pocket Dev runs in the background now. You do not need to run pocket-dev start.');
}

// ---- The flow -----------------------------------------------------------------------------------------------------

export function parseArgs(args) {
  const opts = { check: false, yes: false, dry: false, only: null, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') opts.check = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dry = true;
    else if (a === '--only') {
      // autostart is the step's old name.
      const v = args[++i] === 'autostart' ? 'always-on' : args[i];
      if (!STEP_IDS.includes(v)) opts.error = `--only needs one of: ${STEP_IDS.join(', ')}.`;
      else opts.only = v;
    } else opts.error = `Unknown option "${a}". Options: --check, --yes, --dry-run, --only <${STEP_IDS.join('|')}>.`;
  }
  return opts;
}

function checkTable(ctx, states, facts) {
  const rows = states.map((d) => ({ d, ...statusWords(d) }));
  const w = (f) => Math.max(...rows.map((r) => f(r).length));
  const wt = w((r) => r.d.title), wl = w((r) => LEVEL_WORD[r.d.level]), wi = w((r) => r.installed);
  ctx.out(`  ${'Tool'.padEnd(wt)}  ${'Need'.padEnd(wl)}  ${'Installed'.padEnd(wi)}  Logged in`);
  for (const r of rows) {
    const mark = r.d.status === 'ok' ? good(ctx, '✓') : r.d.level === 'required' ? bad(ctx, '✗') : paint(ctx, 33, '✗');
    ctx.out(`${mark} ${r.d.title.padEnd(wt)}  ${LEVEL_WORD[r.d.level].padEnd(wl)}  ${r.installed.padEnd(wi)}  ${r.login}`);
  }
  const todo = states.map((d) => ({ d, fix: fixFor(toolById(d.id), d, { ...facts, npmFound: d.npmFound ?? facts.npmFound }, ctx.platform) })).filter((x) => x.fix);
  if (todo.length) {
    ctx.out('');
    ctx.out('To fix:');
    for (const { d, fix } of todo) {
      ctx.out(`  ${d.title}: ${fix.command ? `run  ${fix.command}` : fix.note}${fix.command && fix.kind === 'manual' ? `   (${fix.note})` : ''}`);
      if (fix.link) ctx.out(`    ${fix.link}`);
    }
    ctx.out('Or run the guided setup in a terminal: pocket-dev setup');
  }
  const chat = states.filter((d) => (d.id === 'claude' || d.id === 'codex') && d.status === 'ok');
  if (!chat.length) ctx.out('\nNote: neither Claude Code nor Codex is ready. Chats need at least one of them.');
}

// Returns the process exit code. `fromStart`: the first `pocket-dev start` runs it, and prints the address and QR itself.
export async function runSetup(args, ctx, { fromStart = false } = {}) {
  const opts = parseArgs(args);
  if (opts.error) { ctx.out(opts.error); return 2; }
  ctx.log ??= () => {};
  const ids = opts.only ? [opts.only] : STEP_IDS.filter((id) => !(fromStart && id === 'finish'));
  const toolIds = ids.filter((id) => toolById(id));
  const facts = await gatherFacts(ctx);
  const check = opts.check || (!ctx.isTTY && !opts.dry);

  ctx.out(`Pocket Dev setup (${NAMES[ctx.platform] ?? ctx.platform})${check ? ': status only' : opts.dry ? ': dry run, nothing will be installed, changed or logged in' : ''}`);
  if (!ctx.isTTY && !opts.check && !opts.dry) ctx.out('This is not an interactive terminal, so setup only checks and prints what to run. Run pocket-dev setup in a terminal to do the steps.');
  ctx.out('');

  if (check) {
    const states = await detectAll(ctx, toolIds);
    checkTable(ctx, states, { ...facts, npmFound: facts.npm !== null });
    if (ctx.terminals && (!opts.only || opts.only === 'terminals')) {
      const t = await ctx.terminals.check();
      ctx.out('');
      ctx.out(t.available ? '✓ Terminals (node-pty): works' : `✗ Terminals (node-pty): ${t.reason}. Fix: pocket-dev doctor --fix`);
    }
    const required = states.filter((d) => d.level === 'required');
    const ok = required.every((d) => d.status === 'ok');
    ctx.out('');
    ctx.out(ok ? 'Everything required is OK.' : 'Something required is missing. See "To fix" above.');
    return ok ? 0 : 1;
  }

  let cloudflaredReady = null;
  let nodeOk = true;
  let started, installedSome = false;
  for (const [index, id] of ids.entries()) {
    if (index > 0) ctx.out('');
    const tool = toolById(id);
    if (tool) {
      const d = await toolStep(ctx, opts, tool, { ...facts, npmFound: facts.npm !== null });
      if (id === 'node') nodeOk = d.status === 'ok';
      if (d.justInstalled) installedSome = true;
      if (id === 'cloudflared') cloudflaredReady = d.installed;
    } else if (id === 'terminals') await terminalsStep(ctx, opts);
    else if (id === 'password') await passwordStep(ctx, opts);
    else if (id === 'network') {
      cloudflaredReady ??= !!ctx.find(toolById('cloudflared'));
      await networkStep(ctx, opts, cloudflaredReady);
    } else if (id === 'always-on') started = await alwaysOnStep(ctx, opts);
    else if (id === 'finish') await finishStep(ctx, opts, started);
  }
  ctx.out('');
  if (!opts.only && !opts.dry) ctx.setupDone.mark();
  if (installedSome) ctx.out(`If Pocket Dev was already running: ${RESTART_NOTE}`);
  ctx.out(opts.dry ? 'Dry run finished. Nothing was changed.' : nodeOk ? 'Setup finished. Run pocket-dev setup --check any time to see the status.' : 'Setup stopped short: Node.js is not ready. Fix it and run pocket-dev setup again.');
  return nodeOk ? 0 : 1;
}

// ---- Real context for the command line and the server --------------------------------------------------------------

function secretPrompt(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (fn, arg) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(arg); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(resolve, value);
        if (ch === '\x03') return finish(reject, Object.assign(new Error('Stopped'), { code: 'SIGINT' }));
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function askPrompt(question, def) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return def;
    return answer.startsWith('y');
  } finally { rl.close(); }
}

// The read-only look at config.json: setup must not create the file just to check a setting.
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(process.env.POCKET_DEV_CONFIG || path.join(STATE_DIR, 'config.json'), 'utf8')); } catch { return {}; }
}

export async function createRealContext(extra = {}) {
  const ctx = createContext(extra);
  const { platform: host } = await import('./platform.js');
  const { terminalQr } = await import('./qr.js');
  ctx.log = makeLogger();
  ctx.ask = askPrompt;
  ctx.secret = secretPrompt;
  ctx.readConfig = readConfigFile;
  ctx.setupDone = {
    read: () => fs.existsSync(SETUP_DONE),
    mark: () => {
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(SETUP_DONE, new Date().toISOString() + '\n');
    },
  };
  const store = async () => {
    const { openConfig } = await import('./config.js');
    const { resolveConfigPath } = await import('./paths.js');
    return openConfig(resolveConfigPath());
  };
  ctx.writePassword = async (password) => {
    const { hashPassword } = await import('./auth.js');
    (await store()).update({ passwordHash: hashPassword(password), password: undefined });
  };
  ctx.saveNetwork = async (network) => (await store()).update({ network });
  // A running server applies the mode at once and saves it; otherwise the next start reads it from config.json.
  ctx.saveAwake = async (awake) => {
    const live = await ctx.localApi('PUT', '/api/local/power', { awake });
    if (!live?.ok) (await store()).update({ awake });
  };
  ctx.hasBattery = async () => (await host.battery()).battery !== null;
  ctx.keepAwake = host.capabilities().keepAwake;
  ctx.qr = terminalQr;
  if (!extra.noTerminals) {
    const doctor = await import('./doctor.js');
    const defaults = await doctor.doctorDefaults();
    doctor.withDoctorDefaults(ctx, defaults);
    ctx.terminals = { check: () => ctx.probeTerminals(), repair: (opts) => doctor.repairTerminals(ctx, opts) };
  }
  ctx.localApi = async (method, endpoint, body) => (await import('./scripts/local-api.js')).localRequest(method, endpoint, body);
  ctx.remoteUrl = async () => {
    const { url } = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'admin.json'), 'utf8'));
    const state = await (await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) })).json();
    return state.network?.tunnel?.url ?? null;
  };
  const caps = host.capabilities().service;
  const port = Number(readConfigFile().port) || 7777;
  ctx.service = {
    available: caps.available, reason: caps.reason ?? 'Starting at login is not supported here.',
    kind: ctx.platform === 'darwin' ? 'launchd' : ctx.platform === 'win32' ? 'schtasks' : 'systemd',
    status: () => host.serviceStatus(),
    install: () => host.installService({ port }),
    describe() {
      if (ctx.platform === 'darwin') return ['Will run: pocket-dev service install   (writes ~/Library/LaunchAgents/dev.pocket.server.plist and loads it)'];
      const plan = host.servicePlan({ port });
      return [`Will write: ${plan.files.map((f) => f.path).join(', ')}`, ...plan.commands.install.map(([c, a]) => `Will run: ${[c, ...a].join(' ')}`)];
    },
  };
  return ctx;
}
