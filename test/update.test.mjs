import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions, isNewer, parseSemver, fetchLatest, installKind, createUpdater, updateCommand, latestVersionStep,
  createVersionCheck, updateCheckOff, CHECK_TTL_MS, RETRY_AFTER_FAILURE_MS, INSTALL_ARGS, REGISTRY_URL,
} from '../src/setup/update.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- Versions -----------------------------------------------------------------------------------------------------

test('versions compare as numbers, not text, and a release beats its own prerelease', () => {
  assert.equal(compareVersions('1.2.0', '1.1.5'), 1);
  assert.equal(compareVersions('1.1.5', '1.2.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, '10 is more than 9');
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1);
  assert.equal(compareVersions('1.2.0-rc.2', '1.2.0-rc.10'), -1);
  assert.equal(compareVersions('1.2.0-alpha', '1.2.0-1'), 1, 'letters rank above numbers in a prerelease');
  assert.equal(compareVersions('1.2.0+build5', '1.2.0'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('latest', '1.2.0'), null);
  assert.equal(compareVersions('1.2', '1.2.0'), null);
  assert.equal(parseSemver(undefined), null);
});

test('only a newer registry version counts as an update', () => {
  assert.equal(isNewer('1.2.1', '1.2.0'), true);
  assert.equal(isNewer('1.1.5', '1.2.0'), false, 'installed 1.2.0 is ahead of npm 1.1.5');
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('oops', '1.2.0'), false);
});

// ---- The registry -------------------------------------------------------------------------------------------------

test('the registry look-up sends no identity and reads the version', async () => {
  let seen;
  const version = await fetchLatest({ url: REGISTRY_URL, fetch: async (url, init) => { seen = { url, init }; return Response.json({ version: '1.3.0', name: 'x' }); } });
  assert.equal(version, '1.3.0');
  assert.equal(seen.url, 'https://registry.npmjs.org/@anisirji%2fpocket-dev/latest');
  assert.deepEqual(Object.keys(seen.init.headers), ['accept'], 'only an accept header, nothing about the user');
  assert.equal(seen.init.method, undefined, 'a plain GET');
  assert.equal(seen.init.body, undefined);
});

test('an offline computer and a bad answer are told apart', async () => {
  await assert.rejects(fetchLatest({ fetch: async () => { throw new TypeError('fetch failed'); } }), { kind: 'offline' });
  await assert.rejects(fetchLatest({ fetch: async () => new Response('nope', { status: 503 }) }), { kind: 'registry', message: /503/ });
  await assert.rejects(fetchLatest({ fetch: async () => Response.json({ version: 'latest' }) }), { kind: 'registry' });
  await assert.rejects(fetchLatest({ fetch: async () => new Response('<html>', { status: 200 }) }), { kind: 'registry' });
});

// ---- How this copy was installed ----------------------------------------------------------------------------------

test('a global npm install is told from a source folder, npx and a project install', () => {
  const same = (p) => p;
  assert.equal(installKind('/usr/local/lib/node_modules/@anisirji/pocket-dev', { realpath: same, globalRoot: '/usr/local/lib/node_modules' }), 'global');
  assert.equal(installKind('/usr/local/lib/node_modules/@anisirji/pocket-dev', { realpath: same }), 'global', 'unknown global folder: assume global');
  assert.equal(installKind('/home/me/proj/node_modules/@anisirji/pocket-dev', { realpath: same, globalRoot: '/usr/local/lib/node_modules' }), 'local');
  assert.equal(installKind('/home/me/.npm/_npx/abc/node_modules/@anisirji/pocket-dev', { realpath: same }), 'npx');
  assert.equal(installKind('/home/me/Desktop/pocket-dev', { realpath: same }), 'source');
  // npm link: the link resolves to the source folder
  assert.equal(installKind('/usr/local/lib/node_modules/@anisirji/pocket-dev', { realpath: () => '/home/me/Desktop/pocket-dev', globalRoot: '/usr/local/lib/node_modules' }), 'source');
  assert.equal(installKind('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anisirji\\pocket-dev', { realpath: same, sep: '\\' }), 'global');
});

// ---- The update command -------------------------------------------------------------------------------------------

// A context whose every outside action is recorded: no network, no npm, no service.
function harness({ version = '1.2.0', latest = '1.3.0', lookupError, kind = 'global', isTTY = true, answer = true, npm = { code: 0, stdout: 'added 1 package\n', stderr: '' }, service = true, newVersion = '1.3.0' } = {}) {
  const lines = [], calls = { npm: [], restart: 0, reexec: 0, ask: [] };
  let installedVersion = version;
  const update = createUpdater({
    version, root: '/x', env: {},
    fetchLatest: async () => { if (lookupError) throw new Error(lookupError); return latest; },
    realpath: () => (kind === 'source' ? '/home/me/pocket-dev' : kind === 'npx' ? '/home/me/.npm/_npx/1/node_modules/@anisirji/pocket-dev' : '/usr/local/lib/node_modules/@anisirji/pocket-dev'),
    globalRoot: async () => (kind === 'local' ? '/elsewhere' : '/usr/local/lib/node_modules'),
    run: async (cmd, args) => { calls.npm.push([cmd, ...args]); if (npm.code === 0) installedVersion = newVersion; return npm; },
    readVersion: () => installedVersion,
    hasService: async () => service,
    restartService: async () => { calls.restart++; return { ok: true }; },
    reexec: async () => { calls.reexec++; return 7; },
  });
  const ctx = { out: (l = '') => lines.push(l), isTTY, ask: async (q, def) => { calls.ask.push(q); return answer ?? def; }, update };
  return { ctx, lines, calls, text: () => lines.join('\n') };
}

test('update says up to date when npm has an older or equal version', async () => {
  const h = harness({ version: '1.2.0', latest: '1.1.5' });
  assert.equal(await updateCommand([], h.ctx), 0);
  assert.match(h.text(), /1\.2\.0 is up to date \(it is newer than the 1\.1\.5 on npm\)/);
  assert.deepEqual(h.calls.npm, []);
  const same = harness({ version: '1.2.0', latest: '1.2.0' });
  assert.equal(await updateCommand([], same.ctx), 0);
  assert.match(same.text(), /1\.2\.0 is up to date\./);
});

test('update --check says a newer version exists and installs nothing', async () => {
  const h = harness();
  assert.equal(await updateCommand(['--check'], h.ctx), 0);
  assert.match(h.text(), /Version 1\.3\.0 is available, you have 1\.2\.0\./);
  assert.match(h.text(), /Install it with: pocket-dev update/);
  assert.deepEqual(h.calls.npm, []);
  assert.equal(h.calls.ask.length, 0);
});

test('update asks, installs with npm, shows its output and restarts the service', async () => {
  const h = harness();
  assert.equal(await updateCommand([], h.ctx), 0);
  assert.deepEqual(h.calls.ask, ['Update now? [Y/n] ']);
  assert.deepEqual(h.calls.npm, [['npm', ...INSTALL_ARGS]]);
  assert.deepEqual(INSTALL_ARGS, ['install', '-g', '@anisirji/pocket-dev@latest']);
  assert.match(h.text(), /added 1 package/);
  assert.match(h.text(), /Updated Pocket Dev 1\.2\.0 to 1\.3\.0\./);
  assert.match(h.text(), /Restarted the background service/);
  assert.match(h.text(), /What changed: https:\/\/github\.com\/anisirji\/pocket-dev\/releases/);
  assert.equal(h.calls.restart, 1);
});

test('update --yes does not ask, and without a service it says how to restart', async () => {
  const h = harness({ service: false });
  assert.equal(await updateCommand(['--yes'], h.ctx), 0);
  assert.equal(h.calls.ask.length, 0);
  assert.equal(h.calls.restart, 0);
  assert.match(h.text(), /stop it and run pocket-dev start/);
});

test('declining, or no terminal without --yes, installs nothing', async () => {
  const no = harness({ answer: false });
  assert.equal(await updateCommand([], no.ctx), 0);
  assert.deepEqual(no.calls.npm, []);
  assert.match(no.text(), /Not updated/);
  const quiet = harness({ isTTY: false });
  assert.equal(await updateCommand([], quiet.ctx), 0);
  assert.deepEqual(quiet.calls.npm, []);
  assert.match(quiet.text(), /pocket-dev update --yes/);
});

test('offline: update says so, changes nothing and exits 1', async () => {
  const h = harness({ lookupError: 'the npm registry did not answer' });
  assert.equal(await updateCommand(['--yes'], h.ctx), 1);
  assert.match(h.text(), /Could not check for a newer version: the npm registry did not answer\. Nothing was changed/);
  assert.deepEqual(h.calls.npm, []);
});

test('a source checkout, npx and a project install are not updated and say why', async () => {
  for (const [kind, words] of [['source', /git pull/], ['npx', /npx -y @anisirji\/pocket-dev@latest/], ['local', /inside a project/]]) {
    const h = harness({ kind });
    assert.equal(await updateCommand(['--yes'], h.ctx), 0, kind);
    assert.match(h.text(), words);
    assert.deepEqual(h.calls.npm, [], kind);
  }
});

test('a permission error from npm points to the own-folder fix and never suggests sudo as the answer', async () => {
  const h = harness({ npm: { code: 243, stdout: '', stderr: "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@anisirji" } });
  assert.equal(await updateCommand(['--yes'], h.ctx), 1);
  assert.match(h.text(), /permission denied\)\. Do not use sudo/);
  assert.match(h.text(), /docs\/INSTALL_BEGINNERS\.md/);
  assert.match(h.text(), /EACCES permission denied/);
  assert.equal(h.calls.restart, 0);
});

