import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer, until } from './helpers/server.mjs';

test('only local Admin changes computer-wide permissions; validation and restart retain revocation', async (t) => {
  let server = await startServer(t); const login = await server.login();
  for (const method of ['GET', 'PUT']) assert.equal((await server.request(method, '/api/remote-permissions', { cookie: login.cookie, ...(method === 'PUT' && { body: { cameraView: true } }) })).status, 404);
  for (const extra of [{ csrf: false }, { headers: { origin: 'https://untrusted.example' } }, { via: 'tunnel' }]) {
    assert.equal((await server.request('PUT', '/api/remote-permissions', { adminRequest: true, body: { cameraView: false }, ...extra })).status, 403);
  }
  for (const body of [{}, { microphoneView: 'false' }, { screenControlApproved: true }, { arbitrary: false }]) assert.equal((await server.local('PUT', '/api/remote-permissions', body)).status, 400);
  const enabled = await server.local('PUT', '/api/remote-permissions', { screenControl: true });
  assert.equal(enabled.data.screenControlApproved, true, 'explicit local enable approves this computer globally');
  const disabled = await server.local('PUT', '/api/remote-permissions', { screenView: false, cameraView: false, microphoneView: false });
  assert.equal(disabled.status, 200); assert.equal(disabled.data.screenControlApproved, false);
  for (const endpoint of ['/api/screen', '/api/screen/control/support', '/api/camera', '/api/camera/support']) {
    const result = await server.request('GET', endpoint, { cookie: login.cookie });
    assert.ok(result.status === 403 || result.data.available === false, endpoint);
  }
  assert.equal((await server.request('POST', '/api/screen/control', { cookie: login.cookie, body: { display: 1 } })).status, 403);
  assert.equal((await server.request('POST', '/api/camera/start', { cookie: login.cookie, body: { media: { video: false, listen: true } } })).status, 403);
  server.proc.kill('SIGTERM'); await once(server.proc, 'exit');
  server = await startServer(t, { reuse: server });
  const after = (await server.local('GET', '/api/remote-permissions')).data;
  assert.equal(after.screenView, false); assert.equal(after.cameraView, false); assert.equal(after.microphoneView, false); assert.equal(after.screenControlApproved, false);
});

test('Admin microphone revocation immediately closes an existing RTC lease and blocks every new login', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-remote-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = path.join(root, 'host-url');
  const server = await startServer(t, { env: { POCKET_DEV_CAMERA_HOST_RECORD: record } });
  const first = await server.login(), second = await server.login({ headers: { 'user-agent': 'A new remote connection' } });
  const start = (cookie) => server.request('POST', '/api/camera/start', { cookie, body: { media: { video: false, listen: true, talk: true } } });
  const opened = await start(first.cookie); assert.equal(opened.status, 200);
  await until(() => fs.existsSync(record));
  const token = new URL(fs.readFileSync(record, 'utf8')).hash.slice(1), messages = [];
  const connect = async (endpoint, headers = {}) => {
    const socket = new WebSocket(server.base.replace('http:', 'ws:') + endpoint, { headers: { origin: server.base, ...headers } });
    t.after(() => socket.terminate()); await once(socket, 'open'); return socket;
  };
  const host = await connect(`/ws/camera-host?token=${token}`);
  host.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw)); });
  const viewer = await connect(`/ws/camera-view?id=${opened.data.id}`, { cookie: first.cookie });
  viewer.send(JSON.stringify({ type: 'rtc-ready' }));
  const closed = once(viewer, 'close');
  assert.equal((await server.local('PUT', '/api/remote-permissions', { microphoneView: false })).status, 200);
  await closed; await until(() => messages.some((message) => message.type === 'viewer-left' && message.viewer === opened.data.id));
  assert.ok(messages.some((message) => message.type === 'stop'));
  assert.equal((await start(first.cookie)).status, 403); assert.equal((await start(second.cookie)).status, 403);
  assert.equal((await server.local('POST', '/api/camera/prepare', { media: { video: false, listen: true } })).status, 403);
  await server.local('PUT', '/api/remote-permissions', { microphoneView: true, cameraView: false });
  assert.equal((await server.request('POST', '/api/camera/start', { cookie: second.cookie, body: {} })).status, 403);
  assert.equal((await start(second.cookie)).status, 200, 'audio-only remains available after explicit global reenable');
  assert.equal((await server.request('GET', `/api/camera/frame?id=${opened.data.id}`, { cookie: first.cookie })).status, 403, 'disabled video has no frame fallback');
});

test('disabling and reenabling screen viewing cannot release a frame already being captured', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-screen-revocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = path.join(root, 'gate'), stub = path.join(root, 'screen-fixture');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2), gate=process.env.POCKET_DEV_SCREEN_GATE;
if(args.includes('--out'))fs.copyFileSync(args[args.indexOf('--out')-1],args.at(-1));
else if(args[0]==='-g')console.log('pixelWidth: 320\\npixelHeight: 200');
else(async()=>{fs.writeFileSync(gate+'.started','1');while(!fs.existsSync(gate))await new Promise(r=>setTimeout(r,20));fs.writeFileSync(args.at(-1),Buffer.from([255,216,1,2,255,217]));})();
`, { mode: 0o700 });
  const server = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'darwin', POCKET_DEV_SCREENCAPTURE: stub, POCKET_DEV_SIPS: stub, POCKET_DEV_SCREEN_GATE: gate } });
  const { cookie } = await server.login();
  const frame = server.request('GET', '/api/screen', { cookie });
  await until(() => fs.existsSync(`${gate}.started`));
  await server.local('PUT', '/api/remote-permissions', { screenView: false });
  await server.local('PUT', '/api/remote-permissions', { screenView: true });
  fs.writeFileSync(gate, 'release');
  const result = await frame;
  assert.equal(result.status, 403); assert.match(result.data.error, /disabled in Admin/);
});
