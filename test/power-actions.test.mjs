import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPlatform } from '../src/core/platform.js';
import { startServer, until } from './helpers/server.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-power-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'power.json');
  const update = (patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...patch }));
  fs.writeFileSync(file, JSON.stringify({ disabled: false, closed: false }));
  const stub = new URL('./helpers/fake-power.mjs', import.meta.url).pathname;
  const server = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'darwin', POCKET_DEV_POWER_FIXTURE: file,
    POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub, POCKET_DEV_OSASCRIPT: stub, POCKET_DEV_UPDATE_CHECK: stub,
    POCKET_DEV_SHUTDOWN_BLOCKED_MS: '150' } });
  const { cookie } = await server.login();
  const call = (action, body, extra = {}) => server.request('POST', `/api/power/${action}`, { cookie, body, ...extra });
  const read = () => JSON.parse(fs.readFileSync(file));
  const log = () => fs.existsSync(`${file}.log`) ? fs.readFileSync(`${file}.log`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { server, cookie, call, read, update, log };
}

test('lid changes require login, CSRF, explicit confirmation and a boolean; legacy local routes cannot elevate', async (t) => {
  const f = await fixture(t), body = { confirmed: true, disabled: true };
  assert.equal((await f.call('lid', body, { cookie: undefined })).status, 401);
  assert.equal((await f.call('lid', body, { csrf: false })).status, 403);
  for (const bad of [{}, { confirmed: false, disabled: true }, { confirmed: true, disabled: 'on' }]) assert.equal((await f.call('lid', bad)).status, 400);
  assert.equal((await f.call('shutdown-force', {})).status, 400);
  assert.equal((await f.server.request('POST', '/api/local/power/lid', { body })).status, 403);
  assert.equal((await f.server.request('POST', '/api/local/power/shutdown-force', { body: { confirmed: true } })).status, 403);
  assert.deepEqual(f.log(), []);
});

test('lid on and off use native authorization, verify the setting and never create a terminal', async (t) => {
  const f = await fixture(t);
  for (const disabled of [true, false]) {
    const result = await f.call('lid', { disabled, confirmed: true, command: 'ignored; not a command API' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.lidSleepDisabled, disabled); assert.equal(result.data.authorizationPending, null);
  }
  assert.equal(f.log().length, 2);
  for (const item of f.log()) { assert.match(item.script, /with administrator privileges/); assert.doesNotMatch(item.script, /ignored|sudo|Terminal/); }
  assert.deepEqual((await f.server.request('GET', '/api/sessions', { cookie: f.cookie })).data, []);
});

test('closed lid, cancellation and failed authorization keep the original setting', async (t) => {
  const f = await fixture(t);
  f.update({ closed: true }); assert.equal((await f.call('lid', { disabled: true, confirmed: true })).status, 409); assert.deepEqual(f.log(), []);
  f.update({ closed: false, cancel: true }); const cancel = await f.call('lid', { disabled: true, confirmed: true });
  assert.equal(cancel.status, 409); assert.equal(cancel.data.cancelled, true); assert.equal(f.read().disabled, false);
  f.update({ cancel: false, fail: true }); assert.equal((await f.call('lid', { disabled: true, confirmed: true })).status, 503); assert.equal(f.read().disabled, false);
});

test('one pending approval refuses competing actions and rechecks the lid after approval', async (t) => {
  const f = await fixture(t); f.update({ hold: true });
  const pending = f.call('lid', { disabled: true, confirmed: true });
  await until(() => f.log().length === 1);
  assert.equal((await f.server.request('GET', '/api/power', { cookie: f.cookie })).data.authorizationPending, 'lid');
  assert.equal((await f.call('lid', { disabled: true, confirmed: true })).status, 409);
  assert.equal((await f.call('sleep', { confirmed: true })).status, 409);
  f.update({ closed: true, hold: false }); assert.equal((await pending).status, 503); assert.equal(f.read().disabled, false);
});

test('sleep with lid sleep disabled restores it through authorization and honors update refusal', async (t) => {
  const f = await fixture(t); f.update({ disabled: true, updating: true });
  assert.equal((await f.call('sleep', { confirmed: true })).status, 409); assert.deepEqual(f.log(), []);
  f.update({ updating: false }); assert.equal((await f.call('sleep', {})).status, 400);
  f.update({ cancel: true }); assert.equal((await f.call('sleep', { confirmed: true })).status, 409); assert.equal(f.read().disabled, true);
  f.update({ cancel: false }); assert.equal((await f.call('sleep', { confirmed: true })).status, 202); assert.equal(f.read().disabled, false);
  await until(() => f.log().some((item) => item.sleep));
  assert.deepEqual((await f.server.request('GET', '/api/sessions', { cookie: f.cookie })).data, []);
});

test('force shutdown requires confirmation and approval; cancellation does not end terminals or schedule shutdown', async (t) => {
  const f = await fixture(t); f.update({ cancel: true });
  const terminal = await f.server.request('POST', '/api/sessions', { cookie: f.cookie, body: { cwd: f.server.home } });
  assert.equal(terminal.status, 201);
  assert.equal((await f.call('shutdown-force', { confirmed: true })).status, 409);
  assert.equal((await f.server.request('GET', '/api/power', { cookie: f.cookie })).data.shutdown, null);
  assert.equal(f.log().some((item) => item.forceShutdown), false);
  const sessions = (await f.server.request('GET', '/api/sessions', { cookie: f.cookie })).data;
  assert.ok(sessions.some((session) => session.id === terminal.data.id && session.exitCode == null));
  f.update({ cancel: false, updating: true }); assert.equal((await f.call('shutdown-force', { confirmed: true })).status, 409);
  f.update({ updating: false }); assert.equal((await f.call('shutdown-force', { confirmed: true })).status, 202);
  assert.equal(f.log().filter((item) => item.forceShutdown).length, 1);
});

test('native Mac authorization scripts compile without executing a power action', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-power-compile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = [];
  const platform = createPlatform({ platform: 'darwin', run: async (_cmd, args) => {
    if (args[0] === '-e') scripts.push(args[1]);
    return { code: 0, stdout: 'SleepDisabled 1\n"AppleClamshellState" = No', stderr: '' };
  } });
  await platform.setLidSleepDisabled(true); await platform.setLidSleepDisabled(false); await platform.prepareSleep(); await platform.forceShutDown();
  assert.equal(scripts.length, 4);
  for (const [index, script] of scripts.entries()) {
    const result = spawnSync('/usr/bin/osacompile', ['-o', path.join(root, `${index}.scpt`), '-'], { input: script, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const command = JSON.parse(script.slice('do shell script '.length, -' with administrator privileges'.length));
    const shell = spawnSync('/bin/sh', ['-n'], { input: command, encoding: 'utf8', timeout: 10000 });
    assert.equal(shell.status, 0, shell.stderr);
  }
});