test('another npm failure leaves Pocket Dev unchanged and says so', async () => {
  const h = harness({ npm: { code: 1, stdout: '', stderr: 'npm error network timeout' } });
  assert.equal(await updateCommand(['--yes'], h.ctx), 1);
  assert.match(h.text(), /network timeout/);
  assert.match(h.text(), /did not finish: npm exited with code 1\. Pocket Dev was not changed/);
  assert.equal(h.calls.restart, 0);
});

test('an unknown option is refused', async () => {
  const h = harness();
  assert.equal(await updateCommand(['--now'], h.ctx), 2);
  assert.match(h.text(), /Usage: pocket-dev update \[--check\] \[--yes\]/);
});

// ---- The onboarding step ------------------------------------------------------------------------------------------

test('setup accepts the update, installs it and runs itself again from the new version', async () => {
  const h = harness();
  const r = await latestVersionStep(h.ctx, {});
  assert.deepEqual(r, { code: 7 });
  assert.match(h.text(), /^Latest version/);
  assert.match(h.text(), /Version 1\.3\.0 is available, you have 1\.2\.0\./);
  assert.deepEqual(h.calls.ask, ['Update now? [Y/n] ']);
  assert.equal(h.calls.npm.length, 1);
  assert.equal(h.calls.reexec, 1);
  assert.match(h.text(), /Running setup again from the new version/);
});

