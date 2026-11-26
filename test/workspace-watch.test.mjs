import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

test('workspace streams enforce authentication, file roots, canonical paths and bounded watches', async (t) => {
  const s = await startServer(t), { cookie } = await s.login(), root = fs.realpathSync(s.home);
  const endpoint = '/api/files/workspace?' + new URLSearchParams({ path: root });
  assert.equal((await s.request('GET', endpoint)).status, 401);
  const access = await s.request('GET', endpoint, { cookie });
  assert.equal(access.status, 200); assert.equal(access.data.root, root); assert.ok(access.data.owner); assert.ok(access.data.deviceId);
  assert.equal((await s.request('GET', '/api/files/workspace?' + new URLSearchParams({ path: s.root }), { cookie })).status, 403);
  const outside = path.join(root, 'outside'); fs.symlinkSync(s.root, outside, 'dir');
  const denied = await s.request('GET', '/api/files/watch?' + new URLSearchParams({ path: root, dir: outside }), { cookie }); assert.equal(denied.status, 403);
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(s.base + '/api/files/watch?' + new URLSearchParams({ path: root }), { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const packet = async (type) => {
    while (true) { let split; while ((split = buffer.indexOf('\n\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 2); if (line.startsWith('data: ')) { const data = JSON.parse(line.slice(6)); if (data.type === type) return data; } } const result = await reader.read(); if (result.done) throw new Error('Stream closed'); buffer += decoder.decode(result.value); }
  };
  const ready = await packet('ready'); assert.equal(ready.reset, true);
  fs.writeFileSync(path.join(root, 'changed.txt'), 'changed');
  const changed = await packet('changes'); assert.ok(changed.sequence > ready.sequence); assert.equal(changed.stream, ready.stream); assert.ok(changed.changes.some((c) => c.paths.includes(path.join(root, 'changed.txt'))));
  await s.request('POST', '/api/logout', { cookie });
  const revoked = await packet('revoked'); assert.ok(revoked.sequence > changed.sequence); controller.abort();
});

test('concurrent workspace feeds share the per-login limit and release their slots', { timeout: 30000 }, async (t) => {
  const s = await startServer(t), { cookie } = await s.login(), controllers = Array.from({ length: 6 }, () => new AbortController());
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const url = s.base + '/api/files/watch?' + new URLSearchParams({ path: fs.realpathSync(s.home) });
  const responses = await Promise.all(controllers.slice(0, 5).map((controller) => fetch(url, { headers: { cookie }, signal: controller.signal })));
  assert.equal(responses.filter((response) => response.status === 200).length, 4);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  const open = responses.findIndex((response) => response.status === 200); controllers[open].abort();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const replacement = await fetch(url, { headers: { cookie }, signal: controllers[5].signal });
  assert.equal(replacement.status, 200);
});
