import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createScreenControl } from '../src/machine/screen-control.js';
import { parseScreenInput, inputPython } from '../src/machine/screen-input.js';
import { pause } from './helpers/server.mjs';

function socket() { return Object.assign(new EventEmitter(), { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); }, close() { this.readyState = 3; this.emit('close'); }, message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); } }); }
function fixture(t, options = {}) {
  let time = 10000, available = true, enabled = true;
  const authorized = new Set(['owner', 'other']), actors = [];
  const control = createScreenControl({ now: () => time, intervalMs: 60000, authorized: (owner) => authorized.has(owner), enabled: () => enabled, adapter: {
    support: async () => ({ state: available ? 'ready' : 'permission-required', available, displays: [{ index: 1, id: 123 }], message: 'Fixture permission needed' }),
    start(display, onFault) { const actor = { display, inputs: [], closed: false, ready: Promise.resolve(), input: async (event) => { actor.inputs.push(event); }, check: async () => {}, close() { actor.closed = true; }, fault: onFault }; actors.push(actor); return actor; },
  }, ...options });
  t.after(() => control.close());
  const approve = async () => { const request = await control.request({ id: 'owner', name: 'Fixture phone' }, 1); const approved = await control.approve(request.requestId, true); const host = socket(); control.attachHost(host, approved.hostToken); const owner = socket(); await control.attachOwner('owner', control.status('owner').token, owner); return { request, approved, host, owner }; };
  return { control, authorized, actors, approve, now: () => time, advance: (ms) => { time += ms; }, permission: (value) => { available = value; }, enable: (value) => { enabled = value; } };
}
test('input accepts bounded atomic actions and rejects scripts, held inputs and out-of-display coordinates', () => {
  assert.deepEqual(parseScreenInput({ kind: 'click', x: .5, y: .5, button: 'left' }), { kind: 'click', x: .5, y: .5, button: 'left', count: 1 });
  assert.deepEqual(parseScreenInput({ kind: 'key', key: 'Tab', modifiers: ['command', 'command'] }).modifiers, ['command']);
  assert.equal(parseScreenInput({ kind: 'text', text: 'नमस्ते' }).text, 'नमस्ते');
  for (const event of [{ kind: 'mouseDown', x: .5, y: .5 }, { kind: 'move', x: 2, y: 0 }, { kind: 'scroll', x: .5, y: .5, dx: 0, dy: 10000 }, { kind: 'key', key: 'arbitrary', modifiers: [] }, { kind: 'key', key: 'Enter', command: 'anything' }, { kind: 'text', text: '\u001bcommand' }, { kind: 'text', text: 'a'.repeat(201) }]) assert.throws(() => parseScreenInput(event));
  assert.equal(inputPython({ find: () => '/usr/bin/python3', exists: () => false, env: {} }), null, 'a capability check cannot trigger the macOS Python installer shim');
});
test('input remains off until local approval and a live host indicator; credentials stay scoped to their device', async (t) => {
  const f = fixture(t), request = await f.control.request({ id: 'owner', name: 'Fixture phone' }, 1);
  assert.equal(f.actors.length, 0); assert.equal(f.control.acceptsOwner('owner', '0'.repeat(64)), false);
  assert.equal(f.control.localState().hostToken, undefined); assert.equal(f.control.status('other').token, undefined);
  const approved = await f.control.approve(request.requestId, true);
  assert.equal(f.actors.length, 0); assert.equal(f.control.status('owner').token, undefined, 'a disconnected indicator cannot authorize input');
  const host = socket(); f.control.attachHost(host, approved.hostToken);
  const token = f.control.status('owner').token; assert.ok(token); assert.equal(f.control.acceptsOwner('other', token), false);
  const owner = socket(); await f.control.attachOwner('owner', token, owner); assert.equal(f.control.status('owner').state, 'active');
  owner.message({ t: 'input', seq: 1, at: f.now(), event: { kind: 'click', x: .4, y: .5, button: 'left' } }); await pause(0);
  assert.equal(f.actors[0].inputs.length, 1); host.close(); assert.equal(f.actors[0].closed, true); assert.equal(f.control.status('owner').state, 'off');
  assert.equal(f.control.acceptsOwner('owner', token), false, 'reconnecting never restores the old grant');
});
test('one controller, stale/repeated input refusal and cancellation are isolated by request id', async (t) => {
  const f = fixture(t), { owner, request } = await f.approve();
  await assert.rejects(f.control.request({ id: 'other', name: 'Other' }, 1), { status: 409 });
  f.control.cancel('other', request.requestId); assert.equal(f.control.status('owner').state, 'active');
  f.control.cancel('owner', 'old-request'); assert.equal(f.control.status('owner').state, 'active');
  owner.message({ t: 'input', seq: 1, at: f.now() - 3000, event: { kind: 'key', key: 'Enter' } });
  assert.equal(f.actors[0].inputs.length, 0); assert.equal(f.control.status('owner').state, 'off');
  const next = await f.approve();
  next.owner.message({ t: 'input', seq: 1, at: f.now(), event: { kind: 'key', key: 'Enter' } }); await pause(0);
  next.owner.message({ t: 'input', seq: 1, at: f.now(), event: { kind: 'key', key: 'Enter' } });
  assert.equal(f.actors[1].inputs.length, 1); assert.equal(f.control.status('owner').state, 'off');
});
test('revocation, hidden host, expired heartbeats, permission loss and operator disable stop native input', async (t) => {
  for (const end of ['revoke', 'hidden', 'heartbeat', 'permission', 'disabled']) {
    const f = fixture(t), { owner, host } = await f.approve();
    if (end === 'revoke') f.authorized.delete('owner');
    if (end === 'hidden') host.message({ t: 'hidden' });
    if (end === 'heartbeat') f.advance(9000);
    if (end === 'permission') f.actors[0].fault(new Error('Fixture permission revoked'));
    if (end === 'disabled') f.enable(false);
    owner.message({ t: 'input', seq: 1, at: f.now(), event: { kind: 'text', text: 'must not be typed' } });
    assert.equal(f.control.status('owner').state, 'off', end); assert.equal(f.actors[0].inputs.length, 0, end); assert.equal(f.actors[0].closed, true, end);
  }
});
test('missing permissions and timed-out approvals never start an input adapter', async (t) => {
  const f = fixture(t); f.permission(false);
  await assert.rejects(f.control.request({ id: 'owner', name: 'Fixture' }, 1), /permission needed/); assert.equal(f.actors.length, 0);
  f.permission(true); const request = await f.control.request({ id: 'owner', name: 'Fixture' }, 1); f.advance(61000);
  await assert.rejects(f.control.approve(request.requestId, true), { status: 409 }); assert.equal(f.actors.length, 0);
});
test('malformed socket messages terminate their lease without crashing or injecting input', async (t) => {
  for (const data of [null, [], 'unexpected']) {
    const f = fixture(t), { owner } = await f.approve();
    owner.message(data); assert.equal(f.control.status('owner').state, 'off'); assert.equal(f.actors[0].inputs.length, 0);
  }
});

