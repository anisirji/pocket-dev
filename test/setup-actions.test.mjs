import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupActions } from '../src/setup/actions.js';
import { createContext, realRun } from '../src/setup/setup.js';
import { until } from './helpers/server.mjs';

function fixture(t, { initial = {}, verified = true, fail = false, deferred = false, node = '22.17.1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-setup-action-'));
  const installs = [], known = new Set(['npm']), changes = [];
  let data = structuredClone(initial), release;
  const context = createContext({ platform: 'darwin', env: { HOME: root }, childEnv: {}, nodeVersion: node, writable: () => true,
    find: ({ bin }) => known.has(bin) ? `/inert/${bin}` : null,
    async run(cmd, args, options = {}) {
      if (args[0] === 'install') {
        installs.push({ cmd, args, options }); options.onOutput('Installing fixture\nBearer abcdefghijklmnop\n');
        if (deferred) await new Promise((resolve) => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }); });
        if (options.signal.aborted) return { code: null };
        if (verified) known.add('codex');
        return { code: fail ? 1 : 0 };
      }
      if (args[0] === 'prefix') return { code: 0, stdout: root };
      if (args[0] === '--version') return { code: 0, stdout: path.basename(cmd) === 'npm' ? '10.9.2' : 'codex-cli 0.172.0' };
      return { code: 1, stdout: '', stderr: 'Not logged in' };
    },
  });
  const config = { read: () => data, update: (patch) => { data = { ...data, ...structuredClone(patch) }; } };
  const options = { context, config, stateDir: root, doneFile: path.join(root, 'setup-done'), changed: (tool) => changes.push(tool) };
  const actions = createSetupActions(options);
  t.after(() => { release?.(); actions.close(); });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { actions, options, installs, changes, root, known, config, release: () => release?.() };
}
const command = (requestId = 'installation-action-1234') => ({ tool: 'codex', confirmed: true, requestId });

test('setup inspection is passive and excludes executable paths and account output', async (t) => {
  const f = fixture(t), plan = await f.actions.plan();
  assert.equal(f.installs.length, 0);
  assert.equal(plan.tools.find((tool) => tool.id === 'codex').install.command, 'npm install -g @openai/codex');
  assert.doesNotMatch(JSON.stringify(plan), /\/inert\/|Bearer|Not logged in/);
});

test('setup accepts only explicitly confirmed known plans and rejects supplied commands', async (t) => {
  const f = fixture(t);
  for (const body of [null, {}, command('short'), { ...command(), tool: 'arbitrary' }, { ...command(), confirmed: false }, { ...command(), command: 'echo nope' }, { ...command(), env: {} }]) {
    await assert.rejects(f.actions.start(body), { status: 400 });
  }
  assert.equal(f.installs.length, 0);
});

test('setup action IDs prevent duplicate installations and progress is private and bounded', async (t) => {
  const f = fixture(t, { deferred: true });
  const first = await f.actions.start(command());
  const duplicate = await f.actions.start(command());
  assert.equal(first.job.id, duplicate.job.id);
  assert.equal(first.job.work, undefined);
  assert.equal(f.installs.length, 1);
  assert.equal(f.installs[0].cmd, '/inert/npm');
  assert.deepEqual(f.installs[0].args, ['install', '-g', '@openai/codex']);
  assert.equal(f.installs[0].options.group, true);
  assert.ok(f.installs[0].options.env.npm_config_cache.startsWith(f.root));
  assert.doesNotMatch(f.actions.snapshot().job.output, /abcdefghijklmnop/);
  assert.equal(f.config.read().setupProgress.job.output, undefined, 'raw output is never persisted');
  await assert.rejects(f.actions.start(command('second-installation-1234')), { status: 409 });
  f.release(); await until(() => f.actions.snapshot().job.state === 'ready');
  assert.match(f.actions.snapshot().job.message, /sign-in command/);
  assert.deepEqual(f.changes, ['codex']);
  assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('setup-install-')), false);
  assert.equal((await f.actions.start(command())).job.id, first.job.id);
  await assert.rejects(f.actions.start(command('third-installation-1234')), /already installed/);
});

test('a successful install command must also pass independent tool verification', async (t) => {
  const f = fixture(t, { verified: false }); await f.actions.start(command());
  await until(() => f.actions.snapshot().job.state === 'failed');
  assert.match(f.actions.snapshot().job.message, /could not be verified/);
  assert.equal(f.config.read().setupProgress.job.state, 'failed');
});

test('failed installs are not replayed on resume and need an explicit new retry ID', async (t) => {
  const f = fixture(t, { fail: true, verified: false }); await f.actions.start(command());
  await until(() => f.actions.snapshot().job.state === 'failed');
  await f.actions.start(command()); assert.equal(f.installs.length, 1);
  await f.actions.start(command('explicit-retry-action-1234'));
  await until(() => f.actions.snapshot().job.state === 'failed');
  assert.equal(f.installs.length, 2);
  await assert.rejects(f.actions.start(command()), /already been handled/);
});

test('shutdown interrupts an active install without replaying it after restart', async (t) => {
  const f = fixture(t, { deferred: true }); await f.actions.start(command());
  const work = f.installs[0].options.signal; f.actions.close();
  assert.equal(work.aborted, true);
  assert.equal(f.config.read().setupProgress.job.state, 'interrupted');
  const resumed = createSetupActions(f.options); t.after(() => resumed.close());
  assert.equal(resumed.snapshot().job.state, 'interrupted');
  assert.equal(f.installs.length, 1);
  assert.equal((await resumed.start(command())).job.state, 'interrupted');
});

test('setup restores the existing progress marker and completion requires a supported Node', async (t) => {
  const f = fixture(t); f.actions.progress(3);
  assert.equal(createSetupActions(f.options).snapshot().step, 3);
  assert.throws(() => f.actions.progress(5), { status: 400 });
  await f.actions.complete(); assert.equal(fs.existsSync(f.options.doneFile), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.options.doneFile).mode & 0o777, 0o600);
  const old = fixture(t, { node: '20.10.0' });
  await assert.rejects(old.actions.complete(), /Node.js needs attention/);
  assert.equal(fs.existsSync(old.options.doneFile), false);
});

test('streamed Mac child processes stop on cancellation without leaving the installer running', async () => {
  const controller = new AbortController(), chunks = [];
  const result = await realRun(process.execPath, ['-e', 'console.log("fixture-ready");setInterval(()=>{},1000)'], {
    group: true, timeout: 3000, signal: controller.signal, onOutput: (text) => { chunks.push(text); controller.abort(); },
  });
  assert.match(chunks.join(''), /fixture-ready/);
  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false);
});
