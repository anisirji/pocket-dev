import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { pause, startServer } from './helpers/server.mjs';

test('approving a waiting login from a logged-in phone: off by default, Mac-only to turn on, Admin devices only', { timeout: 90000 }, async (t) => {
  const s = await startServer(t);
  const A = await s.login();
  const settingsOf = async (cookie) => (await s.request('GET', '/api/settings', { cookie })).data;
  const statusOf = async (cookie) => (await s.request('GET', '/api/status', { cookie })).data.status;
  assert.equal((await s.local('PUT', '/api/settings', { requireApproval: true })).status, 200);
  const B = await s.login();
  assert.equal(B.data.pending, true);
  const pendingId = async () => (await s.status()).devices.find((d) => d.status === 'pending')?.id;
  const bId = await pendingId();

  // Off by default: the phone sees no waiting list and cannot act, and cannot turn the setting on.
  assert.equal((await s.status()).approveFromDevices, false);
  const before = await settingsOf(A.cookie);
  assert.deepEqual(before.waiting, []);
  assert.equal(before.approveFromDevices, false);
  const refused = await s.request('POST', `/api/devices/${bId}/approve`, { cookie: A.cookie, body: {} });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /off/);
  assert.equal(await statusOf(B.cookie), 'pending');
  assert.equal((await s.request('PUT', '/api/settings/approve-from-devices', { cookie: A.cookie, body: { on: true } })).status, 403, 'a phone cannot widen approval');
  assert.equal((await s.status()).approveFromDevices, false);

  // A page with a terminal open hears about a waiting login once the Mac allows phones to approve.
  assert.equal((await s.local('PUT', '/api/settings', { approveFromDevices: true })).status, 200);
  assert.equal((await s.status()).approveFromDevices, true);
  const session = (await s.request('POST', '/api/sessions', { cookie: A.cookie, body: { cwd: s.home } })).data;
  const ws = new WebSocket(`${s.base.replace('http', 'ws')}/ws/${session.id}`, { headers: { cookie: A.cookie, origin: s.base } });
  const heard = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'waiting') heard.push(m); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const C = await s.login({ headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36' } });
  assert.equal(C.data.pending, true);
  await pause(300);
  const cId = (await s.status()).devices.find((d) => d.status === 'pending' && d.id !== bId).id;
  assert.deepEqual(heard, [{ t: 'waiting', kind: 'Android · Chrome', code: cId.slice(-4) }]);

  // The phone sees the same code the waiting device shows, approves one and denies the other.
  const listed = await settingsOf(A.cookie);
  assert.equal(listed.approveFromDevices, true);
  assert.deepEqual(listed.waiting.map((d) => [d.id, d.code, d.status]).sort(), [[bId, bId.slice(-4), 'pending'], [cId, cId.slice(-4), 'pending']].sort());
  assert.equal((await s.request('GET', '/api/status', { cookie: B.cookie })).data.code, bId.slice(-4), 'the waiting device shows the same code');
  assert.equal((await s.request('POST', `/api/devices/${bId}/approve`, { cookie: B.cookie, body: {} })).status, 403, 'a waiting device cannot approve itself');
  const approved = await s.request('POST', `/api/devices/${bId}/approve`, { cookie: A.cookie, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(await statusOf(B.cookie), 'active');
  assert.equal((await s.request('GET', '/api/chat', { cookie: B.cookie })).status, 200);
  assert.equal((await s.request('POST', `/api/devices/${cId}/deny`, { cookie: B.cookie, body: {} })).status, 200, 'a newly approved owner device may approve too while roles are off');
  assert.equal(await statusOf(C.cookie), 'none');
  const aName = (await settingsOf(A.cookie)).devices.find((d) => d.id === before.currentDeviceId).name;
  const log = (await s.local('GET', '/api/log')).data;
  assert.equal(log.find((e) => e.type === 'device-approved' && e.deviceId === bId).by, `device ${aName} (${before.currentDeviceId.slice(-4)})`);
  assert.ok(log.find((e) => e.type === 'device-denied' && e.deviceId === cId).by.startsWith('device '));
  assert.deepEqual(log.find((e) => e.type === 'device-approval-changed'), { ...log.find((e) => e.type === 'device-approval-changed'), on: true, by: 'admin' });
  assert.equal((await s.request('POST', `/api/devices/${bId}/approve`, { cookie: A.cookie, body: {} })).status, 409, 'an already active device cannot be approved again');
  assert.equal((await s.request('POST', `/api/devices/${bId}/block`, { cookie: A.cookie, body: {} })).status, 404, 'phones may only approve or deny');

  // With roles on, only Admin devices approve: a non-admin device is pending, so it cannot act, nor can a collaborator.
  assert.equal((await s.local('POST', '/api/collaborators/enable', { adminDeviceIds: [before.currentDeviceId] })).status, 200);
  assert.equal(await statusOf(B.cookie), 'pending', 'devices not kept as Admin wait for review');
  assert.equal((await s.request('POST', `/api/devices/${bId}/approve`, { cookie: B.cookie, body: {} })).status, 403);
  const repo = path.join(s.home, 'project');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const grant = await s.request('POST', '/api/collaborators', { cookie: A.cookie, body: { label: 'Reviewer', role: 'viewer', repository: repo, extraFolders: [], ai: false, duration: 3600 } });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  const invite = await s.request('POST', `/api/collaborators/${grant.data.id}/invite`, { cookie: A.cookie, body: {} });
  const token = new URLSearchParams(new URL(invite.data.url).hash.slice(1)).get('token');
  const G = (await s.request('POST', '/api/invitations/accept', { body: { token } })).cookie;
  assert.equal((await s.request('POST', `/api/devices/${bId}/approve`, { cookie: G, body: {} })).status, 403);
  assert.equal((await s.request('GET', '/api/settings', { cookie: G })).status, 403, 'a collaborator never sees the waiting list');
  assert.equal((await s.request('POST', `/api/devices/${bId}/approve`, { cookie: `${G}; ${A.cookie}`, body: {} })).status, 403, 'a guest cookie never falls through to the owner');
  assert.equal(await statusOf(B.cookie), 'pending');
  const asAdmin = await s.request('POST', `/api/devices/${bId}/approve`, { cookie: A.cookie, body: {} });
  assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.data));
  assert.equal(asAdmin.data.role, 'admin');
  assert.equal(await statusOf(B.cookie), 'active');

  // The phone can turn the setting off, and from then on is refused again.
  const D = await s.login();
  assert.equal(D.data.pending, true);
  const dId = await pendingId();
  assert.equal((await s.request('PUT', '/api/settings/approve-from-devices', { cookie: A.cookie, body: { on: false } })).status, 200);
  assert.equal((await s.status()).approveFromDevices, false);
  assert.equal((await s.request('POST', `/api/devices/${dId}/approve`, { cookie: A.cookie, body: {} })).status, 403);
  assert.deepEqual((await settingsOf(A.cookie)).waiting, []);
  assert.equal(await statusOf(D.cookie), 'pending');
  assert.equal((await s.local('POST', `/api/devices/${dId}/approve`, {})).status, 200, 'the Mac still approves');
  assert.equal(JSON.parse(fs.readFileSync(s.config, 'utf8')).approveFromDevices, false);
  const turnedOff = (await s.local('GET', '/api/log')).data.find((e) => e.type === 'device-approval-changed' && e.on === false);
  assert.equal(turnedOff.by, 'phone');
});
