import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureError, createScreenCapture } from '../src/machine/screen.js';

const host = { the: 'the Mac' };

test('a failed Windows capture says what Windows needs, with the first line of what PowerShell said', () => {
  const err = captureError({ stderr: 'Exception calling "CopyFromScreen" with "3" argument(s): "The handle is invalid"\r\nAt line:5 char:1\r\n' }, 'win32', host);
  assert.equal(err.message, 'Could not capture the screen. Windows allows a screen picture only from the signed-in desktop: the screen must be unlocked, and Pocket Dev must run as that user (pocket-dev start, or Start at login), not as a system service. (Exception calling "CopyFromScreen" with "3" argument(s): "The handle is invalid")');
});

test('a failed Mac capture keeps its own reason and has no empty detail', () => {
  assert.equal(captureError(new Error('boom'), 'darwin', host).message, 'Could not capture the screen. The display may be asleep or the Mac locked.');
});
test('Mac captures serialize work, share matching requests and keep display/quality requests separate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-screen-options-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; let active = 0, maximum = 0;
  const platform = { platform: 'darwin', capabilities: () => ({ screenshot: { available: true } }),
    async screenshot(dir, options) { maximum = Math.max(maximum, ++active); calls.push(options); await new Promise((resolve) => setTimeout(resolve, 15)); const file = path.join(dir, 'raw.jpg'); fs.writeFileSync(file, String(options.display || 1)); return file; },
    async resizeImage(options) { calls.push({ side: options.side, quality: options.quality }); fs.writeFileSync(options.output, fs.readFileSync(options.input)); active--; } };
  const capture = createScreenCapture({ platform, stateDir: root });
  const first = capture({ display: 1, quality: 'low' }); assert.equal(capture({ display: 1, quality: 'low' }), first);
  const other = capture({ display: 2, quality: 'high' });
  const [a, b] = await Promise.all([first, other]); assert.equal(a.toString(), '1'); assert.equal(b.toString(), '2'); assert.equal(maximum, 1);
  assert.deepEqual(calls.filter((call) => call.side), [{ side: 960, quality: 45 }, { side: 2560, quality: 82 }]);
  assert.deepEqual(fs.readdirSync(root), [], 'temporary captures are removed');
  for (const options of [{ display: 0 }, { display: '-x' }, { display: 17 }, { quality: 'arbitrary' }]) await assert.rejects(capture(options), /available display and quality/);
});
test('a failed screen capture releases its queue slot and temporary folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-screen-failure-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fail = true;
  const platform = { platform: 'darwin', capabilities: () => ({ screenshot: { available: true } }), async screenshot(dir) { if (fail) { fail = false; throw new Error('fixture failure'); } const file = path.join(dir, 'raw.jpg'); fs.writeFileSync(file, 'fixture'); return file; }, async resizeImage(options) { fs.copyFileSync(options.input, options.output); } };
  const capture = createScreenCapture({ platform, stateDir: root });
  await assert.rejects(capture(), /Could not capture/); assert.equal((await capture()).toString(), 'fixture'); assert.deepEqual(fs.readdirSync(root), []);
});
