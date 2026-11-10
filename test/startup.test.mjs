import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openConfig } from '../config.js';
import { resolvePorts, runningInstance, firstRun, isFree } from '../startup.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const freeExcept = (busy) => async (port) => !busy.includes(port);

test('default port busy: next free ports are chosen and saved', async (t) => {
  const config = openConfig(path.join(tmp(t), 'config.json'));
  const r = await resolvePorts({ config, env: {}, free: freeExcept([7777, 7778]) });
  assert.equal(r.port, 7779);
  assert.equal(r.adminPort, 7780);
  assert.equal(config.read().port, 7779);
  const again = await resolvePorts({ config, env: {}, free: freeExcept([7777, 7778]) });
  assert.equal(again.port, 7779, 'a restart keeps the saved choice');
});

test('free default ports write nothing', async (t) => {
  const config = openConfig(path.join(tmp(t), 'config.json'));
  const r = await resolvePorts({ config, env: {}, free: freeExcept([]) });
  assert.deepEqual([r.port, r.adminPort], [7777, 7778]);
  assert.deepEqual(config.read(), {});
});

test('admin port alone busy moves only the admin port and skips the phone port', async (t) => {
  const config = openConfig(path.join(tmp(t), 'config.json'));
  const r = await resolvePorts({ config, env: {}, free: freeExcept([7778]) });
  assert.deepEqual([r.port, r.adminPort], [7777, 7779]);
});

test('an explicit port is never changed; the error names the owner', async (t) => {
  const config = openConfig(path.join(tmp(t), 'config.json'));
  const ownerOf = async () => ({ pid: 42, command: 'node' });
  await assert.rejects(resolvePorts({ config, env: { PORT: '7777' }, free: freeExcept([7777]), ownerOf }), /Port 7777 is in use by node \(pid 42\)\. You set it yourself/);
  config.update({ port: 8000 });
  await assert.rejects(resolvePorts({ config, env: {}, free: freeExcept([8000]), ownerOf }), /Port 8000 is in use/);
  config.update({ port: 8000, adminPort: 9000 });
  await assert.rejects(resolvePorts({ config, env: {}, free: freeExcept([9000]), ownerOf }), /Admin port 9000 is in use/);
  assert.equal(config.read().port, 8000);
});

test('editing a saved fallback port makes it explicit', async (t) => {
  const config = openConfig(path.join(tmp(t), 'config.json'));
  await resolvePorts({ config, env: {}, free: freeExcept([7777]) });
  config.update({ port: 7000 });
  await assert.rejects(resolvePorts({ config, env: {}, free: freeExcept([7000]) }), /in use/);
});

test('isFree sees a real listener', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const { port } = server.address();
  assert.equal(await isFree(port), false);
  await new Promise((r) => server.close(r));
  assert.equal(await isFree(port), true);
});

test('runningInstance answers only when the admin page is alive', async (t) => {
  const dir = tmp(t);
  assert.equal(await runningInstance(dir), null);
  const server = http.createServer((req, res) => res.end('{}'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({ url }));
  assert.equal(await runningInstance(dir), url);
  await new Promise((r) => server.close(r));
  assert.equal(await runningInstance(dir), null, 'a stale file is ignored');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const other = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({ url: other, pid: 2 ** 22 + 1 }));
  assert.equal(await runningInstance(dir), null, 'a dead owner pid means the file is stale even if the port answers');
  fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({ url: other, pid: process.pid }));
  assert.equal(await runningInstance(dir), other);
  await new Promise((r) => server.close(r));
});

function firstRunFixture(t, { isTTY = true, installed = false, answer = true } = {}) {
  const stateDir = tmp(t);
  const out = [];
  let asked = 0, setups = 0;
  const ctx = { isTTY, env: {}, out: (l = '') => out.push(l), ask: async () => { asked++; return answer; } };
  const detect = async (_, ids) => ids.map((id) => ({ id, installed }));
  const runSetup = async () => { setups++; };
  const run = () => firstRun({ stateDir, ctx, detect, runSetup });
  return { run, out, stateDir, counts: () => ({ asked, setups }) };
}

test('first run: Y runs setup, and it asks only once', async (t) => {
  const f = firstRunFixture(t);
  assert.equal(await f.run(), 'ran');
  assert.deepEqual(f.counts(), { asked: 1, setups: 1 });
  assert.equal(await f.run(), 'skipped');
  assert.equal(f.counts().asked, 1);
});

test('first run: n starts anyway and points at pocket-dev setup', async (t) => {
  const f = firstRunFixture(t, { answer: false });
  assert.equal(await f.run(), 'declined');
  assert.equal(f.counts().setups, 0);
  assert.match(f.out.join('\n'), /pocket-dev setup/);
});

test('first run never prompts without a terminal or when nothing is missing', async (t) => {
  const quiet = firstRunFixture(t, { isTTY: false });
  assert.equal(await quiet.run(), 'skipped');
  assert.equal(quiet.counts().asked, 0);
  assert.equal(fs.existsSync(path.join(quiet.stateDir, 'first-run-done')), false);
  const full = firstRunFixture(t, { installed: true });
  assert.equal(await full.run(), 'skipped');
  assert.equal(full.counts().asked, 0);
});