test('one computer-wide approval covers new authorized connections and restarts until globally revoked', async (t) => {
  let allowed = false;
  const approval = { has: () => allowed, grant: () => { allowed = true; }, revoke: () => { allowed = false; } };
  const first = fixture(t, { approval });
  const request = await first.control.request({ id: 'owner', name: 'First connection' }, 1);
  assert.equal(request.state, 'awaiting-approval');
  const approved = await first.control.approve(request.requestId, true);
  assert.equal(approved.remembered, true); assert.equal(approved.hostToken, undefined);
  const oldToken = first.control.status('owner').token;
  const owner = socket(); await first.control.attachOwner('owner', oldToken, owner);
  assert.equal(first.control.status('owner').state, 'active', 'an open Admin tab is no longer required');
  owner.close(); assert.equal(allowed, true, 'disconnecting does not forget global approval');
  const next = await first.control.request({ id: 'other', name: 'New connection' }, 1);
  assert.equal(next.remembered, true); assert.ok(next.token); assert.notEqual(next.token, oldToken);
  assert.equal(first.control.acceptsOwner('owner', oldToken), false);
  first.control.close();
  const restarted = fixture(t, { approval });
  const resumed = await restarted.control.request({ id: 'owner', name: 'After restart' }, 1);
  assert.equal(resumed.remembered, true);
  const active = socket(); await restarted.control.attachOwner('owner', resumed.token, active);
  restarted.control.revokeCurrent();
  assert.equal(allowed, false); assert.equal(restarted.actors[0].closed, true); assert.equal(active.readyState, 3);
  const blocked = await restarted.control.request({ id: 'other', name: 'Still authorized to log in' }, 1);
  assert.equal(blocked.state, 'awaiting-approval'); assert.equal(blocked.token, undefined);
});
