import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers/server.mjs';
import { roomOf } from './helpers/room-pair.mjs';

const env = { POCKET_DEV_FFMPEG: '/nonexistent/pocket-dev-ffmpeg' };
test('camera routes require login and mutation protections, and respect the host setting', async (t) => {
  const s = await startServer(t, { env });
  for (const [method, endpoint, body] of [['GET', ''], ['GET', '/support'], ['POST', '/install', {}], ['POST', '/start', { camera: '0' }], ['GET', '/frame?id=guess'], ['POST', '/stop', { id: 'guess' }]]) {
    assert.equal((await s.request(method, `/api/camera${endpoint}`, { body })).status, 401);
  }
  const { cookie } = await s.login();
  assert.equal((await s.request('POST', '/api/camera/prepare', { cookie, body: {} })).status, 404, 'one-time preparation belongs to the local Admin page');
  assert.equal((await s.request('POST', '/api/camera/prepare', { adminRequest: true, body: {}, csrf: false })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/prepare', { adminRequest: true, body: {}, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/start', { cookie, body: { camera: '0' }, csrf: false })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/start', { cookie, body: { camera: '0' }, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/install', { cookie, body: {}, csrf: false })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/install', { cookie, body: {}, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config)), cameraView: false }));
  for (const [method, path, body] of [['POST', '/install', {}], ['POST', '/start', { camera: '0' }], ['GET', '/frame?id=guess']]) {
    const res = await s.request(method, `/api/camera${path}`, { cookie, body });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /disabled in Admin/);
  }
  const videoOff = await s.request('GET', '/api/camera', { cookie });
  assert.deepEqual(videoOff.data.cameras, []); assert.equal(videoOff.data.permissions.camera, false);
  assert.equal((await s.request('GET', '/api/camera/support', { cookie })).data.permissions.microphone, true, 'audio remains independently available');
  // Cleanup works even after the feature is disabled.
  assert.equal((await s.request('POST', '/api/camera/stop', { cookie, body: { id: 'guess' } })).status, 200);
  assert.equal((await s.request('GET', '/api/camera/unknown', { cookie })).status, 404);
});

test('room forwarding retains camera policies and refuses collaborator access', async (t) => {
  const [h, a, b] = await roomOf(t, ['admin', 'admin', 'collaborator'], { env });
  assert.equal((await h.api('PUT', `/modes/${a.id}`, { mode: 'read-only' })).status, 410, 'Room-wide modes have been retired.');
  assert.equal((await a.request('POST', `/m/${h.id}/api/camera/stop`, { cookie: a.cookie, body: { id: 'guess' } })).status, 200);
  assert.equal((await h.request('GET', `/m/${b.id}/api/camera`, { cookie: h.cookie })).status, 403);
  assert.equal((await h.request('POST', `/m/${b.id}/api/camera/start`, { cookie: h.cookie, body: { camera: '0' } })).status, 403);
  assert.equal((await h.request('POST', `/m/${b.id}/api/camera/install`, { cookie: h.cookie, body: {} })).status, 403);
});
