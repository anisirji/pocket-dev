import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { findBin } from '../chat/env.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_FRAME = 2 * 1024 * 1024;

// Device enumeration never opens a video input. Only entries from this list can be started.
export function parseCameras(output, os) {
  const cameras = [];
  let video = false;
  for (const line of output.split(/\r?\n/)) {
    if (os === 'darwin') {
      if (line.includes('AVFoundation video devices:')) { video = true; continue; }
      if (line.includes('AVFoundation audio devices:')) video = false;
      const m = video && /\[(\d+)\]\s+(.+)$/.exec(line);
      // AVFoundation also enumerates desktop capture sources here.
      if (m && !/^Capture screen\b/i.test(m[2])) cameras.push({ id: m[1], name: m[2].trim() });
    } else if (os === 'win32') {
      const m = /"(.+)"\s+\(video\)/.exec(line);
      if (m) cameras.push({ id: m[1], name: m[1] });
    }
  }
  return cameras;
}

export function cameraArgs(os, id) {
  const input = os === 'darwin' ? ['-f', 'avfoundation', '-framerate', '30', '-i', `${id}:none`]
    : os === 'win32' ? ['-f', 'dshow', '-i', `video=${id}`]
      : ['-f', 'video4linux2', '-i', id];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input,
    '-an', '-vf', "fps=5,scale=w='min(640,iw)':h=-2", '-c:v', 'mjpeg', '-q:v', '5', '-threads', '1', '-f', 'image2pipe', 'pipe:1'];
}

function enumerate(bin, os) {
  if (os === 'linux') {
    try {
      return Promise.resolve(fs.readdirSync('/sys/class/video4linux').filter((name) => /^video\d+$/.test(name)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map((name) => ({ id: `/dev/${name}`, name: fs.readFileSync(`/sys/class/video4linux/${name}/name`, 'utf8').trim() || name })));
    } catch (err) {
      if (err.code === 'ENOENT') return Promise.resolve([]);
      return Promise.reject(fail(503, 'Could not list cameras. Check access to /sys/class/video4linux.'));
    }
  }
  const args = os === 'darwin' ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
    : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const devices = parseCameras(`${stdout}\n${stderr}`, os);
      // FFmpeg normally exits nonzero after printing the list.
      if (err && (err.killed || err.code === 'ENOENT' || err.code === 'EACCES')) return reject(fail(503, 'Could not list cameras. Check that FFmpeg runs on this computer.'));
      resolve(devices);
    });
  });
}

