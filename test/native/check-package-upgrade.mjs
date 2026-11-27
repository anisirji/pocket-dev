// Runs both revisions against one disposable HOME/config. No owner state or global installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../helpers/server.mjs';
const [baseline, candidate] = process.argv.slice(2);
assert.ok(baseline && candidate, 'Pass baseline and installed candidate directories.');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
try {
  const env = { POCKET_DEV_AGY: new URL('../helpers/fake-agy.mjs', import.meta.url).pathname };
  const old = await startServer(t, { repo: baseline, env }), login = await old.login();
  const project = path.join(old.home, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'keep.txt'), 'UPGRADE_FIXTURE_DATA\n');
  await old.local('POST', '/api/permissions/setup', { status: 'skipped' });
  const changed = await old.local('PUT', '/api/settings', { maxDevices: 17 }); assert.equal(changed.status, 200);
  const chat = await old.request('POST', '/api/chat', { cookie: login.cookie, body: { tool: 'antigravity', cwd: project } }); assert.equal(chat.status, 201);
  const before = await old.local('GET', '/api/state');
  const exited = once(old.proc, 'exit'); old.proc.kill('SIGTERM'); await exited;
  const current = await startServer(t, { repo: candidate, reuse: old, env });
  const status = await current.request('GET', '/api/status', { cookie: login.cookie }); assert.equal(status.data.status, 'active');
  const after = await current.local('GET', '/api/state');
  assert.equal(after.data.maxDevices, 17); assert.equal(after.data.permissionsSetup, 'skipped');
  assert.deepEqual(after.data.devices.map((device) => device.id), before.data.devices.map((device) => device.id));
  const chats = await current.request('GET', '/api/chat', { cookie: login.cookie });
  assert.ok(chats.data.some((entry) => entry.id === chat.data.id && entry.cwd === project));
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'UPGRADE_FIXTURE_DATA\n');
  const feature = await current.request('GET', '/api/features/browser', { cookie: login.cookie }); assert.equal(feature.status, 200);
  assert.equal(feature.data.feature, 'browser');
  assert.equal((await current.local('GET', '/api/setup/plan')).status, 200);
  for (const name of ['admin-setup.js', 'screen-control.js', 'notifications-worker.js']) assert.equal((await current.request('GET', '/' + name, { cookie: login.cookie, adminRequest: name === 'admin-setup.js' })).status, 200);
  console.log('PASS baseline → installed Mac package preserves password/login, device IDs, settings, chat and project files; new routes/assets load');
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
