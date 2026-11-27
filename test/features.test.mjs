import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatures, featureStatus, featureError } from '../src/core/features.js';

test('feature checks are lazy, coalesced and cache invalidation cannot restore stale capability state', async () => {
  let checks = 0, finish;
  const features = createFeatures({ camera: () => { checks++; return new Promise((resolve) => { finish = resolve; }); } });
  assert.equal(checks, 0);
  const first = features.check('camera'), second = features.check('camera');
  await Promise.resolve(); assert.equal(checks, 1);
  features.invalidate('camera'); finish({ state: 'ready' });
  assert.deepEqual(await first, await second);
  const fresh = features.check('camera'); await Promise.resolve(); assert.equal(checks, 2);
  finish({ state: 'permission-required', available: false });
  assert.equal((await fresh).action, 'open-permissions');
  assert.equal((await features.check('camera')).available, false); assert.equal(checks, 2);
  await assert.rejects(features.check('toString'), { status: 404 });
});

test('feature failures are actionable without triggering automatic recovery', async () => {
  let checks = 0;
  const features = createFeatures({ screen: () => { checks++; throw Object.assign(new Error('Allow Screen Recording'), { code: 'PERMISSION_REQUIRED' }); } });
  const result = await features.check('screen');
  assert.equal(result.state, 'permission-required'); assert.equal(result.available, false);
  assert.equal(result.action, 'open-permissions'); assert.equal(checks, 1);
  assert.equal(featureStatus('camera', { state: 'installing' }).state, 'checking');
  assert.equal(featureStatus('camera', { state: 'unsupported' }).recoverable, false);
  assert.equal(featureError('camera', { unsupported: true }).action, null);
});
