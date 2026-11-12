import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './isolated-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in for a Pocket Dev that already runs: its admin page answers, and its phone port mints login keys.
async function fakeRunningCopy(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-running-'));
  const state = path.join(home, '.pocket-dev');
  fs.mkdirSync(state);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/qr-key') return res.end(JSON.stringify({ url: 'http://192.168.1.9:7777/?k=fresh-key', expiresInMin: 5 }));
    res.end(req.url === '/api/state' ? '{"network":{"tunnel":null}}' : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  fs.writeFileSync(path.join(state, 'admin.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
  fs.writeFileSync(path.join(state, 'local-secret'), JSON.stringify({ port, secret: 'test-secret' }));
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return isolatedEnv(home, { POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1' });
}

const runCli = (env, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

test('pocket-dev start with a copy already running prints the address and the qr command, and exits 0', async (t) => {
  const env = await fakeRunningCopy(t);
  const r = await runCli(env, 'start');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Pocket Dev is already running in the background/);
  assert.match(r.stdout, /On the same Wi-Fi: http:\/\/192\.168\.1\.9:7777/);
  assert.match(r.stdout, /pocket-dev qr/);
  assert.doesNotMatch(r.stdout + r.stderr, /fresh-key/, 'no terminal: the key is not printed where a log keeps it');
  assert.equal(r.stderr, '');
});
