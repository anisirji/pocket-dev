import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserCamera, localCameraHost, cameraSignal, cameraMedia } from '../src/machine/browser-camera.js';
import { until } from './helpers/server.mjs';

const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
const local = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
test('camera/audio options are explicit and reject ambiguous or empty media requests', () => {
  assert.deepEqual(cameraMedia(), { video: true, listen: false, talk: false });
  assert.deepEqual(cameraMedia({ video: false, listen: true }), { video: false, listen: true, talk: false });
  for (const value of [{ video: false }, { listen: 'yes' }, { audio: true }, []]) assert.throws(() => cameraMedia(value), { status: 400 });
});

test('Admin disables active microphone/WebRTC leases immediately while independent video stays available', async (t) => {
  let audio = true;
  const f = fixture(t, { audioEnabled: () => audio });
  const video = await f.camera.start('video'), host = socket(f.camera), videoViewer = socket();
  f.camera.attachViewer('video', video.id, videoViewer);
  const mic = await f.camera.start('audio', 'default', { video: false, listen: true, talk: true });
  const audioViewer = socket(); f.camera.attachViewer('audio', mic.id, audioViewer); audioViewer.message({ type: 'rtc-ready' });
  audio = false; f.camera.reconcile();
  assert.equal(audioViewer.readyState, 3); assert.equal(videoViewer.readyState, 1);
  assert.ok(host.sent.some((message) => message.type === 'viewer-left' && message.viewer === mic.id));
  assert.equal(f.camera.acceptsViewer('audio', mic.id), false);
  await assert.rejects(f.camera.start('new connection', 'default', { video: false, listen: true }), { status: 403 });
  await assert.rejects(f.camera.start('new connection', 'default', { video: true, talk: true }), { status: 403 });
  audio = true;
  assert.equal(f.camera.acceptsViewer('audio', mic.id), false, 'reenabling never revives an old lease');
});

test('camera revocation closes video and keeps audio-only permission independent for every connection', async (t) => {
  let video = true;
  const f = fixture(t, { videoEnabled: () => video });
  const cam = await f.camera.start('first'), host = socket(f.camera), camViewer = socket(); f.camera.attachViewer('first', cam.id, camViewer);
  const mic = await f.camera.start('second', 'default', { video: false, listen: true }), micViewer = socket(); f.camera.attachViewer('second', mic.id, micViewer);
  video = false; f.camera.reconcile();
  assert.equal(camViewer.readyState, 3); assert.equal(micViewer.readyState, 1);
  assert.equal(host.sent.findLast((message) => message.type === 'start').media.video, false);
  await assert.rejects(f.camera.start('new connection'), { status: 403 });
  f.camera.revokeAll(); assert.equal(micViewer.readyState, 3); assert.equal(host.sent.at(-1).type, 'stop');
});

test('microphone preparation verifies one global permission without capturing a video frame', async (t) => {
  let verified = 0;
  const f = fixture(t, { onMicrophoneVerified: (at) => { verified = at; } });
  f.camera.prepare({ video: false, listen: true, talk: false });
  await until(() => f.opened.length === 1);
  const host = socket(f.camera);
  assert.deepEqual(host.sent[0].media, { video: false, listen: true, talk: false });
  host.message({ type: 'media-ready', media: { video: false, listen: true } });
  await until(() => f.camera.setupStatus().state !== 'testing');
  assert.ok(verified); assert.equal(f.camera.setupStatus().microphoneVerifiedAt, verified);
  assert.equal(host.sent.at(-1).type, 'stop');
  await f.camera.start('a new authorized connection', 'default', { video: false, listen: true });
  assert.equal(f.opened.length, 1, 'the verified host permission is reused across connections');
});
function fixture(t, options = {}) {
  const opened = [];
  const camera = createBrowserCamera({ origin: () => 'http://127.0.0.1:7777', openUrl: (url) => { opened.push(url); return true; }, ...options });
  t.after(() => camera.dispose());
  return { camera, opened, token: () => new URL(opened.at(-1)).hash.slice(1) };
}
function socket(camera) {
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, sent: [], bufferedAmount: 0, send(raw) { ws.sent.push(Buffer.isBuffer(raw) ? Buffer.from(raw) : JSON.parse(raw)); },
    close() { ws.readyState = 3; ws.emit('close'); }, message(body) { ws.emit('message', Buffer.from(JSON.stringify(body)), false); }, image(bytes = jpeg) { ws.emit('message', bytes, true); } });
  if (camera) camera.attachHost(ws);
  return ws;
}
test('audio-only viewers receive no camera frames; fallback and disconnect remove their microphone request', async (t) => {
  const f = fixture(t), video = await f.camera.start('video'), host = socket(f.camera), videoViewer = socket();
  f.camera.attachViewer('video', video.id, videoViewer);
  const audio = await f.camera.start('audio', 'default', { video: false, listen: true, talk: true }), audioViewer = socket();
  f.camera.attachViewer('audio', audio.id, audioViewer);
  assert.deepEqual(host.sent.findLast((message) => message.type === 'start').media, { video: true, listen: true, talk: true });
  assert.deepEqual(host.sent.findLast((message) => message.type === 'viewer').media, { video: false, listen: true, talk: true });
  await assert.rejects(f.camera.frame('audio', audio.id), { status: 400 });
  await assert.rejects(f.camera.frame('unrelated', audio.id), { status: 410 });
  host.image(); assert.ok(videoViewer.sent.some(Buffer.isBuffer)); assert.equal(audioViewer.sent.some(Buffer.isBuffer), false);
  audioViewer.message({ type: 'fallback' });
  assert.equal(host.sent.findLast((message) => message.type === 'start').media, undefined, 'fallback disables audio while keeping the other camera viewer');
  audioViewer.close(); assert.equal(host.sent.at(-1).type === 'stop', false);
  videoViewer.close(); assert.equal(host.sent.at(-1).type, 'stop');
});

