import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createCameraSupport, CAMERA_BUILDS } from '../src/setup/camera-support.js';
import { until } from './helpers/server.mjs';

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const exe = Buffer.from('synthetic camera executable');
const archive = gzipSync(exe), license = Buffer.from('fixture license'), readme = Buffer.from('fixture build source');
const build = { sha256: hash(archive), license: hash(license), readme: hash(readme) };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [], probes = [];
  const setup = createCameraSupport({ stateDir: root, os: 'win32', arch: 'x64', override: () => null, find: () => null,
    builds: { 'win32-x64': build },
    probe: async (file, platform) => { probes.push({ file, platform }); return fs.existsSync(file) && fs.readFileSync(file).equals(exe); },
    request: async (url) => {
      requests.push(url);
      const bytes = url.endsWith('.gz') ? archive : url.endsWith('.LICENSE') ? license : readme;
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }, ...options });
  t.after(() => setup.dispose());
  return { setup, root, requests, probes };
}
async function finished(setup) {
  let result;
  await until(async () => (result = await setup.status()).state !== 'installing');
  return result;
}

test('a working existing FFmpeg is reused with no downloads or writes', async (t) => {
  let existing;
  const { setup, requests, root } = fixture(t, { find: () => existing, probe: async (file) => file === existing });
  existing = path.join(root, 'existing.exe');
  fs.writeFileSync(existing, exe);
  const status = await setup.status();
  assert.equal(status.state, 'ready');
  assert.equal(setup.binary(), existing);
  setup.startInstall();
  assert.equal((await finished(setup)).state, 'ready');
  assert.equal(requests.length, 0);
  assert.deepEqual(fs.readdirSync(root), ['existing.exe']);
});

test('Windows install verifies and publishes ffmpeg.exe, license and source details without PATH changes', async (t) => {
  const { setup, requests, root, probes } = fixture(t);
  assert.equal((await setup.status()).state, 'missing');
  assert.equal(requests.length, 0, 'opening the view never downloads anything');
  assert.equal(setup.startInstall().state, 'installing');
  setup.startInstall();
  assert.equal((await finished(setup)).state, 'ready');
  assert.equal(requests.length, 3, 'duplicate clicks share one installation');
  const dir = path.join(root, 'tools', 'camera', 'win32-x64');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'ffmpeg.exe')), exe);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'LICENSE')), license);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'README')), readme);
  assert.equal(setup.binary(), path.join(dir, 'ffmpeg.exe'));
  assert.ok(probes.some((p) => p.platform === 'win32' && p.file.endsWith('ffmpeg.exe')));
});

test('rechecking installed support does not interrupt a live preview using the helper', async (t) => {
  let at = 0, existing, release, recheck = false;
  const { setup, root } = fixture(t, { find: () => existing, now: () => at, probe: async () => {
    if (recheck) await new Promise((resolve) => { release = resolve; });
    return true;
  } });
  existing = path.join(root, 'existing.exe');
  fs.writeFileSync(existing, exe);
  await setup.status();
  at = 31_000; recheck = true;
  const checking = setup.status();
  assert.equal(setup.binary(), existing, 'active capture retains its helper while a status probe runs');
  release();
  assert.equal((await checking).state, 'ready');
});

test('a failed or tampered download is never executed, is cleaned up, and can be retried', async (t) => {
  let broken = true;
  const { setup, probes, root } = fixture(t, { request: async (url) => new Response(url.endsWith('.gz') ? (broken ? Buffer.from('tampered') : archive) : url.endsWith('.LICENSE') ? license : readme) });
  setup.startInstall();
  const failed = await finished(setup);
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /verification failed/);
  assert.equal(probes.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools', 'camera')), []);
  broken = false;
  setup.startInstall();
  assert.equal((await finished(setup)).state, 'ready');
});

test('installed helpers are discovered again after Pocket Dev restarts', async (t) => {
  const { setup, root } = fixture(t);
  setup.startInstall();
  await finished(setup);
  const restarted = createCameraSupport({ stateDir: root, os: 'win32', arch: 'x64', override: () => null, find: () => null,
    probe: async (file) => fs.existsSync(file) && fs.readFileSync(file).equals(exe), request: () => assert.fail('must not download') });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.status()).state, 'ready');
  assert.equal(restarted.binary(), setup.binary());
});

test('automatic install waits for a verified helper and repeated setup reuses it', async (t) => {
  const { setup, requests } = fixture(t);
  const results = await Promise.all([setup.ensureInstalled(), setup.ensureInstalled()]);
  assert.ok(results.every((result) => result.available && result.state === 'ready'));
  assert.equal(requests.length, 3, 'automatic setup shares a single download');
  assert.equal((await setup.ensureInstalled()).available, true);
  assert.equal(requests.length, 3, 'updates do not download the helper again');
});

test('HTTP failures and incompatible builds report a retryable error without publishing a helper', async (t) => {
  const network = fixture(t, { request: async () => new Response('offline', { status: 503 }) });
  network.setup.startInstall();
  assert.match((await finished(network.setup)).message, /HTTP 503/);
  assert.equal(network.setup.binary(), null);
  const incompatible = fixture(t, { probe: async () => false });
  incompatible.setup.startInstall();
  assert.match((await finished(incompatible.setup)).message, /could not run with camera support/);
  assert.equal(incompatible.setup.binary(), null);
});

test('a timed-out download is aborted and leaves no half-installed binary', async (t) => {
  const { setup, root } = fixture(t, { timeoutMs: 20, request: async (url, { signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  setup.startInstall();
  assert.match((await finished(setup)).message, /timed out/);
  assert.equal(setup.binary(), null);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools', 'camera')), []);
});

test('unsupported architectures offer no broken installer; all shipped assets have fixed hashes', async (t) => {
  const { setup } = fixture(t, { arch: 'unknown' });
  assert.equal((await setup.status()).canInstall, false);
  assert.throws(() => setup.startInstall(), /unavailable/);
  for (const build of Object.values(CAMERA_BUILDS)) for (const digest of Object.values(build)) assert.match(digest, /^[0-9a-f]{64}$/);
});
