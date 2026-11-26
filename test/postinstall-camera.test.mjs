import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { postinstallCamera } from '../src/setup/camera-support.js';

const globalInstall = { npm_config_global: 'true' };
function fixture(options = {}) {
  const calls = [], lines = [];
  const support = {
    async status() { calls.push('check'); return { available: false, canInstall: true }; },
    async ensureInstalled() { calls.push('install'); return { available: true }; },
    dispose() { calls.push('dispose'); }, ...options,
  };
  return { calls, lines, support, deps: { stateDir: '/fixture-state', readFile: () => '{"cameraBackend":"ffmpeg"}', log: (line) => lines.push(line),
    createSupport: (opts) => { calls.push(opts); return support; } } };
}

test('global installs with the legacy FFmpeg backend prepare support and wait for completion', async () => {
  let finish;
  const f = fixture({ ensureInstalled: () => new Promise((resolve) => { finish = resolve; }) });
  let done = false;
  const install = postinstallCamera(globalInstall, f.deps).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(typeof finish, 'function');
  finish({ available: true });
  await install;
  assert.equal(done, true);
  assert.match(f.lines.at(-1), /camera support installed/);
  assert.equal(f.calls.at(-1), 'dispose');
});

test('existing support is reused during install and upgrade without downloading', async () => {
  const f = fixture({ status: async () => ({ available: true, canInstall: true }) });
  await postinstallCamera(globalInstall, f.deps);
  assert.ok(!f.calls.includes('install'));
  assert.match(f.lines.join('\n'), /existing camera support/);
});

test('local installs, npx, CI and the explicit opt-out never check or download a helper', async () => {
  for (const env of [{}, { npm_config_global: 'false' }, { ...globalInstall, CI: 'true' }, { ...globalInstall, POCKET_DEV_NO_CAMERA_INSTALL: '1' }]) {
    const f = fixture();
    await postinstallCamera(env, f.deps);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.lines, []);
  }
});

test('an explicitly disabled camera skips automatic setup and custom state/config locations are honored', async () => {
  const f = fixture();
  f.deps.readFile = (file) => { assert.equal(file, '/custom/config.json'); return '{"cameraView":false}'; };
  await postinstallCamera({ ...globalInstall, POCKET_DEV_CONFIG: '/custom/config.json' }, f.deps);
  assert.deepEqual(f.calls, []);
  f.deps.readFile = (file) => { assert.equal(file, '/custom/state/config.json'); return '{"cameraBackend":"ffmpeg"}'; };
  await postinstallCamera({ ...globalInstall, POCKET_DEV_STATE_DIR: '/custom/state' }, f.deps);
  assert.deepEqual(f.calls[0], { stateDir: '/custom/state' });
});

test('new users need no helper install for browser capture; unreadable config does not trigger downloads', async () => {
  const f = fixture();
  f.deps.readFile = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
  await postinstallCamera(globalInstall, f.deps);
  assert.deepEqual(f.calls, []);
  assert.match(f.lines.join('\n'), /computer browser/);
  const bad = fixture();
  bad.deps.readFile = () => '{bad JSON';
  await assert.doesNotReject(postinstallCamera(globalInstall, bad.deps));
  assert.deepEqual(bad.calls, []);
});

test('the default browser backend never checks or downloads FFmpeg during installation', async () => {
  const f = fixture();
  f.deps.readFile = () => '{}';
  await postinstallCamera(globalInstall, f.deps);
  assert.deepEqual(f.calls, []);
  assert.match(f.lines.join('\n'), /No camera helper installation needed/);
});

test('offline, failed and unsupported setup leave Pocket Dev usable with the install-button fallback', async () => {
  for (const options of [
    { ensureInstalled: async () => { throw new Error('offline'); } },
    { ensureInstalled: async () => ({ available: false, state: 'error' }) },
    { status: async () => { throw new Error('check failed'); } },
  ]) {
    const f = fixture(options);
    await assert.doesNotReject(postinstallCamera(globalInstall, f.deps));
    assert.match(f.lines.at(-1), /Settings → Device camera → Install camera support/);
    assert.equal(f.calls.at(-1), 'dispose');
  }
  const unsupported = fixture({ status: async () => ({ available: false, canInstall: false }) });
  await postinstallCamera(globalInstall, unsupported.deps);
  assert.ok(!unsupported.calls.includes('install'));
});

test('the npm hook awaits camera setup even if launcher setup fails, and still exits zero on errors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-camera-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src', 'setup'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/postinstall.js', import.meta.url), path.join(root, 'scripts', 'postinstall.js'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'src', 'setup', 'taskbar-pin.js'), 'throw new Error("launcher failed");');
  const module = path.join(root, 'src', 'setup', 'camera-support.js');
  fs.writeFileSync(module, 'import fs from "node:fs"; export async function postinstallCamera(){ await new Promise(r=>setTimeout(r,20)); fs.writeFileSync("camera-ready", "done"); }');
  const run = () => spawnSync(process.execPath, ['scripts/postinstall.js'], { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, npm_config_global: 'true' } });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'camera-ready'), 'utf8'), 'done');
  fs.writeFileSync(module, 'export async function postinstallCamera(){ throw new Error("offline"); }');
  assert.equal(run().status, 0);
});
