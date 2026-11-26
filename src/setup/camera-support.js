import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STATE_DIR } from '../core/paths.js';
import { findBin } from '../chat/env.js';

// Fixed upstream release and SHA-256 digests, checked before executing any downloaded file.
// Source/build details and licenses: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
const BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const GPL = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
export const CAMERA_BUILDS = {
  'win32-x64': { sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', license: GPL, readme: 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311' },
  'darwin-arm64': { sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', license: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2', readme: '05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a' },
  'darwin-x64': { sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', license: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af', readme: 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36' },
  'linux-x64': { sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', license: GPL, readme: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537' },
  'linux-arm64': { sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', license: GPL, readme: 'd6777d2fd276b23f0ac6666fa619e88ffe4826521881c7ff83836e30cb4acec2' },
  'linux-arm': { sha256: '64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172', license: GPL, readme: 'faaea83a6d92419cb112d5de5ac673f51b72401830e068c4d003b3229ee1c89a' },
  'linux-ia32': { sha256: '169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00', license: GPL, readme: '3bbce64eba997007b3fd5324bb105f10ab6b0a499796c7d34b844b51fda0528b' },
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const INPUTS = { win32: 'dshow', darwin: 'avfoundation', linux: 'video4linux2' };

export function probeCameraSupport(file, os = process.platform) {
  return new Promise((resolve) => {
    execFile(file, ['-hide_banner', '-devices'], { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(!err && new RegExp(`^\\s*D\\s+[^\\r\\n]*\\b${INPUTS[os]}\\b`, 'm').test(`${stdout}\n${stderr}`));
    });
  });
}

export function createCameraSupport({ stateDir = STATE_DIR, os = process.platform, arch = process.arch,
  override = () => process.env.POCKET_DEV_FFMPEG, find = () => findBin('ffmpeg'), probe = probeCameraSupport,
  request = fetch, builds = CAMERA_BUILDS, base = BASE, timeoutMs = 5 * 60_000, now = Date.now } = {}) {
  const key = `${os}-${arch}`;
  const build = builds[key];
  const dir = path.join(stateDir, 'tools', 'camera', key);
  const filename = os === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const managed = path.join(dir, filename);
  let ready = null, checkedAt = 0, checking = null, job = null, aborter = null, disposed = false;
  let progress = { state: 'missing', receivedBytes: 0, totalBytes: null, message: '' };
  const permitted = () => Boolean(build && INPUTS[os]);
  const binary = () => ready && fs.existsSync(ready) ? ready : null;

  async function detect() {
    if (binary() && now() - checkedAt < 30_000) return ready;
    let found = null;
    const candidates = [override(), fs.existsSync(managed) ? managed : null, find()].filter(Boolean);
    for (const file of new Set(candidates)) {
      if (await probe(file, os)) { found = file; checkedAt = now(); break; }
    }
    ready = found;
    return ready;
  }
  function view() {
    return { ...progress, available: Boolean(binary()), canInstall: permitted() && !disposed };
  }
  async function status() {
    if (job) return view();
    checking ??= detect().finally(() => { checking = null; });
    const found = await checking;
    if (job) return view();
    if (found) progress = { state: 'ready', message: 'Camera support is ready.', receivedBytes: 0, totalBytes: null };
    else if (progress.state !== 'error') progress = { ...progress, state: permitted() ? 'missing' : 'unsupported',
      message: permitted() ? 'Install camera support to use this computer’s camera.' : 'Automatic camera setup is unavailable for this system. An installed FFmpeg with camera support can still be used.' };
    return view();
  }
  async function download(name, destination, expectedHash, limit, signal, report = false) {
    const response = await request(`${base}/${name}`, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length')) || null;
    if (total > limit) { await response.body.cancel(); throw new Error('The camera support download is too large.'); }
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > limit) return callback(new Error('The camera support download is too large.'));
      hash.update(chunk);
      if (report) progress = { state: 'installing', message: 'Downloading camera support…', receivedBytes: received, totalBytes: total };
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    if (hash.digest('hex') !== expectedHash) throw new Error('Camera support verification failed. Please retry the download.');
  }
  async function install() {
    let stage;
    aborter = new AbortController();
    const signal = AbortSignal.any([aborter.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      if (await detect()) { progress = { ...progress, state: 'ready', message: 'Camera support is already installed.' }; return; }
      if (disposed) throw new Error('Pocket Dev is stopping.');
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      stage = fs.mkdtempSync(path.join(path.dirname(dir), `.${key}-`));
      const archive = path.join(stage, 'ffmpeg.gz');
      await download(`ffmpeg-${key}.gz`, archive, build.sha256, 100 * 1024 * 1024, signal, true);
      progress = { ...progress, message: 'Preparing camera support…' };
      const exe = path.join(stage, filename);
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > 200 * 1024 * 1024 ? new Error('The camera support file is too large.') : null, chunk);
      } });
      await pipeline(fs.createReadStream(archive), createGunzip(), limit, fs.createWriteStream(exe, { flags: 'wx', mode: 0o700 }), { signal });
      fs.rmSync(archive);
      await download(`${key}.LICENSE`, path.join(stage, 'LICENSE'), build.license, 256 * 1024, signal);
      await download(`${key}.README`, path.join(stage, 'README'), build.readme, 256 * 1024, signal);
      progress = { ...progress, message: 'Checking camera support…' };
      if (!await probe(exe, os)) throw new Error('The downloaded helper could not run with camera support on this computer.');
      signal.throwIfAborted();
      // Publish only a completely downloaded, verified and runnable helper.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(stage, dir);
      stage = null;
      ready = managed; checkedAt = now();
      progress = { ...progress, state: 'ready', message: 'Camera support installed. Choose a camera to start.' };
    } catch (err) {
      progress = { ...progress, state: 'error', message: signal.aborted ? 'Camera support installation timed out or was interrupted. Try again.' : `Could not install camera support. ${err.message}` };
    } finally {
      if (stage) {
        try { fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch { progress = { ...progress, state: 'error', message: `${progress.message} Restart Pocket Dev to finish cleaning up temporary files.` }; }
      }
      aborter = null;
    }
  }
  function startInstall() {
    if (disposed) throw fail(503, 'Pocket Dev is stopping. Try again after it restarts.');
    if (job) return view();
    if (binary()) return view();
    if (!permitted()) throw fail(503, 'Automatic camera setup is unavailable for this system.');
    progress = { state: 'installing', receivedBytes: 0, totalBytes: null, message: 'Checking camera support…' };
    // Installation outlives a phone request or closed sheet. Only one job runs on this server.
    job = install().finally(() => { job = null; });
    return view();
  }
  async function ensureInstalled() {
    const current = await status();
    if (current.available || !current.canInstall) return current;
    startInstall();
    await job;
    return status();
  }
  return { status, binary, startInstall, ensureInstalled, dispose() { disposed = true; aborter?.abort(); } };
}

// The default browser capture needs no helper. Global installs prepare FFmpeg only for an
// explicitly selected legacy backend. Download failure never fails Pocket Dev's own install.
export async function postinstallCamera(env = process.env, { createSupport = createCameraSupport, stateDir = STATE_DIR,
  readFile = (file) => fs.readFileSync(file, 'utf8'), log = (line) => console.log(line) } = {}) {
  if (env.npm_config_global !== 'true' || env.CI || env.POCKET_DEV_NO_CAMERA_INSTALL === '1') return;
  let support;
  try {
    const dir = env.POCKET_DEV_STATE_DIR || stateDir;
    const configFile = env.POCKET_DEV_CONFIG || path.join(dir, 'config.json');
    let settings = {};
    try { settings = JSON.parse(readFile(configFile)); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (settings.cameraView === false) return;
    if (settings.cameraBackend !== 'ffmpeg') {
      log('Pocket Dev: camera uses the computer browser. No camera helper installation needed.');
      return;
    }
    support = createSupport({ stateDir: dir });
    const before = await support.status();
    if (before.available) { log('Pocket Dev: existing camera support is ready.'); return; }
    if (!before.canInstall) { log('Pocket Dev: automatic camera setup is unavailable on this system.'); return; }
    log('Pocket Dev: installing camera support…');
    const after = await support.ensureInstalled();
    if (!after.available) throw new Error('Camera support setup did not finish.');
    log('Pocket Dev: camera support installed.');
  } catch {
    log('Pocket Dev: camera setup did not finish. Retry from Settings → Device camera → Install camera support.');
  } finally { support?.dispose(); }
}
