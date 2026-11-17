import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runSetup } from '../setup.js';
import { createUpdater } from '../update.js';
import { firstRun } from '../startup.js';

// Setup and the first-run guide begin with a "Latest version" step. A fake computer and a fake updater: no npm, no network.
const tool = () => null;
const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...o });

// A fake computer: `installed` maps a tool name to { version, login }, `pms` lists package managers present.
function fakeCtx({ platform = 'darwin', installed = {}, pms = [], tty = true, answers = [], secrets = [], npmWritable = true, node = '22.17.1', config = {}, battery = false } = {}) {
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
    saveAwake: async (m) => { writes.push(['awake', m]); config.awake = m; },
    hasBattery: async () => battery,
    username: 'ani', now: () => new Date(2026, 10, 12, 20, 0), columns: 100,
    setupDone: { read: () => false, mark: () => writes.push(['setup-done']) },
    keepAwake: { available: true },
    localApi: async () => null,
    sleep: async () => {},
    remoteUrl: async () => null,
    qr: async () => '[qr]',
    service: { available: true, kind: 'launchd', status: async () => ({}), describe: () => ['Will run: pocket-dev service install'], install: async () => { writes.push(['service']); return 'ok'; } },
  };
  return { ctx, calls, out, asked, writes, known };
}
const text = (f) => f.out.join('\n');

// An updater whose every outside action is recorded.
function fakeUpdate({ latest = '1.3.0', version = '1.2.0', skip = false, npmCode = 0, error = null } = {}) {
  const calls = { npm: 0, reexec: 0 };
  const real = createUpdater({
    version, root: '/g/node_modules/@anisirji/pocket-dev', env: skip ? { POCKET_DEV_NO_UPDATE_CHECK: '1' } : {},
    realpath: (p) => p, globalRoot: async () => '/g/node_modules',
    fetchLatest: async () => { if (error) throw new Error(error); return latest; },
    run: async () => { calls.npm++; return { code: npmCode, stdout: '', stderr: '' }; },
    readVersion: () => latest, hasService: async () => false,
    reexec: async () => { calls.reexec++; return 7; },
  });
  return { update: real, calls };
}

test('setup --yes updates first and runs itself again from the new version, so no later step runs here', async () => {
  const f = fakeCtx();
  const u = fakeUpdate();
  f.ctx.update = u.update;
  const code = await runSetup(['--yes'], f.ctx);
  assert.equal(code, 7);
  assert.deepEqual(u.calls, { npm: 1, reexec: 1 });
  assert.match(text(f), /Latest version\n.*Version 1\.3\.0 is available, you have 1\.2\.0\./s);
  assert.equal(f.calls.filter((c) => c.inherit).length, 0, 'nothing else was installed or logged in');
  assert.ok(!f.writes.some((w) => w[0] === 'setup-done'), 'setup is not marked done by the old copy');
  assert.ok(!/Setup finished/.test(text(f)));
});

test('setup asks "Update now? [Y/n]" and Enter means yes', async () => {
  const f = fakeCtx();
  f.ctx.update = fakeUpdate().update;
  assert.equal(await runSetup([], f.ctx), 7);
  assert.equal(f.asked[0], 'Update now? [Y/n] ');
});

test('a dry run shows the update and carries on with the rest of setup', async () => {
  const f = fakeCtx({ answers: [false], installed: { claude: { version: '2.1.0', login: true }, codex: { version: '0.50.0', login: true }, gh: { version: '2.8.0', login: true }, git: { version: '2.4.0' }, cloudflared: { version: '2026.1.1' } } });
  const u = fakeUpdate();
  f.ctx.update = u.update;
  f.ctx.readConfig = () => ({ passwordHash: 'x', network: { wifi: true } });
  const code = await runSetup(['--dry-run'], f.ctx);
  assert.equal(code, 0);
  assert.equal(u.calls.npm, 0);
  assert.match(text(f), /Version 1\.3\.0 is available/);
  assert.match(text(f), /Dry run: would run npm install -g @anisirji\/pocket-dev@latest/);
  assert.match(text(f), /Dry run finished\. Nothing was changed\./);
  assert.ok(text(f).indexOf('Latest version') < text(f).indexOf('Dry run finished'));
});

test('setup --check and a terminal-less run print the command and carry on', async () => {
  for (const args of [['--check'], []]) {
    const f = fakeCtx({ tty: args.length === 0 ? false : true });
    const u = fakeUpdate();
    f.ctx.update = u.update;
    await runSetup(args, f.ctx);
    assert.deepEqual(u.calls, { npm: 0, reexec: 0 });
    assert.match(text(f), /Latest version\n.*Version 1\.3\.0 is available, you have 1\.2\.0\.\n.*Update with: pocket-dev update/s);
    assert.match(text(f), /Everything required is OK|Something required is missing/);
  }
});

test('--only <step> skips the version step', async () => {
  const f = fakeCtx();
  const u = fakeUpdate();
  f.ctx.update = u.update;
  await runSetup(['--only', 'terminals', '--dry-run'], f.ctx).catch(() => {});
  assert.ok(!/Latest version/.test(text(f)));
  assert.deepEqual(u.calls, { npm: 0, reexec: 0 });
});

test('the opt-out turns the version step off in setup too', async () => {
  const f = fakeCtx();
  f.ctx.update = fakeUpdate({ skip: true }).update;
  await runSetup(['--check'], f.ctx);
  assert.ok(!/Latest version/.test(text(f)));
});

test('an offline lookup is one quiet line and setup goes on', async () => {
  const f = fakeCtx();
  f.ctx.update = fakeUpdate({ error: 'the npm registry did not answer' }).update;
  await runSetup(['--check'], f.ctx);
  assert.match(text(f), /Could not check for a newer version \(the npm registry did not answer\)\. Carrying on with 1\.2\.0\./);
});

test('the first-run guide starts with the same step and hands the first start to the new version', async () => {
  const f = fakeCtx();
  f.ctx.update = fakeUpdate().update;
  f.ctx.env = {};
  assert.equal(await firstRun({ ctx: f.ctx, runSetup: (a, c, o) => runSetup(a, c, o) }), 'ran');
  assert.match(text(f), /Version 1\.3\.0 is available/);
});
