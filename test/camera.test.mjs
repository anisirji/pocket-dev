import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCamera, parseCameras, cameraArgs } from '../src/machine/camera.js';

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
function fixture(t, options = {}) {
  const children = [];
  const camera = createCamera({ os: 'darwin', binary: () => '/fake/ffmpeg',
    listDevices: async () => [{ id: '0', name: 'Built-in camera' }, { id: '1', name: 'USB camera' }],
    spawnProcess: (file, args, opts) => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, args, opts,
        kill() { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); },
      });
      children.push(child);
      return child;
    }, ...options });
  t.after(() => camera.dispose());
  return { camera, children };
}

test('enumeration excludes Mac desktop inputs and all microphones', () => {
  const mac = '[AVFoundation @ 0xabc] AVFoundation video devices:\n[AVFoundation @ 0xabc] [0] FaceTime HD Camera\n[AVFoundation @ 0xabc] [1] Capture screen 0\n[AVFoundation @ 0xabc] AVFoundation audio devices:\n[AVFoundation @ 0xabc] [0] Microphone';
  assert.deepEqual(parseCameras(mac, 'darwin'), [{ id: '0', name: 'FaceTime HD Camera' }]);
  assert.deepEqual(parseCameras('[dshow @ x] "USB Webcam" (video)\n[dshow @ x] "Microphone" (audio)', 'win32'), [{ id: 'USB Webcam', name: 'USB Webcam' }]);
});

test('each platform captures video only through fixed arguments and a memory pipe', () => {
  for (const [os, id, input] of [['darwin', '0', '0:none'], ['win32', 'USB & Camera', 'video=USB & Camera'], ['linux', '/dev/video0', '/dev/video0']]) {
    const args = cameraArgs(os, id);
    assert.equal(args[args.indexOf('-i') + 1], input);
    assert.ok(args.includes('-an'));
    assert.equal(args.at(-1), 'pipe:1');
  }
});

test('listing and invalid starts never open a camera; frames cannot start capture', async (t) => {
  const { camera, children } = fixture(t);
  assert.equal((await camera.devices()).length, 2);
  await assert.rejects(camera.start('phone', 'arbitrary-input'), { status: 400 });
  await assert.rejects(camera.frame('phone', 'unknown'), { status: 410 });
  assert.equal(children.length, 0);
});

test('split JPEGs are reassembled; viewers share capture and can only access their own lease', async (t) => {
  const { camera, children } = fixture(t);
  const a = await camera.start('a', '0');
  const b = await camera.start('b', '0');
  assert.equal(children.length, 1);
  const pending = camera.frame('a', a.id);
  children[0].stdout.write(jpeg.subarray(0, 1));
  children[0].stdout.write(jpeg.subarray(1, 5));
  children[0].stdout.write(jpeg.subarray(5));
  assert.deepEqual(await pending, jpeg);
  await assert.rejects(camera.frame('b', a.id), { status: 410 });
  camera.stop('b', a.id);
  assert.deepEqual(await camera.frame('a', a.id), jpeg);
  await assert.rejects(camera.start('c', '1'), { status: 409 });
  camera.stop('a', a.id);
  assert.equal(children[0].killed, undefined);
  assert.deepEqual(await camera.frame('b', b.id), jpeg);
  camera.stop('b', b.id);
  assert.equal(children[0].killed, true);
});

test('dropped viewers expire and configuration changes release capture', async (t) => {
  let at = 0, enabled = true;
  const { camera, children } = fixture(t, { now: () => at, enabled: () => enabled, idleMs: 100 });
  const a = await camera.start('a', '0');
  at = 101;
  await assert.rejects(camera.frame('a', a.id), { status: 410 });
  assert.equal(children[0].killed, true);
  await camera.start('b', '0');
  enabled = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(children[1].killed, true);
  await assert.rejects(camera.devices(), { status: 403 });
});

test('a silent, failed, oversized or stalled camera stops with a useful error', async (t) => {
  const { camera, children } = fixture(t, { firstFrameMs: 20 });
  const a = await camera.start('a', '0');
  await assert.rejects(camera.frame('a', a.id), /No camera image arrived/);
  assert.equal(children[0].killed, true);
  const b = await camera.start('a', '0');
  const pending = camera.frame('a', b.id);
  children[1].emit('error', new Error('device missing'));
  await assert.rejects(pending, /Allow camera access/);
  const c = await camera.start('a', '0');
  const oversized = camera.frame('a', c.id);
  children[2].stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(oversized, /oversized/);
});

test('cached images expire when capture stalls; repeated starts replace the old lease', async (t) => {
  let at = 0;
  const { camera, children } = fixture(t, { now: () => at });
  const old = await camera.start('a', '0');
  const a = await camera.start('a', '0');
  await assert.rejects(camera.frame('a', old.id), { status: 410 });
  children[0].stdout.write(Buffer.concat([jpeg, jpeg]));
  assert.deepEqual(await camera.frame('a', a.id), jpeg);
  at = 6000;
  await assert.rejects(camera.frame('a', a.id), /stopped sending/);
  assert.equal(children[0].killed, true);
});

test('missing FFmpeg explains setup and never spawns', async (t) => {
  const { camera, children } = fixture(t, { binary: () => null });
  await assert.rejects(camera.devices(), /Install camera support/);
  assert.equal(children.length, 0);
});
