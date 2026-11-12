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

function firstRunFixture({ isTTY = true, done = false, env = {} } = {}) {
  const out = [], setups = [];
  const ctx = { isTTY, env, out: (l = '') => out.push(l), setupDone: { read: () => done, mark: () => { done = true; } } };
  const runSetup = async (args, c, opts) => { setups.push([args, opts]); if (!args.length) c.setupDone.mark(); return 0; };
  return { run: (noSetup = false) => firstRun({ ctx, runSetup, noSetup }), out, setups };
}

test('first interactive start runs the whole guide, once per computer', async () => {
  const f = firstRunFixture();
  assert.equal(await f.run(), 'ran');
  assert.deepEqual(f.setups, [[[], { fromStart: true }]]);
  assert.equal(await f.run(), 'skipped');
  assert.equal(f.setups.length, 1);
});

test('first start without a terminal prints the status table and the command, and goes on', async () => {
  const f = firstRunFixture({ isTTY: false });
  assert.equal(await f.run(), 'status');
  assert.deepEqual(f.setups.map(([args]) => args), [['--check']]);
  assert.match(f.out.join('\n'), /pocket-dev setup/);
  const ci = firstRunFixture({ env: { CI: 'true' } });
  assert.equal(await ci.run(), 'status', 'CI is never asked anything');
});

test('--no-setup or POCKET_DEV_NO_SETUP skips the guide for automation', async () => {
  const flag = firstRunFixture();
  assert.equal(await flag.run(true), 'skipped');
  const env = firstRunFixture({ env: { POCKET_DEV_NO_SETUP: '1' } });
  assert.equal(await env.run(), 'skipped');
  assert.equal(flag.setups.length + env.setups.length, 0);
});
