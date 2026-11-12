import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOOLS, parseLogin, parseVersion, detectTool, installPlan, runSetup, createContext, assertNoSecret, makeLogger, collectStatus, cachedStatus, parseArgs, defaultFind, printPhoneLogin, printAlreadyRunning,
} from '../setup.js';
import { findCloudflared } from '../network.js';

const tool = (id) => TOOLS.find((t) => t.id === id);
const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...o });

// A fake computer: `installed` maps a tool name to { version, login }, `pms` lists package managers present.
function fakeCtx({ platform = 'darwin', installed = {}, pms = [], tty = true, answers = [], secrets = [], npmWritable = true, node = '22.17.1', config = {} } = {}) {
  const calls = [], out = [], asked = [], writes = [];
  const binPath = (name) => `/fake/bin/${name}`;
  const known = { npm: { version: '10.9.2' }, ...installed };
  const ctx = {
    platform, env: {}, nodeVersion: node, isTTY: tty, color: false, childEnv: {}, writable: () => npmWritable,
    out: (l = '') => out.push(l),
    log: (l) => writes.push(['log', l]),
    find: (t) => (known[t.bin] || pms.includes(t.bin) ? binPath(t.bin) : null),
    run: async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, inherit: !!opts.inherit });
      const name = path.basename(cmd);
      if (name === 'npm' && args[0] === '--version') return res({ stdout: '10.9.2\n' });
      if (name === 'npm' && args[0] === 'prefix') return res({ stdout: '/usr/local\n' });
      if (args[0] === '--version') return res({ stdout: `${name} version ${known[name]?.version ?? '1.0.0'}\n` });
      if (opts.inherit) {
        // a login or install hands over the terminal; afterwards the tool is installed and logged in
        if (args[0] === 'install' || cmd === 'brew' || cmd === 'winget') known[args.at(-1).replace('@anthropic-ai/claude-code', 'claude').replace('@openai/codex', 'codex')] = { version: '9.9.9', login: false };
        else if (known[name]) known[name].login = true;
        return res();
      }
      const login = known[name]?.login;
      if (name === 'claude') return res({ code: login ? 0 : 1, stdout: JSON.stringify({ loggedIn: !!login, email: 'someone@example.com' }) });
      if (name === 'codex') return res({ code: login ? 0 : 1, stdout: login ? 'Logged in using ChatGPT\n' : '', stderr: login ? '' : 'Not logged in\n' });
      if (name === 'gh') return res({ code: login ? 0 : 1, stderr: login ? 'Logged in to github.com\n' : 'You are not logged into any GitHub hosts.\n' });
      return res();
    },
    ask: async (q, def) => { asked.push(q); return answers.length ? answers.shift() : def; },
    secret: async (q) => { asked.push(q); return secrets.shift(); },
    readConfig: () => config,
    writePassword: async (p) => writes.push(['password', p]),
    saveNetwork: async (n) => writes.push(['network', n]),
    localApi: async () => null,
    sleep: async () => {},
    remoteUrl: async () => null,
    qr: async () => '[qr]',
    service: { available: true, kind: 'launchd', status: async () => ({}), describe: () => ['Will run: pocket-dev service install'], install: async () => { writes.push(['service']); return 'ok'; } },
  };
  return { ctx, calls, out, asked, writes, known };
}
const text = (f) => f.out.join('\n');

test('version parsing finds the number in each tool\'s own words', () => {
  assert.equal(parseVersion('2.1.319 (Claude Code)'), '2.1.319');
  assert.equal(parseVersion('codex-cli 0.39.0'), '0.39.0');
  assert.equal(parseVersion('gh version 2.83.0 (2025-11-04)'), '2.83.0');
  assert.equal(parseVersion('cloudflared version 2026.10.7 (built 2026-10-30)'), '2026.10.7');
  assert.equal(parseVersion('nothing'), null);
});