test('listing is passive; only Start camera opens the local browser, with a private token', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.camera.devices(), [{ id: 'default', name: 'Default computer camera' }]);
  assert.deepEqual(f.opened, []);
  await assert.rejects(f.camera.start('a', 'arbitrary'), { status: 400 });
  const a = await f.camera.start('a', 'default');
  assert.match(f.opened[0], /^http:\/\/127\.0\.0\.1:7777\/camera-host\.html#[0-9a-f]{64}$/);
  assert.equal(f.camera.acceptsHost(local, f.token()), true);
  assert.equal(f.camera.acceptsHost(local, '0'.repeat(64)), false);
  const ws = socket(f.camera);
  assert.equal(f.camera.acceptsHost(local, f.token()), false, 'another socket cannot replace the active camera host');
  assert.deepEqual(ws.sent[0], { type: 'start', camera: 'default' });
  const pending = f.camera.frame('a', a.id);
  ws.image();
  assert.deepEqual(await pending, jpeg);
});

test('camera requests background launch by default and reuses its connected host', async (t) => {
  const requests = [];
  const f = fixture(t, { openUrl: (url, options) => { requests.push({ url, options }); return true; } });
  await f.camera.devices(); assert.equal(requests.length, 0);
  await f.camera.start('first');
  assert.deepEqual(requests[0].options, { background: true });
  assert.match(requests[0].url, /\/camera-host\.html#[0-9a-f]{64}$/);
  socket(f.camera);
  await f.camera.start('second');
  assert.equal(requests.length, 1, 'another viewer does not reopen or foreground the capture browser');
});

test('camera host credentials are restricted to direct loopback, even with a valid token', async (t) => {
  const f = fixture(t);
  await f.camera.start('a');
  assert.equal(f.camera.acceptsHost({ ...local, socket: { remoteAddress: '192.168.1.4' } }, f.token()), false);
  for (const headers of [{ 'x-forwarded-for': '127.0.0.1' }, { 'cf-connecting-ip': '8.8.8.8' }, { forwarded: 'for=127.0.0.1' }]) {
    assert.equal(localCameraHost({ ...local, headers }), false);
    assert.equal(f.camera.acceptsHost({ ...local, headers }, f.token()), false);
  }
  assert.equal(f.camera.acceptsHost({ ...local, roomPeer: { origin: 'a' } }, f.token()), false);
});

test('viewers share a camera; frames and stop requests remain bound to their device', async (t) => {
  const f = fixture(t);
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  const b = await f.camera.start('b');
  ws.image();
  await assert.rejects(f.camera.frame('b', a.id), { status: 410 });
  f.camera.stop('b', a.id);
  assert.deepEqual(await f.camera.frame('a', a.id), jpeg);
  f.camera.stop('a', a.id);
  assert.equal(ws.sent.some((message) => message.type === 'stop'), false, 'other viewers keep capture running');
  assert.deepEqual(await f.camera.frame('b', b.id), jpeg);
  f.camera.stop('b', b.id);
  assert.equal(ws.sent.at(-1).type, 'stop');
  const c = await f.camera.start('c');
  assert.equal(f.opened.length, 1, 'the existing computer tab is reused');
  ws.image();
  assert.deepEqual(await f.camera.frame('c', c.id), jpeg);
});

test('streaming viewers authenticate by lease owner and exchange only their own signaling', async (t) => {
  const f = fixture(t, { iceServers: () => [] });
  const a = await f.camera.start('a');
  const source = socket(f.camera), viewer = socket();
  assert.equal(f.camera.acceptsViewer('b', a.id), false);
  assert.equal(f.camera.acceptsViewer('a', a.id), true);
  f.camera.attachViewer('a', a.id, viewer);
  for (const invalid of [null, 1, 'invalid', []]) { source.message(invalid); viewer.message(invalid); }
  assert.equal(f.camera.acceptsViewer('a', a.id), false);
  source.message({ type: 'signal', viewer: a.id, description: { type: 'offer', sdp: 'offer-data' } });
  assert.deepEqual(viewer.sent.at(-1), { type: 'signal', description: { type: 'offer', sdp: 'offer-data' } });
  viewer.message({ type: 'signal', description: { type: 'answer', sdp: 'answer-data' } });
  assert.deepEqual(source.sent.at(-1), { type: 'signal', viewer: a.id, description: { type: 'answer', sdp: 'answer-data' } });
  source.image();
  assert.deepEqual(viewer.sent.at(-1), jpeg, 'JPEGs are pushed without per-frame requests');
  viewer.message({ type: 'rtc-ready' });
  const before = viewer.sent.length;
  source.image();
  assert.equal(viewer.sent.length, before, 'native video stops redundant JPEG delivery');
  viewer.message({ type: 'fallback' });
  viewer.bufferedAmount = 300 * 1024;
  source.image();
  assert.equal(viewer.sent.length, before, 'slow relay clients do not accumulate stale frames');
  viewer.bufferedAmount = 0;
  source.image();
  assert.deepEqual(viewer.sent.at(-1), jpeg);
  viewer.close();
  assert.equal(source.sent.at(-1).type, 'stop');
});

test('SDP direction and ICE payloads are bounded before forwarding', () => {
  assert.equal(cameraSignal(null, 'offer'), null);
  assert.equal(cameraSignal({ description: { type: 'offer', sdp: 'x' } }, 'answer'), null);
  assert.equal(cameraSignal({ description: { type: 'offer', sdp: 'x'.repeat(129 * 1024) } }, 'offer'), null);
  assert.equal(cameraSignal({ candidate: { candidate: 'x'.repeat(4097) } }, 'offer'), null);
  assert.deepEqual(cameraSignal({ candidate: null }, 'offer'), { candidate: null });
});

test('relay acknowledgements bound outstanding frames and keepalives retain the viewer lease', async (t) => {
  let at = 0;
  const f = fixture(t, { now: () => at });
  const a = await f.camera.start('a');
  const source = socket(f.camera), viewer = socket();
  f.camera.attachViewer('a', a.id, viewer);
  viewer.message({ type: 'fallback' });
  const frames = () => viewer.sent.filter(Buffer.isBuffer).length;
  for (let n = 0; n < 10; n++) source.image();
  assert.equal(frames(), 3, 'unacknowledged images never build an unbounded queue');
  viewer.message({ type: 'frame-ack' });
  source.image();
  assert.equal(frames(), 4, 'decoding an image makes room for the newest frame');
  at = 10_000; viewer.message({ type: 'keepalive' });
  at = 20_000; viewer.message({ type: 'keepalive' });
  assert.equal(viewer.readyState, 1, 'a live viewer survives beyond the initial idle deadline');
  at = 36_000;
  assert.equal(f.camera.acceptsViewer('a', a.id), false);
  assert.equal(viewer.readyState, 3, 'a lost viewer releases capture after the idle deadline');
  assert.equal(source.sent.at(-1).type, 'stop');
});

test('browser device names become selectable without opening a second tab', async (t) => {
  const f = fixture(t);
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  ws.message({ type: 'devices', cameras: [{ id: 'built-in', name: 'FaceTime HD' }, { id: 'usb', name: 'USB camera' }], activeId: 'built-in' });
  assert.equal((await f.camera.devices())[1].name, 'FaceTime HD');
  await assert.rejects(f.camera.start('b', 'usb'), { status: 409 });
  f.camera.stop('a', a.id);
  await f.camera.start('a', 'usb');
  assert.deepEqual(ws.sent.at(-1), { type: 'start', camera: 'usb' });
  assert.equal(f.opened.length, 1);
});

test('browser permission failures reach the phone, and closed tabs can be reopened', async (t) => {
  const f = fixture(t);
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  const pending = f.camera.frame('a', a.id);
  ws.message({ type: 'error', message: 'Camera access was blocked. Allow it in the computer browser.' });
  await assert.rejects(pending, /Allow it in the computer browser/);
  f.camera.stop('a', a.id);
  ws.close();
  const old = f.token();
  await f.camera.start('a');
  assert.equal(f.opened.length, 2);
  assert.notEqual(f.token(), old);
  assert.equal(f.camera.acceptsHost(local, old), false);
});

test('first-frame waits retain the viewer lease, but aborts and timeouts stop capture', async (t) => {
  let at = 0;
  const f = fixture(t, { now: () => at, idleMs: 100, firstFrameMs: 1000 });
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  const pending = f.camera.frame('a', a.id);
  at = 200;
  await new Promise((r) => setTimeout(r, 120));
  ws.image();
  assert.deepEqual(await pending, jpeg, 'waiting for the browser permission prompt does not expire the lease');
  f.camera.stop('a', a.id);
  const b = await f.camera.start('a');
  const controller = new AbortController();
  const aborted = f.camera.frame('a', b.id, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, /closed/);
  assert.equal(ws.sent.at(-1).type, 'stop');
  const timeout = fixture(t, { firstFrameMs: 20 });
  const c = await timeout.camera.start('c');
  const ws2 = socket(timeout.camera);
  await assert.rejects(timeout.camera.frame('c', c.id), /allow camera access in the Pocket Dev camera browser tab/);
  assert.equal(ws2.sent.at(-1).type, 'stop');
});

test('stale frames, idle viewers and disabled access release the computer camera', async (t) => {
  let at = 0, enabled = true;
  const f = fixture(t, { now: () => at, enabled: () => enabled });
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  ws.image(); at = 6000;
  await assert.rejects(f.camera.frame('a', a.id), /stopped sending/);
  const b = await f.camera.start('a');
  ws.image(); at += 16_000;
  await assert.rejects(f.camera.frame('a', b.id), { status: 410 });
  await f.camera.start('a');
  enabled = false;
  await assert.rejects(f.camera.frame('a', b.id), { status: 403 });
  assert.equal(ws.sent.at(-1).type, 'stop');
});

test('a computer-side Stop ends viewing; invalid JPEGs cannot reach the phone', async (t) => {
  const f = fixture(t);
  const a = await f.camera.start('a');
  const ws = socket(f.camera);
  const pending = f.camera.frame('a', a.id);
  ws.image(Buffer.from('not a camera JPEG'));
  await assert.rejects(pending, /invalid camera image/);
  const b = await f.camera.start('a');
  const stopped = f.camera.frame('a', b.id);
  ws.message({ type: 'stopped' });
  await assert.rejects(stopped, /stopped on the computer|session ended/);
});

test('one-time setup verifies a frame, records readiness and stops; later remote starts require no setup action', async (t) => {
  const verified = [];
  const f = fixture(t, { onVerified: (at) => verified.push(at) });
  assert.equal(f.camera.setupStatus().state, 'not-set-up');
  assert.equal(f.camera.prepare().state, 'testing');
  assert.equal(f.camera.prepare().state, 'testing', 'duplicate setup does not open another browser');
  await Promise.resolve();
  const ws = socket(f.camera);
  ws.image();
  await until(() => f.camera.setupStatus().state === 'verified');
  assert.equal(verified.length, 1);
  assert.equal(ws.sent.at(-1).type, 'stop', 'setup does not leave the camera capturing');
  const remote = await f.camera.start('phone-away-from-home');
  ws.image();
  assert.deepEqual(await f.camera.frame('phone-away-from-home', remote.id), jpeg);
  assert.equal(f.opened.length, 1, 'the unattended browser host is reused automatically');
  assert.throws(() => f.camera.prepare(), { status: 409 }, 'setup cannot interrupt another camera viewer');
});

test('saved verification survives a service restart; failed setup is retryable', async (t) => {
  const saved = fixture(t, { verifiedAt: () => 1234 });
  assert.equal(saved.camera.setupStatus().state, 'verified');
  assert.equal(saved.camera.setupStatus().verifiedAt, 1234);
  const f = fixture(t, { setupFrameMs: 20 });
  f.camera.prepare();
  await Promise.resolve();
  const ws = socket(f.camera);
  await until(() => f.camera.setupStatus().state === 'error');
  assert.match(f.camera.setupStatus().error, /No camera image arrived/);
  assert.equal(ws.sent.at(-1).type, 'stop');
  f.camera.prepare();
  await Promise.resolve();
  ws.image();
  await until(() => f.camera.setupStatus().state === 'verified');
});
