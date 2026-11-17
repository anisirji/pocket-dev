import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, until } from './helpers/server.mjs';
import { isolatedEnv } from './isolated-env.mjs';
import { readInstalledVersion } from '../update.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// A stand-in for the npm registry that counts how often it is asked and what it is sent.
async function registry(t, version = '9.9.9') {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: '@anisirji/pocket-dev', version }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/latest`, seen };
}

const on = (url) => ({ POCKET_DEV_UPDATE_URL: url, POCKET_DEV_NO_UPDATE_CHECK: '0' });

test('the phone and the Admin page learn that a newer version exists, with no install button', { timeout: 60000 }, async (t) => {
  const reg = await registry(t);
  const s = await startServer(t, { env: on(reg.url) });
  const { cookie } = await s.login();
  await until(async () => (await s.request('GET', '/api/service', { cookie })).data.update?.available === true);
  const phone = (await s.request('GET', '/api/service', { cookie })).data.update;
  assert.deepEqual([phone.current, phone.latest, phone.available], [readInstalledVersion(), '9.9.9', true]);
  assert.equal(phone.command, null, 'a source checkout has no pocket-dev update to run');
  const admin = (await s.status()).service.update;
  assert.deepEqual([admin.latest, admin.available], ['9.9.9', true]);
  assert.equal((await s.request('POST', '/api/service/update', { cookie, body: {} })).status, 404, 'the phone cannot install software');
  assert.equal(reg.seen.length, 1);
  assert.equal(reg.seen[0].method, 'GET');
  assert.deepEqual(Object.keys(reg.seen[0].headers).filter((h) => /cookie|authorization|x-pocket/i.test(h)), [], 'nothing about the user is sent');
});

test('the notice needs a login', { timeout: 60000 }, async (t) => {
  const reg = await registry(t);
  const s = await startServer(t, { env: on(reg.url) });
  assert.equal((await s.request('GET', '/api/service')).status, 401);
  assert.equal((await s.request('GET', '/api/service', { cookie: 'pd_guest=nope' })).status, 401, 'a made-up collaborator cookie does not read it');
});

test('a restart inside the day does not ask the registry again', { timeout: 60000 }, async (t) => {
  const reg = await registry(t);
  const first = await startServer(t, { env: on(reg.url) });
  await until(() => fs.existsSync(path.join(first.stateDir, 'update-check.json')));
  assert.equal(reg.seen.length, 1);
  first.proc.kill('SIGTERM');
  await once(first.proc, 'exit');
  const second = await startServer(t, { env: on(reg.url), reuse: first });
  const { cookie } = await second.login();
  assert.equal((await second.request('GET', '/api/service', { cookie })).data.update.latest, '9.9.9', 'the saved answer is used at once');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(reg.seen.length, 1);
});

test('POCKET_DEV_NO_UPDATE_CHECK stops the look-up, and the notice stays away', { timeout: 60000 }, async (t) => {
  const reg = await registry(t);
  const s = await startServer(t, { env: { POCKET_DEV_UPDATE_URL: reg.url, POCKET_DEV_NO_UPDATE_CHECK: '1' } });
  const { cookie } = await s.login();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(reg.seen.length, 0);
  assert.equal((await s.request('GET', '/api/service', { cookie })).data.update, null);
  assert.equal((await s.status()).service.update, null);
});

test('an unreachable registry changes nothing and shows no notice', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: on('http://127.0.0.1:9/latest') });
  const { cookie } = await s.login();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await s.request('GET', '/api/service', { cookie })).data.update, null);
});

test('no newer version: the notice reports available false', { timeout: 60000 }, async (t) => {
  const reg = await registry(t, '0.9.0');
  const s = await startServer(t, { env: on(reg.url) });
  const { cookie } = await s.login();
  await until(async () => (await s.request('GET', '/api/service', { cookie })).data.update !== null);
  assert.equal((await s.request('GET', '/api/service', { cookie })).data.update.available, false);
});

// ---- The command line ---------------------------------------------------------------------------------------------

function cli(t, ...args) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-cli-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const env = isolatedEnv(state, { POCKET_DEV_STATE_DIR: state, POCKET_DEV_UPDATE_URL: 'http://127.0.0.1:9/latest' });
  delete env.POCKET_DEV_CONFIG;
  return spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), ...args], { env, encoding: 'utf8', input: '', timeout: 30000 });
}

test('pocket-dev update on a source checkout says it cannot update itself, and touches nothing', (t) => {
  const r = cli(t, 'update', '--yes');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /source folder .* git pull/s);
});

test('pocket-dev update refuses an unknown option, and help lists the command', (t) => {
  const bad = cli(t, 'update', '--now');
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /Usage: pocket-dev update \[--check\] \[--yes\]/);
  assert.match(cli(t, 'help').stdout, /update \[--check\] \[--yes\]\s+Install the newest Pocket Dev from npm/);
});

test('updateCheck is a setting you can change from the terminal', (t) => {
  assert.match(cli(t, 'help').stdout, /updateCheck\s+Look up new Pocket Dev versions on the npm registry every few hours/);
  assert.equal(cli(t, 'config', 'set', 'updateCheck', 'maybe').status, 2);
});

test('updateNotify is a separate setting for the desktop notification only', (t) => {
  assert.match(cli(t, 'help').stdout, /updateNotify\s+Show a desktop notification on this computer while a newer Pocket Dev is waiting/);
  assert.equal(cli(t, 'config', 'set', 'updateNotify', 'maybe').status, 2);
  assert.equal(cli(t, 'config', 'set', 'updateNotify', 'false').status, 0);
});