test('login parsing: logged in, logged out, and could not tell', () => {
  assert.equal(parseLogin('claude', res({ stdout: '{"loggedIn": true, "email": "a@b.c"}' })), true);
  assert.equal(parseLogin('claude', res({ code: 1, stdout: '{"loggedIn": false}' })), false);
  assert.equal(parseLogin('claude', res({ code: 1, stdout: 'Not logged in' })), false);
  assert.equal(parseLogin('codex', res({ stdout: 'Logged in using ChatGPT\n' })), true);
  assert.equal(parseLogin('codex', res({ code: 1, stderr: 'Not logged in\n' })), false);
  assert.equal(parseLogin('codex', res({ code: 0, stdout: 'Not logged in' })), false);
  assert.equal(parseLogin('gh', res({ code: 0, stderr: 'Logged in to github.com' })), true);
  assert.equal(parseLogin('gh', res({ code: 1, stderr: 'not logged into any GitHub hosts' })), false);
  assert.equal(parseLogin('gh', res({ code: null, timedOut: true })), null);
  assert.equal(parseLogin('claude', res({ code: null, error: new Error('spawn') })), null);
});

test('detection: installed and logged in, logged out, not installed, timeout', async () => {
  const a = fakeCtx({ installed: { claude: { version: '2.1.319', login: true }, codex: { version: '0.39.0', login: false } } });
  const claude = await detectTool(tool('claude'), a.ctx);
  assert.deepEqual([claude.installed, claude.version, claude.loggedIn, claude.status], [true, '2.1.319', true, 'ok']);
  const codex = await detectTool(tool('codex'), a.ctx);
  assert.deepEqual([codex.installed, codex.loggedIn, codex.status], [true, false, 'logged-out']);
  const gh = await detectTool(tool('gh'), a.ctx);
  assert.deepEqual([gh.installed, gh.loggedIn, gh.status], [false, null, 'missing']);

  const slow = fakeCtx({ installed: { claude: { version: '2.1.319' } } });
  const run = slow.ctx.run;
  slow.ctx.run = async (cmd, args, o) => (args[0] === 'auth' ? res({ code: null, timedOut: true }) : run(cmd, args, o));
  const timed = await detectTool(tool('claude'), slow.ctx);
  assert.deepEqual([timed.installed, timed.loggedIn, timed.status], [true, null, 'unknown']);
  assert.ok(slow.calls.every((c) => !c.inherit));
});

test('detection: Node older than 22, and a Mac whose git is only the Apple stub', async () => {
  const old = await detectTool(tool('node'), fakeCtx({ node: '20.11.0' }).ctx);
  assert.equal(old.status, 'outdated');
  const mac = fakeCtx({ installed: { git: { version: '2.0.0' } } });
  const base = mac.ctx.run;
  mac.ctx.find = (t) => (t.bin === 'git' ? '/usr/bin/git' : null);
  mac.ctx.run = async (cmd, args, o) => (cmd.endsWith('xcode-select') ? res({ code: 2 }) : base(cmd, args, o));
  assert.equal((await detectTool(tool('git'), mac.ctx)).installed, false);
  assert.ok(!mac.calls.some((c) => c.cmd === '/usr/bin/git'), 'must not run the stub, it opens an installer window');
});

