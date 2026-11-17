import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateRunner, npmCommand } from '../update-runner.js';
import {
  createVersionCheck, cachedUpdateLine, CHECK_TTL_MS, RETRY_AFTER_FAILURE_MS, ADMIN_FRESH_MS, UPDATE_COMMAND,
} from '../update.js';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-upd-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail('timed out'); };

// A version check that already knows a newer version exists.
const knows = (t, { latest = '1.3.0', version = '1.2.0', lookup } = {}) => createVersionCheck({ version, stateDir: tmp(t), lookup: lookup ?? (async () => latest) });

function runner(t, { run, service = { installed: false, isThisServer: false }, kind = 'global', restarts = [], lookup } = {}) {
  const check = knows(t, { lookup });
  return {
    check, restarts,
    r: createUpdateRunner({
      versionCheck: check, kind, version: '1.2.0', readVersion: () => '1.3.0',
      run: run ?? (async (cmd, args, { onChunk }) => { onChunk('added 1 package\n'); return { code: 0, stdout: 'added 1 package\n', stderr: '' }; }),
      serviceInfo: async () => service, restartThisServer: () => restarts.push('restart'), restartDelayMs: 1,
    }),
  };
}

test('an update runs through checking and installing and tells the person to restart when there is no service', async (t) => {
  const { r, check } = runner(t);
  await check.refresh();
  assert.equal(r.view().canUpdate, true);
  const started = await r.start();
  assert.equal(started.status, 202);
  await until(() => r.phase() === 'done');
  const v = r.view();
  assert.match(v.message, /Installed 1\.3\.0\. Restart Pocket Dev to finish: pocket-dev start/);
  assert.deepEqual(v.output, ['added 1 package']);
});

test('when this copy is the background service it restarts itself after installing', async (t) => {
  const { r, check, restarts } = runner(t, { service: { installed: true, isThisServer: true } });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'restarting');
  await until(() => restarts.length === 1);
  assert.match(r.view().message, /Restarting Pocket Dev/);
});

test('a service that is some other copy is named, not restarted', async (t) => {
  const { r, check, restarts } = runner(t, { service: { installed: true, isThisServer: false } });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'done');
  assert.match(r.view().message, /pocket-dev service restart/);
  assert.equal(restarts.length, 0);
});

test('a second update while one runs is refused with 409', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { r, check } = runner(t, { run: async () => { await gate; return { code: 0, stdout: '', stderr: '' }; } });
  await check.refresh();
  assert.equal((await r.start()).status, 202);
  await until(() => r.phase() === 'installing');
  const second = await r.start();
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already running/);
  release();
  await until(() => r.phase() === 'done');
});

test('a permission error shows the own-folder help and no sudo advice', async (t) => {
  const { r, check } = runner(t, { run: async () => ({ code: 243, stdout: '', stderr: 'npm error code EACCES\nnpm error permission denied' }) });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'failed');
  const v = r.view();
  assert.equal(v.denied, true);
  assert.match(v.help.join(' '), /Do not use sudo/);
  assert.match(v.help.join(' '), /INSTALL_BEGINNERS\.md/);
  assert.equal(r.view().canUpdate, true, 'the person can try again');
});

test('any other npm failure says Pocket Dev was not changed', async (t) => {
  const { r, check } = runner(t, { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'failed');
  assert.match(r.view().error, /Pocket Dev was not changed/);
  assert.equal(r.view().denied, false);
});

test('a git checkout, npm link or npx copy is refused with the reason and nothing runs', async (t) => {
  let ran = false;
  const { r, check } = runner(t, { kind: 'source', run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; } });
  await check.refresh();
  const v = r.view();
  assert.equal(v.canUpdate, false);
  assert.match(v.reason, /source folder/);
  const started = await r.start();
  assert.equal(started.status, 409);
  assert.equal(ran, false);
});

test('when the registry says the copy is already current nothing is installed', async (t) => {
  let ran = false;
  const { r } = runner(t, { lookup: async () => '1.2.0', run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; } });
  await r.start();
  await until(() => r.phase() === 'idle');
  assert.equal(ran, false);
  assert.match(r.view().message, /up to date/);
});

