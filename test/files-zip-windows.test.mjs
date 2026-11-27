import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { startServer } from './helpers/server.mjs';

test('native Windows folder ZIP preserves nested and empty directories without following outside junctions', { skip: process.platform !== 'win32', timeout: 45000 }, async (t) => {
  const server = await startServer(t), login = await server.login();
  const folder = path.join(server.home, 'zip project'), outside = path.join(server.root, 'outside');
  fs.mkdirSync(path.join(folder, 'empty'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'nested'), { recursive: true }); fs.mkdirSync(outside);
  const content = Buffer.from('Native Windows ZIP: café\r\n');
  fs.writeFileSync(path.join(folder, 'nested', 'résumé.txt'), content);
  fs.writeFileSync(path.join(outside, 'outside-sentinel.txt'), 'NOT_IN_ARCHIVE');
  fs.symlinkSync(outside, path.join(folder, 'outside-link'), 'junction');
  const previousTemporary = new Set(fs.readdirSync(os.tmpdir()));
  const response = await fetch(server.base + '/api/files/zip?' + new URLSearchParams({ path: folder }), { headers: { cookie: login.cookie }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, response.ok ? undefined : await response.text()); assert.equal(response.headers.get('content-type'), 'application/zip');
  const archive = Buffer.from(await response.arrayBuffer()), entries = new Map();
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex')); assert.ok(end >= 0);
  let offset = archive.readUInt32LE(end + 16);
  while (offset + 46 <= archive.length && archive.readUInt32LE(offset) === 0x02014b50) {
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
    const size = archive.readUInt32LE(offset + 20), length = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (name.includes('résumé')) assert.ok(flags & 0x800, 'Unicode names declare UTF-8');
    const local = archive.readUInt32LE(offset + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const bytes = archive.subarray(start, start + size);
    assert.ok(method === 0 || method === 8); entries.set(name, method === 8 ? inflateRawSync(bytes) : bytes);
    offset += 46 + length + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  assert.ok(entries.has('zip project/empty/'));
  assert.doesNotMatch([...entries.keys()].join('\n'), /outside-link|outside-sentinel/);
  assert.deepEqual(entries.get('zip project/nested/résumé.txt'), content);
  fs.renameSync(path.join(folder, 'nested', 'résumé.txt'), path.join(folder, 'nested', 'plain.txt'));
  const ascii = await fetch(server.base + '/api/files/zip?' + new URLSearchParams({ path: folder }), { headers: { cookie: login.cookie }, signal: AbortSignal.timeout(20000) });
  assert.equal(ascii.status, 200, ascii.ok ? undefined : await ascii.text());
  const asciiArchive = Buffer.from(await ascii.arrayBuffer()); assert.equal(asciiArchive.readUInt32LE(0), 0x04034b50);
  assert.doesNotMatch(asciiArchive.toString('utf8'), /outside-link|outside-sentinel/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('pocket-zip-') && !previousTemporary.has(name)), [], 'the private archive is removed after download');
});
