import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auth-network-review-'));
process.env.POCKET_DEV_STATE_DIR = root;
delete process.env.POCKET_DEV_PASSWORD;
const { createAuth } = await import('../auth.js');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function fixture({ legacy = false } = {}) {
  const oldToken = 'old-cookie-for-this-test';
  const devicesFile = path.join(root, 'devices.json');
  fs.rmSync(devicesFile, { force: true });
  if (legacy) fs.writeFileSync(devicesFile, JSON.stringify({ devices: [{ id: 'legacy001', name: 'Old phone', lastSeen: Date.now(), tokenHash: crypto.createHash('sha256').update(oldToken).digest('hex') }] }));
  const state = { password: 'test-password', maxDevices: 20 };
  const config = { read: () => state, update: (patch) => Object.assign(state, patch) };
  const auth = createAuth({ config, port: 7790, urls: () => ({ lan: 'http://192.168.1.4:7790', remote: 'https://pocket.example.test' }) });
  function req(cookie, remote = false) {
    return {
      headers: { host: remote ? 'pocket.example.test' : '192.168.1.4:7790', ...(cookie && { cookie }),
        ...(remote && { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5' }) },
      socket: { remoteAddress: remote ? '127.0.0.1' : '192.168.1.6' },
    };
  }
  async function login(remote = false) {
    const request = { ...req(null, remote), method: 'POST' };
    const result = await auth.handleApi(request, '/api/login', async () => ({ password: 'test-password' }));
    assert.equal(result.status, 200);
    return result.headers['set-cookie'].split(';')[0];
  }
  return { auth, state, req, login, oldCookie: `pd_token=${oldToken}` };
}

function socket() {
  return Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, inbox: [], send(raw) { this.inbox.push(JSON.parse(raw)); }, terminate() { this.readyState = 3; this.emit('close'); } });
}

test('Wi-Fi and internet cookies are bound to their route; handoff is single-use and keeps one device', async () => {
  const { auth, req, login } = fixture();
  const wifiCookie = await login();
  const device = auth.deviceFor(req(wifiCookie));
  assert.equal(auth.deviceFor(req(wifiCookie, true)), undefined, 'a Wi-Fi cookie grants no remote access');
  const arrival = { direction: 'to-remote', host: 'pocket.example.test' };
  const token = auth.mintHandoff(device, arrival);
  const linked = auth.redeemHandoff(req(null, true), token, arrival);
  assert.equal(linked.status, 200);
  assert.match(linked.headers['set-cookie'], /; Secure/);
  const internetCookie = linked.headers['set-cookie'].split(';')[0];
  assert.equal(auth.deviceFor(req(internetCookie, true)).id, device.id);
  assert.equal(auth.deviceFor(req(internetCookie)), undefined);
  assert.equal(auth.admin.state().devices.length, 1);
  assert.equal(auth.redeemHandoff(req(null, true), token, arrival).status, 302);
  assert.equal(auth.admin.deviceAction(device.id, 'block').status, 200);
  assert.equal(auth.deviceFor(req(wifiCookie)), undefined);
  assert.equal(auth.deviceFor(req(internetCookie, true)), undefined);
});

test('legacy cookies remain local and a handoff sent to the wrong route is spent', () => {
  const { auth, req, oldCookie } = fixture({ legacy: true });
  const device = auth.deviceFor(req(oldCookie));
  assert.equal(device.id, 'legacy001');
  assert.equal(auth.deviceFor(req(oldCookie, true)), undefined);
  const target = { direction: 'to-remote', host: 'pocket.example.test' };
  const token = auth.mintHandoff(device, target);
  assert.equal(auth.redeemHandoff(req(null), token, { direction: 'to-lan', host: 'lan' }).status, 302);
  assert.equal(auth.redeemHandoff(req(null, true), token, target).status, 302);
});

test('waiting-login notices reach only tracked owner sockets eligible to approve', async () => {
  const { auth, state, req, login } = fixture();
  const cookie = await login();
  const owner = auth.deviceFor(req(cookie));
  const ownerSocket = socket(), guestSocket = socket();
  auth.trackSocket(owner, ownerSocket);
  state.requireApproval = true;
  await login();
  assert.deepEqual(ownerSocket.inbox, [], 'off by default');
  state.approveFromDevices = true;
  await login();
  assert.equal(ownerSocket.inbox.length, 1);
  assert.equal(ownerSocket.inbox[0].t, 'waiting');
  assert.deepEqual(guestSocket.inbox, [], 'untracked guest sockets never receive owner notices');
  state.roleAccessEnabled = true;
  await login();
  assert.equal(ownerSocket.inbox.length, 1, 'a device without Admin role cannot approve');
  owner.role = 'admin';
  await login();
  assert.equal(ownerSocket.inbox.length, 2);
  state.approveFromDevices = false;
  await login();
  assert.equal(ownerSocket.inbox.length, 2);
});
