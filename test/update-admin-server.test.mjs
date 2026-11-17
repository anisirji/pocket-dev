import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, until } from './helpers/server.mjs';

// The Admin page's Update button on a real server, with a stand-in registry and a stand-in npm.
async function registry(t, version = '9.9.9') {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/latest`;
}
function fakeNpm(t, { exit = 0, seconds = 0, message = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fake-npm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'npm');
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\necho "added 1 package"\n${message ? `echo "${message}" >&2\n` : ''}sleep ${seconds}\nexit ${exit}\n`, { mode: 0o755 });
  return { file, argv: () => fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n') };
}
const env = (url, extra = {}) => ({ POCKET_DEV_UPDATE_URL: url, POCKET_DEV_NO_UPDATE_CHECK: '0', ...extra });
const view = (s) => s.local('GET', '/api/update').then((r) => r.data);

test('a source checkout shows the new version but the button is off, with the reason', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: env(await registry(t)) });
  await until(async () => (await view(s)).available === true);
  const v = await view(s);
  assert.deepEqual([v.latest, v.canUpdate], ['9.9.9', false]);
  assert.match(v.reason, /source folder/);
  assert.equal((await s.local('POST', '/api/update', {})).status, 409);
});

test('the Update button installs with npm install -g and then says what to do next', { timeout: 60000 }, async (t) => {
  const npm = fakeNpm(t);
  const s = await startServer(t, { env: env(await registry(t), { POCKET_DEV_INSTALL_KIND: 'global', POCKET_DEV_NPM: npm.file }) });
  await until(async () => (await view(s)).canUpdate === true);
  const started = await s.local('POST', '/api/update', {});
  assert.equal(started.status, 202);
  await until(async () => (await view(s)).phase === 'done');
  const v = await view(s);
  assert.match(v.message, /Restart Pocket Dev to finish: pocket-dev start|background service/);
  assert.deepEqual(v.output, ['added 1 package']);
  assert.deepEqual(npm.argv(), ['install', '-g', '@anisirji/pocket-dev@latest']);
  assert.ok((await s.local('GET', '/api/log?filter=changes')).data.some((e) => e.type === 'update-started'), 'the Security log records it');
});

test('a second update while the first runs gets 409', { timeout: 60000 }, async (t) => {
  const npm = fakeNpm(t, { seconds: 2 });
  const s = await startServer(t, { env: env(await registry(t), { POCKET_DEV_INSTALL_KIND: 'global', POCKET_DEV_NPM: npm.file }) });
  await until(async () => (await view(s)).canUpdate === true);
  assert.equal((await s.local('POST', '/api/update', {})).status, 202);
  await until(async () => (await view(s)).phase === 'installing');
  const second = await s.local('POST', '/api/update', {});
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already running/);
  await until(async () => (await view(s)).phase === 'done', 15000);
});

test('a permission error shows the own-folder fix and Pocket Dev is left as it was', { timeout: 60000 }, async (t) => {
  const npm = fakeNpm(t, { exit: 243, message: 'npm error code EACCES' });
  const s = await startServer(t, { env: env(await registry(t), { POCKET_DEV_INSTALL_KIND: 'global', POCKET_DEV_NPM: npm.file }) });
  await until(async () => (await view(s)).canUpdate === true);
  await s.local('POST', '/api/update', {});
  await until(async () => (await view(s)).phase === 'failed');
  const v = await view(s);
  assert.equal(v.denied, true);
  assert.match(v.help.join(' '), /Do not use sudo/);
});

test('only the Admin listener can update: the header is required and the phone port has no such route', { timeout: 60000 }, async (t) => {
  const npm = fakeNpm(t);
  const s = await startServer(t, { env: env(await registry(t), { POCKET_DEV_INSTALL_KIND: 'global', POCKET_DEV_NPM: npm.file }) });
  const { cookie } = await s.login();
  await until(async () => (await view(s)).canUpdate === true);
  assert.equal((await s.request('POST', '/api/update', { adminRequest: true, csrf: false, body: {} })).status, 403, 'no x-pocket-admin header');
  assert.equal((await s.request('POST', '/api/update', { cookie, body: {} })).status, 404, 'the phone port does not have it');
  assert.equal((await s.request('POST', '/api/update', { body: {} })).status, 401, 'and a stranger is not logged in');
  assert.equal((await view(s)).phase, 'idle', 'none of those started anything');
});

test('with the check turned off there is no banner and no update route', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_UPDATE_URL: await registry(t), POCKET_DEV_NO_UPDATE_CHECK: '1', POCKET_DEV_INSTALL_KIND: 'global' } });
  const { cookie } = await s.login();
  const v = await view(s);
  assert.deepEqual([v.enabled, v.available, v.canUpdate], [false, false, false]);
  assert.equal((await s.local('POST', '/api/update', {})).status, 404);
  assert.equal((await s.request('GET', '/api/service', { cookie })).data.update, null);
});

test('the server prints one terminal line when a newer version is known', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: env(await registry(t)) });
  await until(() => /Pocket Dev 9\.9\.9 is available/.test(s.logs()));
  assert.match(s.logs(), /Pocket Dev 9\.9\.9 is available \(you have [^)]+\)\. Update with: /);
});