test('lookup honours the same environment overrides as the app', () => {
  const exists = (p) => p === '/custom/claude';
  assert.equal(defaultFind(tool('claude'), { env: { POCKET_DEV_CLAUDE: '/custom/claude' }, exists }), '/custom/claude');
  assert.equal(defaultFind(tool('claude'), { env: { POCKET_DEV_CLAUDE: '/missing/claude' }, exists }), null);
  const win = (p) => p === 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd';
  assert.equal(defaultFind(tool('claude'), { platform: 'win32', env: { PATH: 'C:\\x', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, exists: win }), 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd');
});

test('POCKET_DEV_CLOUDFLARED is strict like the other two: a missing file means not installed', () => {
  assert.equal(defaultFind(tool('cloudflared'), { env: { POCKET_DEV_CLOUDFLARED: '/missing/cloudflared' }, exists: () => false }), null);
  assert.equal(defaultFind(tool('cloudflared'), { env: { POCKET_DEV_CLOUDFLARED: '/custom/cloudflared' }, exists: (p) => p === '/custom/cloudflared' }), '/custom/cloudflared');
  const saved = process.env.POCKET_DEV_CLOUDFLARED;
  process.env.POCKET_DEV_CLOUDFLARED = path.join(os.tmpdir(), 'no-such-cloudflared');
  try { assert.equal(findCloudflared(), null, 'the app does not fall back to PATH either'); } finally {
    if (saved === undefined) delete process.env.POCKET_DEV_CLOUDFLARED; else process.env.POCKET_DEV_CLOUDFLARED = saved;
  }
});

test('install plans per system use only the official packages', () => {
  const mac = (id, has = { brew: true }) => installPlan(id, { platform: 'darwin', has });
  assert.equal(mac('git').display, 'brew install git');
  assert.equal(mac('gh').display, 'brew install gh');
  assert.equal(mac('cloudflared').display, 'brew install cloudflared');
  assert.equal(mac('claude').display, 'npm install -g @anthropic-ai/claude-code');
  assert.equal(mac('codex').display, 'npm install -g @openai/codex');
  const win = (id) => installPlan(id, { platform: 'win32', has: { winget: true } });
  assert.equal(win('git').display, 'winget install --id Git.Git -e');
  assert.equal(win('gh').display, 'winget install --id GitHub.cli -e');
  assert.equal(win('cloudflared').display, 'winget install Cloudflare.cloudflared');
  assert.equal(win('claude').display, 'npm install -g @anthropic-ai/claude-code');
  const lin = (id, has) => installPlan(id, { platform: 'linux', has });
  assert.equal(lin('cloudflared', { brew: true }).display, 'brew install cloudflared');
  assert.equal(lin('claude', {}).display, 'npm install -g @anthropic-ai/claude-code');
  for (const id of ['git', 'claude', 'codex', 'gh', 'cloudflared']) for (const platform of ['darwin', 'win32', 'linux']) {
    const p = installPlan(id, { platform, has: { brew: true, winget: true } });
    assert.ok(!/curl|iex|irm|\| ?sh|Invoke-/i.test(JSON.stringify(p)), `${id} ${platform}`);
  }
});

test('missing package manager and administrator rights are refused with manual steps', () => {
  const noBrew = installPlan('git', { platform: 'darwin', has: {} });
  assert.equal(noBrew.action, 'manual');
  assert.match(noBrew.steps.join('\n'), /xcode-select --install/);
  const noBrewGh = installPlan('gh', { platform: 'darwin', has: {} });
  assert.equal(noBrewGh.action, 'manual');
  assert.match(noBrewGh.steps.join('\n'), /brew\.sh/);
  const noWinget = installPlan('cloudflared', { platform: 'win32', has: {} });
  assert.equal(noWinget.action, 'manual');
  assert.match(noWinget.steps.join('\n'), /aka\.ms\/getwinget/);
  const apt = installPlan('git', { platform: 'linux', has: { 'apt-get': true } });
  assert.equal(apt.action, 'manual');
  assert.match(apt.steps[0], /sudo apt install git/);
  assert.equal(installPlan('cloudflared', { platform: 'linux', has: {} }).action, 'manual');
  const sudoNpm = installPlan('claude', { platform: 'linux', has: {}, npmWritable: false });
  assert.equal(sudoNpm.action, 'manual');
  assert.match(sudoNpm.steps[0], /sudo npm install -g @anthropic-ai\/claude-code/);
  assert.equal(installPlan('codex', { platform: 'darwin', has: {}, npmFound: false }).action, 'manual');
  assert.equal(installPlan('node', { platform: 'win32' }).action, 'manual');
});

test('setup installs after yes, streams the command, logs in, and re-checks', async () => {
  const f = fakeCtx({ installed: { git: { version: '2.52.0' } }, pms: ['brew'], answers: [true, true] });
  const code = await runSetup(['--only', 'claude'], f.ctx);
  assert.equal(code, 0);
  const inherited = f.calls.filter((c) => c.inherit);
  assert.deepEqual(inherited.map((c) => [c.cmd, ...c.args].join(' ')), ['npm install -g @anthropic-ai/claude-code', '/fake/bin/claude auth login']);
  assert.match(text(f), /Will run: npm install -g @anthropic-ai\/claude-code/);
  assert.match(text(f), /Source: npm package @anthropic-ai\/claude-code/);
  assert.match(f.asked[0], /Install now\? \[Y\/n\]/);
  assert.match(text(f), /✓ Claude Code: installed 9\.9\.9, logged in/);
});

test('saying no installs nothing', async () => {
  const f = fakeCtx({ pms: ['brew'], answers: [false] });
  await runSetup(['--only', 'gh'], f.ctx);
  assert.equal(f.calls.filter((c) => c.inherit).length, 0);
  assert.match(text(f), /Skipped/);
});

test('a manual plan runs nothing and setup carries on to the next step', async () => {
  const f = fakeCtx({ platform: 'linux', pms: ['apt-get'], answers: [] });
  const code = await runSetup(['--only', 'git'], f.ctx);
  assert.equal(code, 0);
  assert.equal(f.calls.filter((c) => c.inherit).length, 0);
  assert.equal(f.asked.length, 0);
  assert.match(text(f), /Run yourself: sudo apt install git/);
  assert.match(text(f), /Continuing with the next step/);
});

test('--dry-run runs only read-only checks, asks nothing and writes nothing', async () => {
  const f = fakeCtx({ pms: ['brew'], tty: true });
  const code = await runSetup(['--dry-run'], f.ctx);
  assert.equal(code, 0);
  assert.equal(f.calls.filter((c) => c.inherit).length, 0);
  assert.ok(f.calls.every((c) => /--version$|status$|^prefix$/.test(c.args.join(' ')) || c.args[0] === 'prefix'), JSON.stringify(f.calls.map((c) => c.args)));
  assert.equal(f.asked.length, 0);
  assert.deepEqual(f.writes, []);
  assert.match(text(f), /Will run: npm install -g @anthropic-ai\/claude-code/);
  assert.match(text(f), /Will run: brew install gh/);
  assert.match(text(f), /dry run: not asked, not run/);
  assert.match(text(f), /Dry run finished\. Nothing was changed\./);
});

test('without a terminal setup only checks, prints what to run, and exits by the required tools', async () => {
  const f = fakeCtx({ tty: false, pms: ['brew'] });
  const code = await runSetup([], f.ctx);
  assert.equal(code, 0);
  assert.equal(f.asked.length, 0);
  assert.equal(f.calls.filter((c) => c.inherit).length, 0);
  assert.match(text(f), /not an interactive terminal/);
  assert.match(text(f), /Claude Code: run  npm install -g @anthropic-ai\/claude-code/);
  assert.match(text(f), /Everything required is OK/);
  const old = fakeCtx({ tty: false, node: '18.0.0' });
  assert.equal(await runSetup(['--check'], old.ctx), 1);
});

test('--check shows logged-out tools with the login command and exits 0 when required is fine', async () => {
  const f = fakeCtx({ installed: { claude: { version: '2.1.319', login: false }, codex: { version: '0.39.0', login: true } } });
  assert.equal(await runSetup(['--check'], f.ctx), 0);
  assert.match(text(f), /Claude Code: run  claude auth login/);
  assert.match(text(f), /Codex +optional +installed 0\.39\.0 +logged in/);
});

test('password: mismatches are retried, a short one is refused, and only the hash path is used', async () => {
  const f = fakeCtx({ secrets: ['abc', 'longenough1', 'different', 'longenough2', 'longenough2'] });
  await runSetup(['--only', 'password'], f.ctx);
  assert.deepEqual(f.writes.filter((w) => w[0] === 'password'), [['password', 'longenough2']]);
  assert.match(text(f), /needs 6 to 200 characters/);
  assert.match(text(f), /did not match/);
  const kept = fakeCtx({ config: { passwordHash: { algo: 'scrypt' } }, answers: [false] });
  await runSetup(['--only', 'password'], kept.ctx);
  assert.deepEqual(kept.writes, []);
});

test('--yes never invents a password and keeps the network setting', async () => {
  const f = fakeCtx();
  await runSetup(['--yes', '--only', 'password'], f.ctx);
  await runSetup(['--yes', '--only', 'network'], f.ctx);
  assert.deepEqual(f.writes, []);
  assert.equal(f.asked.length, 0);
});

test('network: the internet link needs cloudflared', async () => {
  const without = fakeCtx({ answers: [true] });
  await runSetup(['--only', 'network'], without.ctx);
  assert.deepEqual(without.writes, []);
  assert.match(text(without), /needs cloudflared/);
  const withIt = fakeCtx({ installed: { cloudflared: { version: '2026.10.7' } }, answers: [true] });
  await runSetup(['--only', 'network'], withIt.ctx);
  assert.deepEqual(withIt.writes.filter((w) => w[0] === 'network'), [['network', { wifi: true, internet: { kind: 'quick', hostname: null } }]]);
});

test('start at login: skipped when already set up, installed on yes, manual when unsupported', async () => {
  const done = fakeCtx();
  done.ctx.service.status = async () => ({ installed: true, autostart: true, running: true });
  await runSetup(['--only', 'autostart'], done.ctx);
  assert.match(text(done), /Already set up/);
  assert.deepEqual(done.writes, []);
  const fresh = fakeCtx({ answers: [true] });
  await runSetup(['--only', 'autostart'], fresh.ctx);
  assert.deepEqual(fresh.writes, [['service'], ['log', 'service installed (launchd)']]);
  const none = fakeCtx({ platform: 'linux' });
  none.ctx.service = { available: false, reason: 'systemctl was not found.' };
  await runSetup(['--only', 'autostart'], none.ctx);
  assert.match(text(none), /pocket-dev start/);
});

test('finish prints the address and QR when running, and how to start when not', async () => {
  const up = fakeCtx();
  up.ctx.localApi = async () => ({ ok: true, status: 200, data: { url: 'http://192.168.1.5:7777/?k=abc', expiresInMin: 10 } });
  await runSetup(['--only', 'finish'], up.ctx);
  assert.match(text(up), /On the same Wi-Fi: http:\/\/192\.168\.1\.5:7777$/m);
  assert.match(text(up), /\[qr\]/);
  assert.ok(!up.writes.some((w) => String(w[1]).includes('k=abc')), 'the login key never reaches the log');
  const down = fakeCtx();
  await runSetup(['--only', 'finish'], down.ctx);
  assert.match(text(down), /not running/);
});

test('finish waits for a server that is still starting, then always prints the address and the QR', async () => {
  const f = fakeCtx();
  let tries = 0;
  f.ctx.localApi = async () => (++tries < 3 ? null : { ok: true, status: 200, data: { url: 'http://192.168.1.5:7777/?k=abc', expiresInMin: 10 } });
  f.ctx.remoteUrl = async () => 'https://calm-river.trycloudflare.com';
  await runSetup(['--only', 'finish'], f.ctx);
  assert.equal(tries, 3);
  assert.match(text(f), /On the same Wi-Fi: http:\/\/192\.168\.1\.5:7777$/m);
  assert.match(text(f), /From anywhere: https:\/\/calm-river\.trycloudflare\.com/);
  assert.match(text(f), /pocket-dev qr --link https:\/\/calm-river\.trycloudflare\.com/);
  assert.match(text(f), /\[qr\]/);
  assert.match(text(f), /You do not need to run pocket-dev start/);
});

test('without a terminal the finish prints the address and the command, no QR art', async () => {
  const f = fakeCtx();
  f.ctx.isTTY = false;
  f.ctx.localApi = async () => ({ ok: true, status: 200, data: { url: 'http://192.168.1.5:7777/?k=abc', expiresInMin: 10 } });
  await printPhoneLogin(f.ctx);
  assert.match(text(f), /On the same Wi-Fi: http:\/\/192\.168\.1\.5:7777$/m);
  assert.match(text(f), /pocket-dev qr/);
  assert.doesNotMatch(text(f), /\[qr\]|k=abc/);
});

test('start with a copy already running says so and prints the address and a fresh QR', async () => {
  const f = fakeCtx();
  f.ctx.localApi = async (method, endpoint) => (method === 'POST' && endpoint === '/api/qr-key' ? { ok: true, status: 200, data: { url: 'http://192.168.1.5:7777/?k=new', expiresInMin: 5 } } : null);
  await printAlreadyRunning(f.ctx);
  assert.match(text(f), /^Pocket Dev is already running in the background/m);
  assert.match(text(f), /On the same Wi-Fi: http:\/\/192\.168\.1\.5:7777$/m);
  assert.match(text(f), /\[qr\]/);
});

test('no command line, log line or output carries a secret', async () => {
  const secret = 'S3cret-Pass-Phrase-99';
  const f = fakeCtx({ pms: ['brew'], secrets: [secret, secret], answers: [true, true, true, true] });
  f.ctx.localApi = async () => ({ ok: true, status: 200, data: { url: 'http://h:1/?k=ONETIMEKEY', expiresInMin: 10 } });
  await runSetup([], f.ctx);
  const everything = JSON.stringify([f.calls, f.writes.filter((w) => w[0] === 'log')]);
  assert.ok(!everything.includes(secret));
  assert.ok(!everything.includes('ONETIMEKEY'));
  assert.ok(!everything.includes('someone@example.com'));
  assert.throws(() => assertNoSecret(['codex', 'login', '--api-key', 'x']), /secret/);
  assert.throws(() => assertNoSecret(['gh', 'auth', 'login', '--with-token']), /secret/) ;
  assert.throws(() => assertNoSecret(['x', 'ghp_abcdef']), /secret/);
  assert.doesNotThrow(() => assertNoSecret(['npm', 'install', '-g', '@anthropic-ai/claude-code']));
});

test('the log file keeps command lines only, private to the owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-log-'));
  const file = path.join(dir, 'state', 'setup.log');
  makeLogger(file, () => '2026-01-01T00:00:00Z')('ran: brew install gh -> exit 0');
  makeLogger(file, () => '2026-01-01T00:00:01Z')('ran: gh auth login -> exit 0');
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-01-01T00:00:00Z ran: brew install gh -> exit 0\n2026-01-01T00:00:01Z ran: gh auth login -> exit 0\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});

