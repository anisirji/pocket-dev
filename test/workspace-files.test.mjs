import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

async function fixture(t) {
  const s = await startServer(t);
  const { cookie } = await s.login();
  const file = path.join(s.home, 'example.js');
  fs.writeFileSync(file, 'const value = 1;\r\n', { mode: 0o755 });
  const get = (filePath = file) => s.request('GET', '/api/files/text?' + new URLSearchParams({ path: filePath }), { cookie });
  async function put(content, revision, extra = {}) {
    const response = await fetch(s.base + '/api/files/text?' + new URLSearchParams({ path: file }), {
      method: 'PUT', headers: { cookie, 'x-pocket-dev': '1', 'content-type': 'text/plain; charset=utf-8', ...(revision && { 'if-match': revision }), ...extra }, body: content,
    });
    return { status: response.status, data: await response.json() };
  }
  return { s, cookie, file, get, put };
}

test('workspace text saves preserve content and modes, reject stale or concurrent edits', async (t) => {
  const { file, get, put } = await fixture(t);
  const initial = await get();
  assert.equal(initial.status, 200);
  assert.equal(initial.data.content, 'const value = 1;\r\n');
  assert.match(initial.data.revision, /^[a-f0-9]{64}$/);
  const content = '\ufeff' + 'const large = "' + 'a'.repeat(80_000) + '";\r\n';
  const saved = await put(content, initial.data.revision);
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), content, 'text over the normal JSON request limit saves intact');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.equal((await put('stale', initial.data.revision)).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  fs.writeFileSync(file, 'changed by Claude');
  assert.equal((await put('stale editor', saved.data.revision)).status, 409);
  const fresh = await get();
  const saves = await Promise.all([put('first', fresh.data.revision), put('second', fresh.data.revision)]);
  assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409]);
});

test('workspace editor enforces login, CSRF, limits, UTF-8 and file roots', async (t) => {
  const { s, cookie, file, get, put } = await fixture(t);
  assert.equal((await s.request('GET', '/workspace.html')).status, 302);
  assert.equal((await s.request('GET', '/workspace.js')).status, 401);
  assert.equal((await s.request('GET', '/api/files/text?' + new URLSearchParams({ path: file }))).status, 401);
  const initial = await get();
  assert.equal((await put('new')).status, 428);
  assert.equal((await put('new', initial.data.revision, { 'x-pocket-dev': '' })).status, 403);
  assert.equal((await put('new', initial.data.revision, { origin: 'https://other.example' })).status, 403);
  assert.equal((await put(Buffer.from([255, 254]), initial.data.revision)).status, 415);
  assert.equal((await put('x'.repeat(1024 * 1024 + 1), initial.data.revision)).status, 413);
  const outside = path.join(s.root, 'outside.txt'); fs.writeFileSync(outside, 'private');
  const link = path.join(s.home, 'escape.txt'); fs.symlinkSync(outside, link);
  assert.equal((await get(outside)).status, 403);
  assert.equal((await get(link)).status, 403);
  const binary = path.join(s.home, 'binary'); fs.writeFileSync(binary, Buffer.from([1, 0, 2]));
  assert.equal((await get(binary)).status, 415);
  const big = path.join(s.home, 'big'); fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await get(big)).status, 413);
  assert.equal((await s.request('GET', '/', { cookie })).headers.get('x-frame-options'), 'DENY');
  assert.equal((await s.request('GET', '/?workspacePanel=1', { cookie })).headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('workspace creates files without overwriting and refuses traversal names', async (t) => {
  const { s, cookie } = await fixture(t);
  const create = (name) => s.request('POST', '/api/files/file', { cookie, body: { dir: s.home, name } });
  const first = await create('new.txt');
  assert.equal(first.status, 201);
  assert.equal(fs.readFileSync(first.data.path, 'utf8'), '');
  assert.equal((await create('new.txt')).status, 409);
  assert.equal((await create('../escape')).status, 400);
  assert.equal((await create('..\\escape')).status, 400);
  const temp = fs.readdirSync(s.home).filter((name) => name.startsWith('.pocket-dev-upload-'));
  assert.deepEqual(temp, []);
});
