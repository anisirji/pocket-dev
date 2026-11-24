import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, HOSTNAME, TOKEN, PHONE_IP } from './helpers/server.mjs';

// Neither upload route looks at the type or the extension of what it is given: a document, an archive, plain text and
// a picture all arrive byte for byte. Only the size caps apply (25 MB for the chat and terminal paperclip).
const SAMPLES = {
  'report.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0, 1, 2, 3])]),
  'bundle.zip': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]),
  'notes.txt': Buffer.from('plain notes\nsecond line\n'),
  'pixel.png': Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'),
};

async function open(t) {
  const s = await startServer(t, {});
  const A = await s.login();
  const post = (url, body, headers = {}) => fetch(`${s.base}${url}`, { method: 'POST', headers: { cookie: A.cookie, 'x-pocket-dev': '1', ...headers }, body });
  return { s, post };
}

test('the chat and terminal paperclip route keeps pdf, zip, text and png bytes and the name', { timeout: 60000 }, async (t) => {
  const { post } = await open(t);
  for (const [name, bytes] of Object.entries(SAMPLES)) {
    const res = await post('/api/upload', bytes, { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' });
    assert.equal(res.status, 201, name);
    const { path: file } = await res.json();
    assert.ok(file.endsWith(name), file);
    assert.deepEqual(fs.readFileSync(file), bytes, name);
  }
});

test('the chat paperclip route refuses a file over 25 MB and says so', { timeout: 60000 }, async (t) => {
  const { post } = await open(t);
  const res = await post('/api/upload', Buffer.alloc(26 * 1024 * 1024, 1), { 'x-filename': 'big.bin' });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /25 MB/);
});

test('the Files Upload route keeps pdf, zip, text and png bytes under the chosen folder', { timeout: 60000 }, async (t) => {
  const { s, post } = await open(t);
  const dir = path.join(s.home, 'uploads-check');
  fs.mkdirSync(dir);
  for (const [name, bytes] of Object.entries(SAMPLES)) {
    const res = await post(`/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, bytes, { 'content-type': 'application/octet-stream' });
    assert.equal(res.status, 201, `${name}: ${await res.clone().text()}`);
    assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, name);
  }
});

test('Files uploads have no size cap on the Wi-Fi; only the internet address keeps fileUploadMax', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { wifi: true, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  await s.tunnelStatus('connected');
  fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config, 'utf8')), fileUploadMax: 1000 }));
  const dir = path.join(s.home, 'cap-check');
  fs.mkdirSync(dir);
  const bytes = Buffer.alloc(5000, 7);
  // http.request, not fetch, because the tunnel side needs a chosen Host header.
  const upload = (cookie, name, tunnel) => new Promise((resolve, reject) => {
    const req = http.request(`${s.base}/api/files/upload?dir=${encodeURIComponent(dir)}&name=${name}`, { method: 'POST', headers: {
      cookie, 'x-pocket-dev': '1', 'content-type': 'application/octet-stream', 'content-length': bytes.length,
      ...(tunnel && { host: HOSTNAME, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP }),
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(bytes);
  });

  const lan = await s.login();
  assert.equal((await s.request('GET', '/api/files/places', { cookie: lan.cookie })).data.uploadMax, null);
  assert.equal((await s.request('PUT', '/api/files/pin', { cookie: lan.cookie, body: { path: dir, pinned: true } })).data.uploadMax, null);
  assert.equal(await upload(lan.cookie, 'lan.bin', false), 201);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'lan.bin')), bytes);

  const internet = await s.login({ via: 'tunnel' });
  assert.equal((await s.request('GET', '/api/files/places', { cookie: internet.cookie, via: 'tunnel' })).data.uploadMax, 1000);
  assert.equal(await upload(internet.cookie, 'internet.bin', true), 413);
  assert.equal(fs.existsSync(path.join(dir, 'internet.bin')), false);
});
