import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, WorkspaceCache, WorkspaceContext, sensitivePath, within } from '../public/workspace-core.js';
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('workspace reads deduplicate, promote queued work and reserve capacity for interactions', async () => {
  const scheduler = new Scheduler(2), order = []; let release;
  const a = scheduler.read('slow', () => new Promise((r) => { release = r; }), 3); await tick();
  const b = scheduler.read('preload', () => { order.push('promoted'); return 2; }, 3);
  const promoted = scheduler.read('preload', () => assert.fail('duplicate'), 0); assert.equal(b, promoted);
  assert.equal(await promoted, 2); assert.deepEqual(order, ['promoted']); release(1); assert.equal(await a, 1);
});
test('workspace switches cancel obsolete reads and reject their delayed responses', async () => {
  const scheduler = new Scheduler(1); let release;
  const old = scheduler.read('old', () => new Promise((r) => { release = r; })); await tick();
  const rejection = assert.rejects(old, { name: 'AbortError' }); scheduler.cancelReads(); release('stale'); await rejection;
  assert.equal(await scheduler.read('new', () => 'new'), 'new');
});
test('cache snapshots isolate users and workspaces, omit secrets and preserve drafts during eviction', async () => {
  const a = new WorkspaceCache('user-A/device-A', { maxBytes: 1000 }), b = new WorkspaceCache('user-B/device-A');
  await a.put('/app', { tabs: [{ path: '/app/index.js', content: 'draft', saved: 'base' }, { path: '/app/.env', content: 'SECRET' }] });
  assert.equal((await a.get('/app')).tabs.length, 1); assert.equal(await b.get('/app'), null); assert.equal(await a.get('/other'), null);
  await a.put('/large', { tabs: [{ path: '/large/a', content: 'x'.repeat(2000), saved: 'x'.repeat(2000) }] });
  assert.equal(await a.get('/large'), null); assert.equal((await a.get('/app')).tabs[0].content, 'draft');
  await a.clear(); assert.equal(await a.get('/app'), null);
});
test('workspace contexts fence stale updates and paths respect directory boundaries', () => {
  const c = new WorkspaceContext(); c.set({ deviceId: 'A', rootPath: '/app' }); const valid = c.capture();
  c.update({ activeFileId: '/app/a' }); assert.ok(valid()); c.set({ deviceId: 'B', rootPath: '/app' }); assert.equal(valid(), false);
  assert.equal(within('/application/a', '/app'), false); assert.equal(within('C:\\app\\src\\a', 'C:\\app'), true);
  for (const path of ['/app/.env.local', '/app/id_rsa', '/app/key.pem']) assert.equal(sensitivePath(path), true);
});
