import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codexPermissionPlan, requestCodexPermissions } from '../src/chat/codex-permissions.js';
test('native Codex extra permissions show the exact requested access without broadening it', () => {
  const requested = { network: { enabled: true }, fileSystem: { read: ['/outside/read'], write: ['output'], entries: [{ access: 'read', path: { type: 'special', value: { kind: 'project_roots' } } }] } };
  const plan = codexPermissionPlan(requested, path.resolve('/project'));
  assert.match(plan.detail, /Network access/); assert.match(plan.detail, /Read: \/outside\/read/);
  assert.equal(plan.permissions.fileSystem.write[0], path.resolve('/project/output'));
  assert.equal(plan.permissions.fileSystem.entries[0].access, 'read');
  assert.equal(requested.fileSystem.write[0], 'output');
});
test('unknown and ambiguous permission fields fail closed', () => {
  for (const value of [{ futureAccess: true }, { network: { enabled: 'yes' } }, { fileSystem: { arbitrary: '/' } }, { fileSystem: { read: ['bad\u0000path'] } }, { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'unknown', path: '/' } } }] } }]) assert.throws(() => codexPermissionPlan(value, '/project'));
  for (const subpath of ['../private', 'nested/../../private', 'nested\\..\\private', '/private', 'C:\\private']) {
    assert.throws(() => codexPermissionPlan({ fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath } } }] } }, '/project'));
  }
});
test('Never ask, cancellation and denial never grant extra access; approval expires with the turn', async () => {
  const params = { permissions: { network: { enabled: true } } };
  for (const approvalPolicy of ['never', 'untrusted']) {
    let asked = false;
    const reply = await requestCodexPermissions({ settings: { approvalPolicy }, cwd: '/project', emit() {}, ask: async () => { asked = true; return { cancelled: true }; } }, params);
    assert.deepEqual(reply, { permissions: {}, scope: 'turn' }); assert.equal(asked, approvalPolicy !== 'never');
  }
  const reply = await requestCodexPermissions({ settings: { approvalPolicy: 'untrusted' }, cwd: '/project', emit() {}, ask: async () => ({ decision: 'allow' }) }, params);
  assert.deepEqual(reply, { permissions: { network: { enabled: true } }, scope: 'turn' });
});