test('Enter alone means yes', async () => {
  const h = harness({ answer: undefined });
  assert.deepEqual(await latestVersionStep(h.ctx, {}), { code: 7 });
});

test('setup carries on with the current version when the update is declined', async () => {
  const h = harness({ answer: false });
  assert.equal(await latestVersionStep(h.ctx, {}), null);
  assert.deepEqual(h.calls.npm, []);
  assert.match(h.text(), /Not updated\. You can update later with: pocket-dev update/);
});

test('--yes updates without asking', async () => {
  const h = harness();
  assert.deepEqual(await latestVersionStep(h.ctx, { yes: true }), { code: 7 });
  assert.equal(h.calls.ask.length, 0);
});

test('--dry-run and --check only say what is there', async () => {
  for (const opts of [{ dry: true }, { check: true }]) {
    const h = harness();
    assert.equal(await latestVersionStep(h.ctx, opts), null);
    assert.deepEqual(h.calls.npm, []);
    assert.equal(h.calls.reexec, 0);
    assert.equal(h.calls.ask.length, 0);
    assert.match(h.text(), /Version 1\.3\.0 is available/);
    if (opts.dry) assert.match(h.text(), /Dry run: would run npm install -g @anisirji\/pocket-dev@latest/);
  }
});

test('without a terminal setup prints the command and carries on', async () => {
  const h = harness({ isTTY: false });
  assert.equal(await latestVersionStep(h.ctx, { yes: true }), null);
  assert.deepEqual(h.calls.npm, []);
  assert.match(h.text(), /Update with: pocket-dev update/);
});

test('the step is quiet when up to date, offline, for one --only step, or when the person opted out', async () => {
  const upToDate = harness({ latest: '1.2.0' });
  assert.equal(await latestVersionStep(upToDate.ctx, {}), null);
  assert.match(upToDate.text(), /1\.2\.0 is the latest version/);
  const offline = harness({ lookupError: 'the npm registry did not answer' });
  assert.equal(await latestVersionStep(offline.ctx, {}), null);
  assert.match(offline.text(), /Carrying on with 1\.2\.0/);
  const only = harness();
  assert.equal(await latestVersionStep(only.ctx, { only: 'password' }), null);
  assert.equal(only.lines.length, 0);
  const noStep = { out: () => assert.fail('no output'), isTTY: true };
  assert.equal(await latestVersionStep(noStep, {}), null, 'a context with no updater has no step');
});

test('a failed update in setup carries on with the version you have', async () => {
  const h = harness({ npm: { code: 1, stdout: '', stderr: 'boom' } });
  assert.equal(await latestVersionStep(h.ctx, { yes: true }), null);
  assert.match(h.text(), /Carrying on with the version you have/);
  assert.equal(h.calls.reexec, 0);
});

