import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTerminalHost, hostSocketPath } from '../terminals.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const env = { ...process.env, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const spec = (id, title) => ({ id, title, cwd: os.homedir(), shell: '/bin/zsh', env, cols: 80, rows: 24 });

async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(50); }
  assert.fail('Condition timed out');
}

// Each test gets its own state folder and so its own host; the host is shut down at the end.
function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-host-'));
  const opened = [];
  const open = async () => { const host = await openTerminalHost(state); opened.push(host); return host; };
  t.after(async () => {
    try { await (await openTerminalHost(state)).shutdown(); } catch {}
    for (const host of opened) host.close();
    await pause(100);
    fs.rmSync(state, { recursive: true, force: true });
  });
  return { state, open };
}

test('a shell keeps running when Pocket Dev disconnects, and the next Pocket Dev finds it with its output', async (t) => {
  const { open } = fixture(t);
  const first = await open();
  let seen = '';
  const shell = await first.create(spec('aaaaaaaaaaaa', 'app'));
  shell.onData((d) => { seen += d; });
  shell.write('echo BEFORE-$((6*7)); sleep 300 &\r');
  await until(() => /BEFORE-42/.test(seen));
  first.close();
  await pause(400);
  assert.ok(alive(shell.pid), 'the shell outlives the connection that started it');

  const second = await open();
  const [found] = await second.list();
  assert.deepEqual([found.id, found.title, found.exitCode], ['aaaaaaaaaaaa', 'app', null]);
  const { pty, scrollback } = await second.adopt(found);
  assert.match(scrollback, /BEFORE-42/, 'the output from before is replayed');
  let after = '';
  pty.onData((d) => { after += d; });
  pty.write('echo AFTER-$((6*8)); jobs\r');
  await until(() => /AFTER-48/.test(after));
  assert.match(after, /sleep 300/, 'a background job started before the restart is still there');
  assert.equal((after.match(/BEFORE-42/g) ?? []).length, 0, 'replayed output is not delivered a second time');
});

test('resize reaches the shell, and an exit code survives reconnecting', async (t) => {
  const { open } = fixture(t);
  const first = await open();
  let seen = '';
  const resized = await first.create(spec('bbbbbbbbbbbb', 'size'));
  resized.onData((d) => { seen += d; });
  resized.resize(100, 30);
  await pause(300);
  resized.write('stty size\r');
  await until(() => /30 100/.test(seen));

  let code = null;
  const quick = await first.create(spec('cccccccccccc', 'quick'));
  quick.onExit(({ exitCode }) => { code = exitCode; });
  quick.write('exit 3\r');
  await until(() => code === 3);
  first.close();
  await pause(300);
  const listed = Object.fromEntries((await (await open()).list()).map((x) => [x.title, x.exitCode]));
  assert.deepEqual(listed, { size: null, quick: 3 }, 'the exited tab still says how it ended');
});

test('closing a tab kills its shell and its processes, and shutdown removes the socket', async (t) => {
  const { state, open } = fixture(t);
  const host = await open();
  const shell = await host.create(spec('dddddddddddd', 'close-me'));
  shell.write('sleep 300 &\r');
  await pause(500);
  shell.kill();
  await until(() => !alive(shell.pid));
  assert.deepEqual(await host.list(), []);
  await host.shutdown();
  await until(() => !fs.existsSync(hostSocketPath(state)));
});

test('the socket is private, and a long state folder gets a short socket path', async (t) => {
  const { state, open } = fixture(t);
  await open();
  assert.equal(fs.statSync(hostSocketPath(state)).mode & 0o777, 0o600);
  const long = path.join(os.tmpdir(), 'x'.repeat(120));
  assert.ok(hostSocketPath(long).length < 100, 'under the unix socket path limit');
  assert.notEqual(hostSocketPath(long), path.join(long, 'terminals.sock'));
});

test('a second host on the same socket does not start; bad create requests are refused', async (t) => {
  const { open } = fixture(t);
  const host = await open();
  await assert.rejects(host.create({ ...spec('not-hex-id', 'x') }), /Bad create request/);
  await assert.rejects(host.create({ ...spec('eeeeeeeeeeee', 'x'), shell: 'zsh' }), /Bad create request/);
  await host.create(spec('ffffffffffff', 'ok'));
  await assert.rejects(host.create(spec('ffffffffffff', 'dup')), /Bad create request/, 'an id can only be used once');
});
