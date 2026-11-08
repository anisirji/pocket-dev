import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createMessages } from '../messages.js';

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-message-review-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const devices = [{ id: 'aaaa1111', name: 'Phone', status: 'active' }, { id: 'bbbb2222', name: 'Tablet', status: 'active' }];
  const grant = { id: 'grant1', label: 'Guest', role: 'viewer', createdAt: 0, status: 'active' };
  const messages = createMessages({
    stateDir,
    config: { read: () => ({}) },
    auth: {
      deviceFor: (req) => devices.find((d) => req.headers.cookie === d.id && d.status === 'active'),
      admin: { state: () => ({ devices, roleAccessEnabled: false }), log() {} },
    },
    collaborators: {
      guest: (req) => req.headers.cookie === 'guest' ? { active: grant.status === 'active', grant } : null,
      scope() {},
      ownerApi: async () => ({ body: { collaborators: grant.status === 'active' ? [grant] : [] } }),
    },
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
  });
  function begin(method, url, { as = devices[0].id, raw = false, name = 'file.txt' } = {}) {
    const req = new PassThrough();
    Object.assign(req, { method, url, headers: { cookie: as, 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-filename': name }, socket: { remoteAddress: '127.0.0.1' } });
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    res.headersSent = false;
    res.headers = {};
    res.setHeader = (key, val) => { res.headers[key] = val; };
    res.writeHead = (status, headers) => { res.status = status; res.headers = { ...res.headers, ...headers }; res.headersSent = true; };
    const done = messages.handleApi(req, res).then(() => {
      const text = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    });
    return { req, done };
  }
  function call(method, url, body, options = {}) {
    const { req, done } = begin(method, url, options);
    req.end(options.raw ? body : body === undefined ? undefined : JSON.stringify(body));
    return done;
  }
  return { stateDir, devices, grant, begin, call };
}

test('a pending attachment is consumed by only one concurrent direct send', async (t) => {
  const f = fixture(t);
  const up = await f.call('POST', '/api/messages/files', 'notes', { raw: true });
  assert.equal(up.status, 201);
  const directory = await f.call('GET', '/api/messages/people');
  const to = directory.data.people.find((p) => p.name === 'Tablet').id;
  const results = await Promise.all([1, 2].map((n) => f.call('POST', '/api/messages', { text: `copy ${n}`, to, files: [up.data.id] })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  const inbox = await f.call('GET', '/api/messages');
  assert.equal(inbox.data.messages.length, 1);
  assert.equal((await f.call('DELETE', `/api/messages/${inbox.data.messages[0].seq}`)).status, 204);
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'messages', 'files')), []);
});

for (const as of ['aaaa1111', 'guest']) {
  test(`revoking ${as} while a message body arrives prevents the write`, async (t) => {
    const f = fixture(t);
    const { req, done } = f.begin('POST', '/api/messages', { as });
    req.write('{"text":');
    if (as === 'guest') f.grant.status = 'revoked';
    else f.devices[0].status = 'blocked';
    req.end('"should not be delivered"}');
    assert.ok((await done).status >= 400);
    const inbox = await f.call('GET', '/api/messages', undefined, { as: 'bbbb2222' });
    assert.deepEqual(inbox.data.messages, []);
  });
}

test('a failed disk append leaves no delivered message and preserves its pending attachment for retry', async (t) => {
  const f = fixture(t);
  const up = await f.call('POST', '/api/messages/files', 'notes', { raw: true });
  const original = fs.appendFileSync;
  fs.appendFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    assert.ok((await f.call('POST', '/api/messages', { text: 'retry me', files: [up.data.id] })).status >= 400);
  } finally { fs.appendFileSync = original; }
  assert.deepEqual((await f.call('GET', '/api/messages')).data.messages, []);
  assert.equal((await f.call('POST', '/api/messages', { text: 'retry me', files: [up.data.id] })).status, 201);
});

test('direct messages and attachments stay private; HTML always downloads sandboxed', async (t) => {
  const f = fixture(t);
  const up = await f.call('POST', '/api/messages/files', '<script>alert(1)</script>', { raw: true, name: 'photo.png' });
  const directory = await f.call('GET', '/api/messages/people');
  const to = directory.data.people.find((p) => p.name === 'Tablet').id;
  assert.equal((await f.call('POST', '/api/messages', { text: '<b>private</b>', to, files: [up.data.id] })).status, 201);
  assert.deepEqual((await f.call('GET', '/api/messages', undefined, { as: 'guest' })).data.messages, []);
  assert.equal((await f.call('GET', `/api/messages/files/${up.data.id}`, undefined, { as: 'guest' })).status, 404);
  const download = await f.call('GET', `/api/messages/files/${up.data.id}`, undefined, { as: 'bbbb2222' });
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-disposition'], /^attachment/);
  assert.equal(download.headers['content-security-policy'], 'sandbox');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
});