test('the step skips itself after setup already re-ran from the new install, and for non-npm installs', async () => {
  const lines = [];
  const base = { version: '1.2.0', root: '/x', fetchLatest: async () => '1.3.0', run: async () => ({ code: 0 }), realpath: (p) => p, globalRoot: async () => '/g' };
  const updated = createUpdater({ ...base, env: { POCKET_DEV_UPDATED: '1' }, root: '/g/node_modules/@anisirji/pocket-dev' });
  assert.equal(await updated.skipReason(), 'updated');
  const source = createUpdater({ ...base, env: {}, root: '/home/me/pocket-dev' });
  assert.equal(await source.skipReason(), 'source');
  assert.equal(await latestVersionStep({ out: (l) => lines.push(l), isTTY: true, update: source }, {}), null);
  assert.deepEqual(lines, []);
  const off = createUpdater({ ...base, env: { POCKET_DEV_NO_UPDATE_CHECK: '1' }, root: '/g/node_modules/@anisirji/pocket-dev' });
  assert.equal(await off.skipReason(), 'off');
});

// ---- The quiet check in the server --------------------------------------------------------------------------------

test('the server look-up happens at most once a day and the answer is kept in the state folder', async (t) => {
  const stateDir = tmp(t);
  let clock = 1_000_000, hits = 0;
  const make = () => createVersionCheck({ version: '1.2.0', stateDir, now: () => clock, lookup: async () => { hits++; return '1.3.0'; } });
  const check = make();
  assert.equal(check.view(), null, 'nothing known yet');
  await check.refresh();
  assert.equal(hits, 1);
  assert.deepEqual(check.view(), { current: '1.2.0', latest: '1.3.0', available: true, checkedAt: clock, command: 'pocket-dev update' });
  await check.refresh();
  clock += CHECK_TTL_MS - 1;
  await check.refresh();
  assert.equal(hits, 1, 'inside the day: no second look');
  assert.equal(fs.statSync(path.join(stateDir, 'update-check.json')).mode & 0o777, 0o600);
  const restarted = make();
  assert.equal(restarted.view().latest, '1.3.0', 'a restart reads the saved answer');
  await restarted.refresh();
  assert.equal(hits, 1, 'and does not look again inside the day');
  clock += 2;
  await restarted.refresh();
  assert.equal(hits, 2, 'a day later it looks again');
});

test('concurrent refreshes make one request', async (t) => {
  let hits = 0;
  const check = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), lookup: async () => { hits++; await new Promise((r) => setTimeout(r, 20)); return '1.3.0'; } });
  await Promise.all([check.refresh(), check.refresh(), check.refresh()]);
  assert.equal(hits, 1);
});

test('a failed look-up is tried again after six hours, not on every check', async (t) => {
  let clock = 5_000_000, hits = 0, fail = true;
  const check = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), now: () => clock, lookup: async () => { hits++; if (fail) throw new Error('offline'); return '1.3.0'; } });
  await check.refresh();
  await check.refresh();
  assert.equal(hits, 1);
  assert.equal(check.view(), null);
  fail = false;
  clock += RETRY_AFTER_FAILURE_MS;
  await check.refresh();
  assert.equal(hits, 2);
  assert.equal(check.view().available, true);
});

test('an update that was just installed stops showing as available', async (t) => {
  const stateDir = tmp(t);
  fs.writeFileSync(path.join(stateDir, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '1.3.0' }));
  assert.equal(createVersionCheck({ version: '1.2.0', stateDir }).view().available, true);
  assert.equal(createVersionCheck({ version: '1.3.0', stateDir }).view().available, false);
  assert.equal(createVersionCheck({ version: '1.4.0', stateDir }).view().available, false);
});

test('the opt-out stops the look-up and the notice: the environment variable and the updateCheck setting', async (t) => {
  let hits = 0;
  const lookup = async () => { hits++; return '1.3.0'; };
  const envOff = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), env: { POCKET_DEV_NO_UPDATE_CHECK: '1' }, lookup });
  await envOff.refresh();
  assert.deepEqual([hits, envOff.view()], [0, null]);
  const config = { read: () => ({ updateCheck: false }) };
  const cfgOff = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), env: {}, config, lookup });
  await cfgOff.refresh();
  assert.deepEqual([hits, cfgOff.view()], [0, null]);
  assert.equal(updateCheckOff({ POCKET_DEV_NO_UPDATE_CHECK: '0' }), false, '0 means on');
  assert.equal(updateCheckOff({ POCKET_DEV_NO_UPDATE_CHECK: 'false' }), false);
  assert.equal(updateCheckOff({}, { read: () => ({ updateCheck: true }) }), false);
  const live = { value: true };
  const flip = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), env: {}, config: { read: () => ({ updateCheck: live.value }) }, lookup });
  live.value = false;
  await flip.refresh();
  assert.equal(hits, 0, 'the setting is read at each check, no restart needed');
});

test('a source copy shows the notice without a command to run', async (t) => {
  const check = createVersionCheck({ version: '1.2.0', stateDir: tmp(t), kind: 'other', lookup: async () => '1.3.0' });
  await check.refresh();
  assert.equal(check.view().command, null);
});
