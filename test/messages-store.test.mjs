import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';

// Every child process this test process starts, by the program it ran. Patched before messages.js loads, and synced
// so its named imports see the wrappers too.
const spawned = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function (file, ...rest) {
    spawned.push(String(file));
    return original.call(this, file, ...rest);
  };
}
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-messages-'));
const sips = path.join(root, 'sips-stub');
fs.writeFileSync(sips, '#!/bin/sh\nfor a; do case "$prev" in --out) out="$a";; esac; prev="$a"; done\nfor a; do [ -f "$a" ] && raw="$a"; done\ncp "$raw" "$out"\n', { mode: 0o700 });
process.env.POCKET_DEV_SIPS = sips;
const { createMessages, detectType } = await import('../messages.js');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { free = 100 * 1024 ** 3, reserveGB } = {}) {
  const stateDir = fs.mkdtempSync(path.join(root, 'state-'));
  const devices = [{ id: 'aaaa1111', name: 'Pixel', status: 'active', role: 'unreviewed' }, { id: 'bbbb2222', name: 'iPad', status: 'active', role: 'unreviewed' }];
  const disk = { free };
  const messages = createMessages({
    stateDir,
    config: { read: () => (reserveGB === undefined ? {} : { messagesReserveGB: reserveGB }) },
    auth: {
      deviceFor: (req) => devices.find((d) => req.headers.cookie === `pd_token=${d.id}`),
      trackSocket() {},
      admin: { state: () => ({ devices, roleAccessEnabled: false }), log() {} },
    },
    collaborators: { guest: () => null, scope() {}, ownerApi: async () => ({ status: 200, body: { collaborators: [] } }) },
    wss: new WebSocketServer({ noServer: true }),
    rejectUpgrade: (socket, status) => socket.end(`HTTP/1.1 ${status} No\r\n\r\n`),
    statfs: async () => ({ bavail: Math.floor(disk.free / 4096), bsize: 4096 }),
  });
  const server = http.createServer((req, res) => messages.handleApi(req, res, { mac: req.headers['x-mac'] === '1' }));
  server.on('upgrade', (req, socket, head) => messages.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const opened = [];
  t.after(() => { for (const ws of opened) ws.terminate(); server.closeAllConnections(); server.close(); });
  const call = async (method, endpoint, { as = 'aaaa1111', body, raw, name } = {}) => {
    const res = await fetch(base + endpoint, {
      method,
      headers: { ...(as === 'mac' ? { 'x-mac': '1' } : { cookie: `pd_token=${as}` }), ...(body && { 'content-type': 'application/json' }), ...(name && { 'x-filename': name }) },
      body: raw ?? (body && JSON.stringify(body)),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const socket = async (as) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/messages`, { headers: { cookie: `pd_token=${as}` } });
    opened.push(ws);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    await once(ws, 'open');
    return ws;
  };
  return { stateDir, dir: path.join(stateDir, 'messages'), disk, call, socket, base };
}

test('file types come from magic bytes, never from the name', () => {
  assert.equal(detectType(PNG), 'image/png');
  assert.equal(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(detectType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(detectType(Buffer.from('\0\0\0\x18ftypheic')), 'image/heic');
  assert.equal(detectType(Buffer.from('\0\0\0\x18ftypisom')), 'video/mp4');
  assert.equal(detectType(Buffer.from('\0\0\0\x14ftypqt  ')), 'video/quicktime');
  assert.equal(detectType(Buffer.from('\0\0\0\x20ftypM4A ')), 'audio/mp4');
  assert.equal(detectType(Buffer.from('ID3\x04')), 'audio/mpeg');
  assert.equal(detectType(Buffer.from('OggS\0')), 'audio/ogg');
  assert.equal(detectType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'application/octet-stream');
  assert.equal(detectType(Buffer.from('<!doctype html><script>')), 'application/octet-stream');
});

test('messages and files are private on disk', async (t) => {
  const f = await fixture(t);
  const up = await f.call('POST', '/api/messages/files', { raw: PNG, name: 'dot.png' });
  assert.equal(up.status, 201);
  assert.equal((await f.call('POST', '/api/messages', { body: { text: 'hi', files: [up.data.id] } })).status, 201);
  for (const dir of [f.dir, path.join(f.dir, 'files'), path.join(f.dir, 'thumbs')]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  for (const file of ['messages.jsonl', 'secret', `files/${up.data.id}`]) assert.equal(fs.statSync(path.join(f.dir, file)).mode & 0o777, 0o600, file);
});

const GB = 1024 ** 3, MB = 1024 ** 2;
// Streams `bytes` of zeros from one reused 1 MB chunk, so the test never holds the whole body.
function streamUpload(base, bytes, { declare = true, onChunk = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { cookie: 'pd_token=aaaa1111', 'x-filename': 'zeros.bin', ...(declare && { 'content-length': bytes }) };
    const req = http.request(`${base}/api/messages/files`, { method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(MB);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        const piece = Math.min(chunk.length, bytes - sent);
        sent += piece;
        onChunk(sent);
        if (!req.write(piece === chunk.length ? chunk : chunk.subarray(0, piece))) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

test('low space pauses files over 50 MB only; text and smaller files still go', async (t) => {
  const f = await fixture(t, { free: 4 * GB, reserveGB: 5 });
  const state = (await f.call('GET', '/api/messages')).data.limits;
  assert.deepEqual(state, { fileMax: null, largeFile: 50 * MB, lowSpace: true, freeBytes: 4 * GB, reserveBytes: 5 * GB });
  const large = await streamUpload(f.base, 60 * MB);
  assert.equal(large.status, 507);
  assert.equal(large.data.error, "Your Mac is low on space (4.0 GB free). Files over 50 MB are paused until there's more than 5.0 GB free. Text and files up to 50 MB still work.");
  const undeclared = await streamUpload(f.base, 60 * MB, { declare: false });
  assert.equal(undeclared.status, 507, 'a body without a length is stopped once it passes 50 MB');
  const small = await streamUpload(f.base, 40 * MB);
  assert.equal(small.status, 201);
  assert.equal(small.data.size, 40 * MB);
  assert.equal((await f.call('POST', '/api/messages', { body: { text: 'still here' } })).status, 201);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'files')), [small.data.id], 'refused uploads left nothing behind');
});

test('with normal space a 60 MB file goes through on the Wi-Fi route', async (t) => {
  const f = await fixture(t, { free: 100 * GB });
  const res = await streamUpload(f.base, 60 * MB);
  assert.equal(res.status, 201);
  assert.equal(fs.statSync(path.join(f.dir, 'files', res.data.id)).size, 60 * MB);
});

test('a small file is refused when it would leave less than 500 MB free, including space running out mid-upload', async (t) => {
  const f = await fixture(t, { free: 520 * MB });
  const res = await streamUpload(f.base, 30 * MB);
  assert.equal(res.status, 507);
  assert.match(res.data.error, /^Your Mac is almost out of space \(520\.0 MB free\)/);
  f.disk.free = 2 * GB;
  const shrinking = await streamUpload(f.base, 40 * MB, { declare: false, onChunk: (sent) => { if (sent === 10 * MB) f.disk.free = 400 * MB; } });
  assert.equal(shrinking.status, 507);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'files')), []);
});

test('an aborted upload leaves no partial file', async (t) => {
  const f = await fixture(t);
  const req = http.request({ port: new URL(f.base).port, host: '127.0.0.1', method: 'POST', path: '/api/messages/files', headers: { cookie: 'pd_token=aaaa1111', 'content-length': 50 * 1024 * 1024 } });
  req.on('error', () => {});
  req.write(Buffer.alloc(4 * 1024 * 1024));
  const files = path.join(f.dir, 'files');
  for (let i = 0; i < 100 && !fs.readdirSync(files).length; i++) await pause(20);
  assert.equal(fs.readdirSync(files).length, 1, 'the upload started writing');
  req.destroy();
  for (let i = 0; i < 100 && fs.readdirSync(files).length; i++) await pause(20);
  assert.deepEqual(fs.readdirSync(files), []);
});

test('sending, receiving, downloading, hiding and deleting start no child process; thumbnails may run sips only', async (t) => {
  const f = await fixture(t);
  const before = spawned.length;
  const ipad = await f.socket('bbbb2222');
  const up = await f.call('POST', '/api/messages/files', { raw: Buffer.from('plain text file'), name: 'notes.txt' });
  const sent = await f.call('POST', '/api/messages', { body: { text: 'look', files: [up.data.id] } });
  assert.equal(sent.status, 201);
  for (let i = 0; i < 100 && !ipad.inbox.some((m) => m.t === 'message'); i++) await pause(20);
  assert.equal(ipad.inbox.find((m) => m.t === 'message').message.text, 'look');
  const download = await f.call('GET', `/api/messages/files/${up.data.id}`, { as: 'bbbb2222' });
  assert.equal(download.data, 'plain text file');
  assert.equal((await f.call('GET', '/api/messages', { as: 'mac' })).status, 200);
  assert.equal((await f.call('POST', `/api/messages/${sent.data.seq}/hide`, { as: 'bbbb2222' })).status, 204);
  assert.equal((await f.call('DELETE', `/api/messages/${sent.data.seq}`)).status, 204);
  assert.deepEqual(spawned.slice(before), [], 'no child process');

  const image = await f.call('POST', '/api/messages/files', { raw: PNG, name: 'dot.png' });
  await f.call('POST', '/api/messages', { body: { files: [image.data.id] } });
  assert.equal((await f.call('GET', `/api/messages/files/${image.data.id}/thumb`, { as: 'bbbb2222' })).status, 200);
  assert.deepEqual(spawned.slice(before), [sips], 'only the thumbnail runs, and only sips');
});