// One capture process, shared by viewers of the same camera. Each viewer owns an expiring lease;
// a closed/suspended phone cannot leave the camera running. Frames never touch disk.
export function createCamera({ os = process.platform, binary = () => process.env.POCKET_DEV_FFMPEG || findBin('ffmpeg'),
  listDevices = enumerate, spawnProcess = spawn, enabled = () => true, now = Date.now,
  idleMs = 15_000, firstFrameMs = 12_000, staleMs = 5000 } = {}) {
  let capture = null, listing = null;
  const leases = new Map();
  const supported = () => {
    if (!enabled()) throw fail(403, 'Camera access is disabled in Admin.');
    if (!['darwin', 'win32', 'linux'].includes(os)) throw fail(503, 'Camera access is unavailable on this system.');
    const bin = binary();
    if (!bin) throw fail(503, 'Camera support is missing. Open Device camera and tap Install camera support.');
    return bin;
  };
  async function devices() {
    const bin = supported();
    listing ??= Promise.resolve().then(() => listDevices(bin, os)).finally(() => { listing = null; });
    return listing;
  }
  function terminate(c, error = fail(410, 'Camera stopped. Start it again to continue.')) {
    if (!c || c.stopped) return;
    c.stopped = true;
    c.error = error;
    if (capture === c) { capture = null; leases.clear(); }
    c.child.kill();
    const force = setTimeout(() => { if (c.child.exitCode === null) c.child.kill('SIGKILL'); }, 1500);
    force.unref?.();
    c.child.once('close', () => clearTimeout(force));
    for (const waiter of [...c.waiters]) waiter();
    c.frame = null;
    c.buffer = Buffer.alloc(0);
  }
  function sweep() {
    for (const [id, lease] of leases) if (now() - lease.at >= idleMs) leases.delete(id);
    if (capture && (!enabled() || !leases.size)) terminate(capture);
  }
  const timer = setInterval(sweep, Math.min(1000, idleMs));
  timer.unref?.();

  function launch(bin, device) {
    const child = spawnProcess(bin, cameraArgs(os, device.id), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const c = { child, device, buffer: Buffer.alloc(0), frame: null, at: 0, error: null, stopped: false, waiters: new Set(), stderr: '' };
    capture = c;
    child.stderr.on('data', (chunk) => { c.stderr = (c.stderr + chunk.toString()).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      if (c.stopped) return;
      c.buffer = Buffer.concat([c.buffer, chunk]);
      if (c.buffer.length > MAX_FRAME) return terminate(c, fail(503, 'The camera returned an oversized frame.'));
      while (c.buffer.length) {
        const start = c.buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) { c.buffer = c.buffer.subarray(-1); break; }
        if (start) c.buffer = c.buffer.subarray(start);
        const end = c.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
        if (end < 0) break;
        c.frame = Buffer.from(c.buffer.subarray(0, end + 2));
        c.at = now();
        c.buffer = c.buffer.subarray(end + 2);
        for (const waiter of [...c.waiters]) waiter();
      }
    });
    const failed = () => terminate(c, fail(503, `Could not read the camera. Allow camera access for the program running Pocket Dev in this computer's privacy settings, close other camera apps, and check that the camera is connected.${c.stderr.trim() ? ` ${c.stderr.trim().slice(-600)}` : ''}`));
    child.once('error', failed);
    child.once('close', failed);
    return c;
  }
  function own(owner, id) {
    sweep();
    supported();
    const lease = leases.get(id);
    if (!lease || lease.owner !== owner || !capture) throw fail(410, 'Camera session ended. Start it again to continue.');
    lease.at = now();
    return capture;
  }
  async function start(owner, deviceId) {
    const bin = supported();
    const cameras = await devices();
    supported();
    const device = cameras.find((d) => d.id === deviceId);
    if (!device) throw fail(400, 'Choose a connected camera. Reopen Device camera to refresh the list.');
    sweep();
    if (capture && capture.device.id !== device.id) throw fail(409, 'Another viewer is using a different camera. Stop that preview first.');
    // A repeated start from the same device replaces its lease, rather than leaking viewers.
    for (const [id, lease] of leases) if (lease.owner === owner) leases.delete(id);
    const c = capture ?? launch(bin, device);
    const id = crypto.randomUUID();
    leases.set(id, { owner, at: now() });
    return { id, camera: c.device.name };
  }
  async function frame(owner, id) {
    const c = own(owner, id);
    if (!c.frame) await new Promise((resolve, reject) => {
      const done = () => {
        if (!c.frame && !c.error) return;
        clearTimeout(timeout); c.waiters.delete(done);
        c.error ? reject(c.error) : resolve();
      };
      const timeout = setTimeout(() => terminate(c, fail(503, 'No camera image arrived. Check camera permission on the computer, close other camera apps, and try again.')), firstFrameMs);
      c.waiters.add(done);
      done();
    });
    own(owner, id);
    if (now() - c.at > staleMs) { terminate(c); throw fail(503, 'The camera stopped sending images. Check its connection and start again.'); }
    return c.frame;
  }
  function stop(owner, id) {
    if (leases.get(id)?.owner === owner) leases.delete(id);
    if (!leases.size) terminate(capture);
  }
  return { devices, start, frame, stop, reconcile: sweep, revokeAll() { leases.clear(); terminate(capture); }, dispose() { clearInterval(timer); terminate(capture); } };
}
