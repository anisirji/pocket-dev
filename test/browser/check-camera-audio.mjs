// Actual WebRTC audio using Chromium's synthetic devices; no physical camera, microphone or speaker is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) }, root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-audio-'));
let browser, phone, host;
try {
  const record = path.join(root, 'host-url'), server = await startServer(t, { env: { POCKET_DEV_CAMERA_HOST_RECORD: record } });
  fs.writeFileSync(server.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(server.config)), cameraIceServers: [] }));
  const login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  const instrumentation = (generatedMedia = false) => {
    localStorage.setItem('pd-welcome-shown', '1'); window.mediaRequests = []; window.mediaTracks = []; window.mediaPeers = [];
    // Some Windows browser builds end their built-in fake camera immediately.
    // This opt-in tests the actual RTC pipeline with generated browser tracks;
    // it does not claim getUserMedia or physical-device permission coverage.
    const get = generatedMedia ? async (constraints) => {
      const tracks = [];
      if (constraints.video) {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
        const draw = () => { const ctx = canvas.getContext('2d'); ctx.fillStyle = '#285a83'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#fff'; ctx.fillText(String(performance.now()), 12, 30); };
        draw(); const timer = setInterval(draw, 66), track = canvas.captureStream(15).getVideoTracks()[0], stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); }; tracks.push(track);
      }
      if (constraints.audio) {
        const audio = new AudioContext(), source = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        source.connect(destination); source.start(); await audio.resume();
        const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
        track.stop = () => { if (track.readyState === 'ended') return; stop(); source.stop(); audio.close().catch(() => {}); }; tracks.push(track);
      }
      return new MediaStream(tracks);
    } : navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { window.mediaRequests.push({ video: constraints.video !== false, audio: constraints.audio !== false }); const stream = await get(constraints); window.mediaTracks.push(...stream.getTracks()); if (constraints.audio && window.delayMicrophone) await new Promise((resolve) => { window.releaseMicrophone = resolve; }); return stream; };
    const Native = RTCPeerConnection; window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.mediaPeers.push(this); } };
    const NativeSocket = WebSocket; window.mediaSockets = []; window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); if (String(args[0]).includes('/ws/camera-view')) window.mediaSockets.push(this); } };
  };
  const generatedMedia = process.env.POCKET_DEV_TEST_GENERATED_MEDIA === '1';
  await context.addInitScript(instrumentation, generatedMedia); phone = await context.newPage(); const errors = []; phone.on('pageerror', (error) => errors.push(String(error)));
  await phone.goto(server.base); await phone.waitForFunction(() => typeof openCameraSheet === 'function'); await phone.evaluate(() => openCameraSheet());
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click(); await until(() => fs.existsSync(record));
  const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] }); await hostContext.addInitScript(instrumentation, generatedMedia);
  host = await hostContext.newPage(); host.on('pageerror', (error) => errors.push(String(error))); await host.goto(fs.readFileSync(record, 'utf8'));
  const ready = () => phone.waitForFunction(() => !document.querySelector('.camera-audio-controls button[aria-pressed]').disabled);
  await ready();
  assert.equal(await phone.evaluate(() => mediaRequests.length), 0, 'opening video never captures the phone microphone');
  assert.equal(await host.evaluate(() => mediaRequests.filter((request) => request.audio).length), 0, 'camera permission does not request the computer microphone');
  const talk = phone.getByRole('button', { name: 'Hold to speak', exact: true });
  let box = await talk.boundingBox(); await phone.mouse.move(box.x + 10, box.y + 10); await phone.mouse.down();
  await until(async () => host.evaluate(async () => { const peer = mediaPeers.findLast((peer) => peer.connectionState === 'connected'); const stats = await peer?.getStats(); return stats && [...stats.values()].some((value) => value.type === 'inbound-rtp' && value.kind === 'audio' && value.bytesReceived > 0); }), 15000);
  // A browser without native capture or prior activation may block speaker autoplay.
  // Exercise the real local activation fallback instead of bypassing browser policy.
  await host.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.srcObject && !audio.paused) || !document.getElementById('speaker').hidden);
  if (await host.getByRole('button', { name: 'Enable speaker playback', exact: true }).isVisible()) {
    await phone.locator('.camera-error').filter({ hasText: 'Enable speaker playback' }).waitFor();
    await host.getByRole('button', { name: 'Enable speaker playback', exact: true }).click();
  }
  await host.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.srcObject && !audio.paused));
  await phone.mouse.up(); await phone.waitForFunction(() => mediaTracks.every((track) => track.readyState === 'ended'));
  assert.equal(await host.evaluate(() => mediaRequests.filter((request) => request.audio).length), 0, 'speaking works without enabling Listen or capturing the computer microphone');
  await phone.getByLabel('Listen', { exact: true }).check();
  await ready(); await host.waitForFunction(() => document.getElementById('state').textContent.includes('Microphone on'));
  await until(async () => phone.evaluate(async () => { const peer = mediaPeers.findLast((peer) => peer.connectionState === 'connected'); const stats = await peer?.getStats(); return stats && [...stats.values()].some((value) => value.type === 'inbound-rtp' && value.kind === 'audio' && value.bytesReceived > 0); }), 15000);
  box = await talk.boundingBox(); await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await phone.mouse.down();
  await phone.waitForFunction(() => mediaTracks.some((track) => track.kind === 'audio' && track.enabled && track.readyState === 'live'));
  await until(async () => host.evaluate(async () => { const peer = mediaPeers.findLast((peer) => peer.connectionState === 'connected'); const stats = await peer?.getStats(); return stats && [...stats.values()].some((value) => value.type === 'inbound-rtp' && value.kind === 'audio' && value.bytesReceived > 0); }), 15000);
  await host.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.srcObject && !audio.paused));
  await phone.mouse.move(2, 2); await phone.mouse.up();
  await phone.waitForFunction(() => mediaTracks.every((track) => track.kind !== 'audio' || (!track.enabled && track.readyState === 'ended')));
  assert.equal(await talk.getAttribute('aria-pressed'), 'false', 'releasing outside the button mutes immediately');
  // A permission response that arrives after release must not start transmitting.
  await phone.evaluate(() => { window.delayMicrophone = true; }); box = await talk.boundingBox(); await phone.mouse.move(box.x + 10, box.y + 10); await phone.mouse.down();
  await phone.waitForFunction(() => typeof window.releaseMicrophone === 'function'); await phone.mouse.up(); await phone.evaluate(() => { window.delayMicrophone = false; window.releaseMicrophone(); });
  await phone.waitForFunction(() => mediaTracks.every((track) => track.kind !== 'audio' || track.readyState === 'ended'));
  assert.match(await phone.locator('.camera-talk-hint').innerText(), /Hold to speak again/);
  // Revocation ends the direct WebRTC path as well as the signaling/relay path.
  assert.equal((await server.local('PUT', '/api/remote-permissions', { microphoneView: false })).status, 200);
  await phone.waitForFunction(() => mediaTracks.every((track) => track.readyState === 'ended'));
  await host.waitForFunction(() => mediaTracks.every((track) => track.readyState === 'ended'));
  assert.equal((await server.request('POST', '/api/camera/start', { cookie: login.cookie, body: { media: { video: false, listen: true } } })).status, 403);
  await server.local('PUT', '/api/remote-permissions', { microphoneView: true });
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click(); await ready();
  await phone.getByLabel('Camera', { exact: true }).uncheck();
  await ready(); await host.waitForFunction(() => document.getElementById('state').textContent.startsWith('Camera off') && document.getElementById('state').textContent.includes('Microphone on'));
  assert.equal(await host.evaluate(() => mediaTracks.filter((track) => track.kind === 'video').every((track) => track.readyState === 'ended')), true, 'audio-only releases the camera');
  await server.local('PUT', '/api/remote-permissions', { cameraView: false });
  assert.equal((await server.request('POST', '/api/camera/start', { cookie: login.cookie, body: {} })).status, 403);
  assert.equal(await host.evaluate(() => mediaTracks.some((track) => track.kind === 'audio' && track.readyState === 'live')), true, 'independent audio-only access survives camera revocation');
  await server.local('PUT', '/api/remote-permissions', { cameraView: true });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await host.getByRole('button', { name: 'Stop camera & audio', exact: true }).click();
  await phone.waitForFunction(() => document.querySelector('.camera-controls button:nth-of-type(2)').disabled);
  assert.equal(await host.evaluate(() => mediaTracks.every((track) => track.readyState === 'ended')), true, 'host Stop releases every capture track');
  assert.equal(await phone.evaluate(() => mediaTracks.every((track) => track.readyState === 'ended')), true);
  // Refusing the computer microphone preserves camera viewing and never retries permission by itself.
  await host.evaluate(() => { const get = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = (constraints) => constraints.audio ? Promise.reject(new DOMException('Fixture microphone denial', 'NotAllowedError')) : get(constraints); });
  await phone.getByLabel('Camera', { exact: true }).check(); await phone.getByRole('button', { name: 'Start camera', exact: true }).click(); await ready();
  await phone.locator('.camera-error').filter({ hasText: 'Computer microphone access' }).waitFor();
  assert.match(await host.locator('#state').innerText(), /Camera on · Microphone off/);
  await until(async () => await phone.locator('.camera-sheet').getAttribute('data-stream-transport') === 'rtc');
  box = await talk.boundingBox(); await phone.mouse.move(box.x + 10, box.y + 10); await phone.mouse.down();
  await phone.waitForFunction(() => mediaTracks.some((track) => track.kind === 'audio' && track.enabled && track.readyState === 'live'));
  await phone.evaluate(() => mediaSockets.at(-1).close());
  await phone.waitForFunction(() => mediaTracks.every((track) => track.readyState === 'ended'));
  await host.waitForFunction(() => mediaTracks.every((track) => track.readyState === 'ended'));
  await phone.mouse.up();
  assert.deepEqual(errors, []); console.log('PASS actual two-way synthetic WebRTC audio, explicit independent capture, push-to-talk release/late permission, audio-only mode and host Stop');
} catch (failure) {
  console.error(JSON.stringify({ phone: await phone?.evaluate(() => ({ status: document.querySelector('.camera-status')?.textContent, error: document.querySelector('.camera-error')?.textContent, mediaRequests, listen: document.querySelector('.camera-audio-controls label:nth-child(2) input')?.checked, peers: mediaPeers.map((peer) => peer.connectionState) })).catch(() => null), host: await host?.evaluate(() => ({ state: document.getElementById('state')?.textContent, error: document.getElementById('error')?.textContent, mediaRequests, peers: mediaPeers.map((peer) => peer.connectionState) })).catch(() => null) }));
  throw failure;
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