test('option parsing', () => {
  assert.deepEqual(parseArgs(['--check']), { check: true, yes: false, dry: false, only: null, error: null });
  assert.equal(parseArgs(['--only', 'codex']).only, 'codex');
  assert.match(parseArgs(['--only', 'nope']).error, /--only needs one of/);
  assert.match(parseArgs(['--bogus']).error, /Unknown option/);
});

test('status for the phone has no paths, accounts or output', async () => {
  const f = fakeCtx({ installed: { claude: { version: '2.1.319', login: false }, git: { version: '2.52.0' } }, pms: ['brew'] });
  const status = await collectStatus(f.ctx);
  const claude = status.tools.find((t) => t.id === 'claude');
  assert.equal(claude.status, 'logged-out');
  assert.equal(claude.fix.command, 'claude auth login');
  assert.equal(status.tools.find((t) => t.id === 'gh').fix.command, 'brew install gh');
  assert.equal(status.tools.find((t) => t.id === 'git').fix, undefined);
  const json = JSON.stringify(status);
  assert.ok(!json.includes('/fake/bin') && !json.includes('someone@example.com'));
  let t = 0;
  const cached = cachedStatus(f.ctx, 1000, () => t);
  const first = await cached();
  const n = f.calls.length;
  t = 500;
  assert.equal(await cached(), first);
  assert.equal(f.calls.length, n);
  t = 2000;
  await cached();
  assert.ok(f.calls.length > n);
});

test('createContext honours NO_COLOR', () => {
  assert.equal(createContext({ env: { NO_COLOR: '1' } }).color, false);
});
