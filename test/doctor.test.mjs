import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../setup.js';
import { collectDoctor, printDoctor, detectInstall, repairPlan, repairTerminals, doctorCommand, probeTerminals } from '../doctor.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINUX_ROOT = '/usr/local/lib/node_modules/@anisirji/pocket-dev';

// A computer made of data: which programs exist, what npm answers, whether terminals work.
function computer(over = {}) {
  const lines = [];
  const ran = [];
  const state = { terminals: { available: true, detail: 'started /bin/zsh and stopped it' }, files: new Set(), ...over.state };
  const platform = over.platform ?? 'linux';
  const prefix = over.prefix ?? '/usr/local';
  const programs = { npm: '/usr/local/bin/npm', git: '/usr/bin/git', ...over.programs };
  const ctx = createContext({
    platform, env: over.env ?? { PATH: '/usr/local/bin:/usr/bin' }, nodeVersion: over.nodeVersion ?? '22.17.1',
    out: (line = '') => lines.push(line), color: false, isTTY: over.isTTY ?? true,
    find: (tool) => programs[tool.id] ?? null,
    exists: (file) => state.files.has(file),
    run: async (cmd, args, opts = {}) => {
      ran.push({ cmd, args, opts });
      const key = args.join(' ');
      if (key === '--version') return { code: 0, stdout: cmd.endsWith('npm') || cmd.endsWith('npm.cmd') ? '10.9.2\n' : 'git version 2.50.0\n', stderr: '' };
      if (key === 'config get prefix') return { code: 0, stdout: `${prefix}\n`, stderr: '' };
      if (key === 'root -g') return { code: 0, stdout: `${over.globalRoot ?? '/usr/local/lib/node_modules'}\n`, stderr: '' };
      if (args[0] === 'rebuild' || args[0] === 'install') { over.onNpm?.(state, args); return { code: over.npmCode ?? 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  Object.assign(ctx, {
    packageRoot: over.packageRoot ?? LINUX_ROOT, stateDir: '/home/u/.pocket-dev', port: 7777,
    realpath: (p) => p, readFile: over.readFile ?? (() => { throw new Error('ENOENT'); }),
    checkWritable: over.checkWritable ?? (() => null), portFree: async () => over.portFree ?? true,
    probeTerminals: async () => state.terminals, ask: over.ask ?? (async () => true), log: () => {},
  });
  return { ctx, lines, ran, state };
}
const row = (report, id) => report.rows.find((r) => r.id === id);

test('everything fine: all rows pass, exit 0, a clear table', async () => {
  const { ctx, lines } = computer({ state: { files: new Set(['/usr/local/bin/pocket-dev']) } });
  const report = await collectDoctor(ctx);
  assert.equal(report.ok, true);
  // Claude Code, Codex, GitHub CLI and cloudflared are optional and not on this made-up computer.
  assert.ok(report.rows.filter((r) => r.level !== 'optional').every((r) => r.ok), JSON.stringify(report.rows.filter((r) => !r.ok)));
  printDoctor(ctx, report);
  const out = lines.join('\n');
  assert.match(out, /✓ Node\.js and npm\s+required\s+Node 22\.17\.1, npm 10\.9\.2/);
  assert.match(out, /✓ Terminals \(node-pty\)\s+required/);
  assert.match(out, /✓ How it was installed\s+recommended\s+global/);
  assert.match(out, /Everything Pocket Dev requires is working\./);
  assert.doesNotMatch(out, /✗ (Node|How|npm|pocket-dev|Terminals|Git|Settings|Port)\b/);
});

test('node-pty missing: required row fails with the exact next command, exit code 1', async () => {
  const { ctx, lines } = computer({ state: { terminals: { available: false, reason: 'the terminal component (node-pty) is not installed' }, files: new Set(['/usr/local/bin/pocket-dev']) } });
  const code = await doctorCommand([], ctx);
  const out = lines.join('\n');
  assert.equal(code, 1);
  assert.match(out, /✗ Terminals \(node-pty\)\s+required\s+the terminal component \(node-pty\) is not installed/);
  assert.match(out, /Terminals \(node-pty\): run  pocket-dev doctor --fix/);
  assert.match(out, /Something required is not working: Terminals \(node-pty\)/);
});

test('Node older than 22 fails the required Node row', async () => {
  const { ctx } = computer({ nodeVersion: '18.19.0' });
  const report = await collectDoctor(ctx);
  assert.equal(row(report, 'node').ok, false);
  assert.match(row(report, 'node').fix.note, /Node 22 or newer/);
  assert.equal(report.ok, false);
});

test('Windows with npm\'s folder missing from PATH explains prefix and PATH and gives the command', async () => {
  const prefix = 'C:\\Users\\ROHIT\\AppData\\Roaming\\npm';
  const { ctx, lines } = computer({
    platform: 'win32', prefix, globalRoot: `${prefix}\\node_modules`, packageRoot: `${prefix}\\node_modules\\@anisirji\\pocket-dev`,
    env: { Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs\\', PATHEXT: '.EXE;.CMD' },
    programs: { npm: 'C:\\Program Files\\nodejs\\npm.cmd' },
  });
  const report = await collectDoctor(ctx);
  assert.equal(row(report, 'prefix').ok, false);
  assert.match(row(report, 'prefix').detail, /npm config get prefix/);
  assert.match(row(report, 'prefix').fix.command, /SetEnvironmentVariable\('Path'.*;C:\\Users\\ROHIT\\AppData\\Roaming\\npm'/);
  assert.equal(row(report, 'command').ok, false);
  assert.equal(row(report, 'install').ok, true);
  assert.ok(row(report, 'firewall'), 'a Windows firewall hint');
  printDoctor(ctx, report);
  assert.match(lines.join('\n'), /Windows Firewall/);
});

test('PATH check ignores case and a trailing backslash on Windows, and finds pocket-dev.cmd', async () => {
  const prefix = 'C:\\Users\\ROHIT\\AppData\\Roaming\\npm';
  const { ctx } = computer({
    platform: 'win32', prefix, globalRoot: `${prefix}\\node_modules`, packageRoot: `${prefix}\\node_modules\\@anisirji\\pocket-dev`,
    env: { Path: 'c:\\users\\rohit\\appdata\\roaming\\npm\;C:\\Windows', PATHEXT: '.EXE;.CMD' },
    programs: { npm: 'C:\\Program Files\\nodejs\\npm.cmd' },
    state: { files: new Set(['c:\\users\\rohit\\appdata\\roaming\\npm\\pocket-dev.cmd']) },
  });
  const report = await collectDoctor(ctx);
  assert.equal(row(report, 'prefix').ok, true);
  assert.equal(row(report, 'command').ok, true);
});

test('wrong installs are named: local project folder, npx, GitHub, source checkout', () => {
  const win = { platform: 'win32', realpath: (p) => p, exists: () => false, readFile: () => { throw new Error('none'); } };
  const globalRoot = 'C:\\Users\\ROHIT\\AppData\\Roaming\\npm\\node_modules';
  const local = detectInstall({ ...win, packageRoot: 'C:\\Users\\ROHIT\\Desktop\\node_modules\\@anisirji\\pocket-dev' }, globalRoot);
  assert.deepEqual(local, { kind: 'local', from: null, where: 'C:\\Users\\ROHIT\\Desktop' });
  const npx = detectInstall({ ...win, packageRoot: 'C:\\Users\\ROHIT\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@anisirji\\pocket-dev' }, globalRoot);
  assert.equal(npx.kind, 'npx');
  const registry = detectInstall({ ...win, packageRoot: `${globalRoot}\\@anisirji\\pocket-dev` }, globalRoot);
  assert.deepEqual(registry, { kind: 'global', from: 'registry' });
  const github = detectInstall({ ...win, packageRoot: `${globalRoot}\\@anisirji\\pocket-dev`, exists: (f) => f.endsWith('\\pocket-dev\\test') }, globalRoot);
  assert.deepEqual(github, { kind: 'global', from: 'github' });
  const checkout = detectInstall({ platform: 'linux', packageRoot: '/home/u/pocket-dev', realpath: (p) => p, exists: (f) => f === '/home/u/pocket-dev/.git', readFile: () => '' }, '/usr/lib/node_modules');
  assert.equal(checkout.kind, 'checkout');
});

test('a local install is a failed row that says how to install it for the whole computer and how to remove the copy', async () => {
  const { ctx, lines } = computer({
    platform: 'win32', prefix: 'C:\\Users\\ROHIT\\AppData\\Roaming\\npm', globalRoot: 'C:\\Users\\ROHIT\\AppData\\Roaming\\npm\\node_modules',
    packageRoot: 'C:\\Users\\ROHIT\\Desktop\\node_modules\\@anisirji\\pocket-dev', programs: { npm: 'C:\\npm.cmd' }, env: { Path: 'C:\\Windows' },
  });
  const report = await collectDoctor(ctx);
  assert.equal(row(report, 'install').ok, false);
  printDoctor(ctx, report);
  const out = lines.join('\n');
  assert.match(out, /local, inside the project folder C:\\Users\\ROHIT\\Desktop/);
  assert.match(out, /npm install -g @anisirji\/pocket-dev/);
  assert.match(out, /Remove-Item -Recurse -Force "C:\\Users\\ROHIT\\Desktop\\node_modules\\@anisirji"/);
});

test('unwritable settings folder and a busy port are reported', async () => {
  const { ctx } = computer({ checkWritable: () => 'EACCES', portFree: false });
  const report = await collectDoctor(ctx);
  assert.equal(row(report, 'state').ok, false);
  assert.equal(report.ok, false);
  assert.equal(row(report, 'port').ok, false);
  assert.equal(row(report, 'port').level, 'recommended');
});

test('--fix with node-pty folder present rebuilds it, then re-checks; never sudo', async () => {
  const present = `${LINUX_ROOT}/node_modules/node-pty/package.json`;
  const { ctx, lines, ran, state } = computer({
    state: { terminals: { available: false, reason: 'the terminal component (node-pty) does not match this version of Node' }, files: new Set([present, '/usr/local/bin/pocket-dev']) },
    onNpm: (st) => { st.terminals = { available: true }; },
  });
  const code = await doctorCommand(['--fix', '--yes'], ctx);
  const npmRuns = ran.filter((r) => ['rebuild', 'install'].includes(r.args[0]));
  assert.equal(code, 0);
  assert.equal(npmRuns.length, 1);
  assert.deepEqual(npmRuns[0].args, ['rebuild', 'node-pty']);
  assert.equal(npmRuns[0].opts.cwd, LINUX_ROOT);
  assert.ok(ran.every((r) => !/sudo/.test([r.cmd, ...r.args].join(' '))));
  assert.match(lines.join('\n'), /\$ npm rebuild node-pty/);
  assert.match(lines.join('\n'), /Terminals work now\. Restart Pocket Dev/);
  assert.equal(state.terminals.available, true);
});

test('--fix when node-pty was never unpacked installs it into the Pocket Dev folder only', async () => {
  const { ctx, ran } = computer({
    state: { terminals: { available: false, reason: 'the terminal component (node-pty) is not installed' }, files: new Set(['/usr/local/bin/pocket-dev']) },
    onNpm: (st) => { st.terminals = { available: true }; },
  });
  const plan = repairPlan(ctx);
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].argv.slice(1, 5), ['install', '--no-save', '--no-audit', '--no-fund']);
  assert.match(plan.steps[0].argv[5], /^node-pty@/);
  assert.equal(await repairTerminals(ctx, { yes: true }), true);
  assert.equal(ran.filter((r) => r.args[0] === 'install').length, 1);
});

test('--fix asks [Y/n] before running and does nothing on "no"; a non-interactive run only prints the command', async () => {
  const base = { state: { terminals: { available: false, reason: 'x' }, files: new Set() } };
  const asked = [];
  const no = computer({ ...base, ask: async (q) => { asked.push(q); return false; } });
  assert.equal(await repairTerminals(no.ctx, {}), false);
  assert.match(asked[0], /\[Y\/n\]/);
  assert.equal(no.ran.filter((r) => ['rebuild', 'install'].includes(r.args[0])).length, 0);
  const quiet = computer({ ...base, isTTY: false });
  assert.equal(await repairTerminals(quiet.ctx, {}), false);
  assert.match(quiet.lines.join('\n'), /Not an interactive terminal: run that command yourself, or add --yes/);
  assert.equal(quiet.ran.filter((r) => ['rebuild', 'install'].includes(r.args[0])).length, 0);
});

test('--fix that cannot repair prints the compiler guidance for each system and exits 1', async () => {
  const expectations = { win32: /Build Tools[\s\S]*Python/, darwin: /xcode-select --install/, linux: /build-essential/ };
  for (const [platform, pattern] of Object.entries(expectations)) {
    const { ctx, lines } = computer({ platform, programs: { npm: platform === 'win32' ? 'C:\\npm.cmd' : '/usr/bin/npm' }, packageRoot: platform === 'win32' ? 'C:\\p' : LINUX_ROOT,
      state: { terminals: { available: false, reason: 'x' }, files: new Set() }, npmCode: 1 });
    assert.equal(await doctorCommand(['--fix', '--yes'], ctx), 1, platform);
    assert.match(lines.join('\n'), pattern, platform);
    assert.doesNotMatch(lines.join('\n'), /Not an interactive/);
  }
});

test('--fix on a temporary npx copy refuses and says to install first', async () => {
  const { ctx, lines, ran } = computer({ packageRoot: '/home/u/.npm/_npx/9f/node_modules/@anisirji/pocket-dev', state: { terminals: { available: false, reason: 'x' }, files: new Set() } });
  assert.equal(await doctorCommand(['--fix', '--yes'], ctx), 1);
  assert.match(lines.join('\n'), /temporary npx copy/);
  assert.equal(ran.filter((r) => ['rebuild', 'install'].includes(r.args[0])).length, 0);
});

test('probeTerminals reports a missing module, a throwing spawn and a shell that dies at once', async () => {
  const missing = await probeTerminals({ shell: '/bin/sh', importer: async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); }, env: {} });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not installed/);
  const throws = await probeTerminals({ shell: '/bin/nope', importer: async () => ({ spawn() { throw new Error('posix_spawnp failed.'); } }), env: {} });
  assert.match(throws.reason, /could not start \/bin\/nope: posix_spawnp failed/);
  const dies = await probeTerminals({ shell: '/bin/sh', env: {}, wait: 500, importer: async () => ({ spawn: () => ({ onData() {}, onExit: (fn) => setTimeout(() => fn({ exitCode: 127 }), 10), kill() {} }) }) });
  assert.match(dies.reason, /stopped at once \(exit 127\)/);
  const works = await probeTerminals({ shell: '/bin/sh', env: {}, wait: 500, importer: async () => ({ spawn: () => ({ onData: (fn) => setTimeout(fn, 10), onExit() {}, kill() {} }) }) });
  assert.equal(works.available, true);
});

test('the real doctor command runs in a throwaway state folder and ends with a verdict', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), 'doctor'], { encoding: 'utf8', env: { ...process.env, POCKET_DEV_STATE_DIR: path.join(REPO, 'node_modules', '.doctor-test-state'), PORT: '0' }, input: '' });
  assert.match(r.stdout, /Pocket Dev .* doctor/);
  assert.match(r.stdout, /Terminals \(node-pty\)/);
  assert.match(r.stdout, /Everything Pocket Dev requires is working\.|Something required is not working/);
});
