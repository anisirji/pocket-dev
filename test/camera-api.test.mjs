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
  assert.equal((await s.request('POST', '/api/camera/start', { cookie, body: { camera: '0' }, csrf: false })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/start', { cookie, body: { camera: '0' }, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/install', { cookie, body: {}, csrf: false })).status, 403);
  assert.equal((await s.request('POST', '/api/camera/install', { cookie, body: {}, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config)), cameraView: false }));
  for (const [method, path, body] of [['GET', ''], ['GET', '/support'], ['POST', '/install', {}], ['POST', '/start', { camera: '0' }], ['GET', '/frame?id=guess']]) {
    const res = await s.request(method, `/api/camera${path}`, { cookie, body });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /cameraView true/);
  }
  // Cleanup works even after the feature is disabled.
  assert.equal((await s.request('POST', '/api/camera/stop', { cookie, body: { id: 'guess' } })).status, 200);
  assert.equal((await s.request('GET', '/api/camera/unknown', { cookie })).status, 404);
});

test('room forwarding retains camera policies and refuses collaborator access', async (t) => {
  const [h, a, b] = await roomOf(t, ['admin', 'admin', 'collaborator'], { env });
  const modes = await h.api('PUT', `/modes/${a.id}`, { mode: 'read-only' });
  assert.equal(modes.status, 200);
  const start = await a.request('POST', `/m/${h.id}/api/camera/start`, { cookie: a.cookie, body: { camera: '0' } });
  assert.equal(start.status, 403);
  assert.equal(start.data.code, 'mode-denied');
  const install = await a.request('POST', `/m/${h.id}/api/camera/install`, { cookie: a.cookie, body: {} });
  assert.equal(install.status, 403);
  assert.equal(install.data.code, 'mode-denied');
  assert.equal((await a.request('POST', `/m/${h.id}/api/camera/stop`, { cookie: a.cookie, body: { id: 'guess' } })).status, 200);
  assert.equal((await h.request('GET', `/m/${b.id}/api/camera`, { cookie: h.cookie })).status, 403);
  assert.equal((await h.request('POST', `/m/${b.id}/api/camera/start`, { cookie: h.cookie, body: { camera: '0' } })).status, 403);
  assert.equal((await h.request('POST', `/m/${b.id}/api/camera/install`, { cookie: h.cookie, body: {} })).status, 403);
});
