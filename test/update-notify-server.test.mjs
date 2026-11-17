import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, until, pause } from './helpers/server.mjs';

// A real server with a stand-in registry. The notification goes to a record file, never to the screen.
async function registry(t, version) {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/latest`;
}
const recordFile = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rec-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'record'); };
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a pending update sends one desktop notification at server start', { timeout: 60000 }, async (t) => {
  const file = recordFile(t);
  const s = await startServer(t, { env: { POCKET_DEV_UPDATE_URL: await registry(t, '9.9.9'), POCKET_DEV_NO_UPDATE_CHECK: '0', POCKET_DEV_NOTIFY_RECORD: file } });
  await until(() => lines(file).length === 1);
  assert.deepEqual(lines(file)[0], { title: 'Pocket Dev', message: 'Pocket Dev 9.9.9 is available. Open Pocket Dev Admin and tap Update.' });
  await pause(500);
  assert.equal(lines(file).length, 1, 'only once');
  assert.ok(s.proc.exitCode === null);
});

test('no notification when the copy is current or the check is off', { timeout: 60000 }, async (t) => {
  const current = recordFile(t), off = recordFile(t);
  const first = await startServer(t, { env: { POCKET_DEV_UPDATE_URL: await registry(t, '0.0.1'), POCKET_DEV_NO_UPDATE_CHECK: '0', POCKET_DEV_NOTIFY_RECORD: current } });
  await until(async () => (await first.request('GET', '/api/health')).status === 401 || true);
  const second = await startServer(t, { env: { POCKET_DEV_UPDATE_URL: await registry(t, '9.9.9'), POCKET_DEV_NO_UPDATE_CHECK: '1', POCKET_DEV_NOTIFY_RECORD: off } });
  await pause(1500);
  assert.equal(lines(current).length, 0);
  assert.equal(lines(off).length, 0);
  assert.ok(second.proc.exitCode === null);
});