test('npm is taken from beside the running node, with POCKET_DEV_NPM as the override', () => {
  const beside = path.join('/opt/node/bin', 'npm');
  assert.equal(npmCommand({ env: {}, execPath: '/opt/node/bin/node', exists: (f) => f === beside }), beside);
  assert.equal(npmCommand({ env: {}, execPath: '/opt/node/bin/node', exists: () => false }), 'npm');
  assert.equal(npmCommand({ env: { POCKET_DEV_NPM: '/x/fake-npm' }, execPath: '/opt/node/bin/node' }), '/x/fake-npm');
  assert.equal(npmCommand({ env: {}, execPath: 'C:\\node\\node.exe', platform: 'win32', exists: (f) => f.endsWith('npm.cmd') }).endsWith('npm.cmd'), true);
});

// ---- The schedule -----------------------------------------------------------------------------------------------------

test('the look-up is cached six hours, a failure is retried after an hour, and the Admin page can ask for fresher', async (t) => {
  assert.equal(CHECK_TTL_MS, 6 * 60 * 60_000);
  assert.equal(RETRY_AFTER_FAILURE_MS, 60 * 60_000);
  assert.equal(ADMIN_FRESH_MS, 60 * 60_000);
  let clock = 1_000_000, hits = 0, fail = false;
  const check = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), now: () => clock, lookup: async () => { hits++; if (fail) throw new Error('offline'); return '1.3.0'; } });
  await check.refresh();
  clock += CHECK_TTL_MS - 1; await check.refresh();
  assert.equal(hits, 1, 'inside six hours: no new look-up');
  clock += 2; await check.refresh();
  assert.equal(hits, 2, 'after six hours: a new look-up');
  clock += ADMIN_FRESH_MS + 1; await check.refresh({ maxAgeMs: ADMIN_FRESH_MS });
  assert.equal(hits, 3, 'the Admin page asks for news older than an hour');
  await check.refresh({ maxAgeMs: ADMIN_FRESH_MS });
  assert.equal(hits, 3, 'and not again straight after');
  const failing = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), now: () => clock, lookup: async () => { hits++; throw new Error('offline'); } });
  const before = hits;
  await failing.refresh(); await failing.refresh();
  assert.equal(hits, before + 1, 'a failed look-up waits before trying again');
  clock += RETRY_AFTER_FAILURE_MS; await failing.refresh();
  assert.equal(hits, before + 2, 'one hour later it tries again');
  void fail;
});

test('the terminal line appears only for a saved newer version and never when the check is off', (t) => {
  const stateDir = tmp(t);
  assert.equal(cachedUpdateLine({ version: '1.2.0', stateDir, env: {} }), null, 'nothing saved yet');
  fs.writeFileSync(path.join(stateDir, 'update-check.json'), JSON.stringify({ checkedAt: 1, latest: '1.3.0' }));
  assert.equal(cachedUpdateLine({ version: '1.2.0', stateDir, env: {} }), `Pocket Dev 1.3.0 is available (you have 1.2.0). Update with: ${UPDATE_COMMAND}`);
  assert.equal(cachedUpdateLine({ version: '1.3.0', stateDir, env: {} }), null, 'already current');
  assert.equal(cachedUpdateLine({ version: '1.2.0', stateDir, env: { POCKET_DEV_NO_UPDATE_CHECK: '1' } }), null, 'opted out by environment');
  assert.equal(cachedUpdateLine({ version: '1.2.0', stateDir, env: {}, config: { read: () => ({ updateCheck: false }) } }), null, 'opted out by config');
});

test('when npm finishes but the version on disk is unchanged the message says so instead of claiming an install', async (t) => {
  const check = knows(t);
  const r = createUpdateRunner({
    versionCheck: check, kind: 'global', version: '1.2.0', readVersion: () => '1.2.0',
    run: async () => ({ code: 0, stdout: '', stderr: '' }), serviceInfo: async () => ({ installed: false, isThisServer: false }),
  });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'done');
  assert.match(r.view().message, /npm finished, but this copy still reports 1\.2\.0\. Restart Pocket Dev to finish/);
  assert.doesNotMatch(r.view().message, /^Installed/);
});

test('the first thing shown while an update starts is that it is checking', async (t) => {
  const { r, check } = runner(t, { run: () => new Promise(() => {}) });
  await check.refresh();
  const started = await r.start();
  assert.equal(started.body.phase, 'checking');
  assert.match(started.body.message, /Checking for the newest version/);
});
