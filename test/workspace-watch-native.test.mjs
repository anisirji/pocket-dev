import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { watchWorkspace } from '../src/workspace/watch.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (check()) return; await pause(25); }
  assert.fail('Filesystem notification timed out');
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-native-watch-')), root = fs.realpathSync(temp), dir = path.join(root, 'src');
  fs.mkdirSync(dir);
  const messages = [], res = new EventEmitter();
  Object.assign(res, { writableLength: 0, writeHead(status, headers) { this.status = status; this.headers = headers; }, write(text) { if (text.startsWith('data: ')) messages.push(JSON.parse(text.slice(6))); }, end() { this.ended = true; } });
  const validate = async (given) => { assert.ok(given === root || given === dir); await fs.promises.stat(given); };
  t.after(() => { res.emit('close'); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, dir, res, messages, validate };
}
async function ready(f, dir) {
  // Native watcher registration can settle asynchronously. Establish the fixture before testing a single mutation.
  const probe = path.join(dir, '.watch-ready'); let n = 0;
  const timer = setInterval(() => fs.writeFileSync(probe, String(++n)), 250);
  try { await until(() => f.messages.some((m) => m.type === 'changes' && m.changes.some((c) => c.dir === dir))); }
  finally { clearInterval(timer); fs.rmSync(probe, { force: true }); }
}
const reported = (message, file) => message.type === 'changes' && message.changes.some((change) => change.paths.some((p) => file === p || file.startsWith(p + path.sep)));

test('native directory events report create and rename, sequence updates, and close on revoked access', async (t) => {
  const f = fixture(t); let active = true;
  watchWorkspace({ ...f, req: {}, directories: [f.root, f.dir], active: () => active });
  assert.equal(f.res.status, 200); assert.equal(f.messages[0].type, 'ready');
  await ready(f, f.dir);
  const file = path.join(f.dir, 'example.js'), renamed = path.join(f.dir, 'renamed.js');
  const created = f.messages.length;
  fs.writeFileSync(file, 'first');
  await until(() => f.messages.slice(created).some((message) => reported(message, file)));
  const before = f.messages.length;
  fs.renameSync(file, renamed);
  await until(() => f.messages.slice(before).some((message) => reported(message, file) || reported(message, renamed)));
  for (let i = 1; i < f.messages.length; i++) { assert.equal(f.messages[i].stream, f.messages[0].stream); assert.equal(f.messages[i].sequence, f.messages[i - 1].sequence + 1); }
  active = false; fs.writeFileSync(renamed, 'after revocation');
  await until(() => f.res.ended);
  assert.equal(f.messages.at(-1).type, 'revoked');
  const stopped = f.messages.length; fs.writeFileSync(renamed, 'no further notifications'); await pause(200); assert.equal(f.messages.length, stopped);
});

test('native watcher closes a client whose output buffer exceeds its bound', async (t) => {
  const f = fixture(t);
  watchWorkspace({ ...f, req: {}, directories: [f.root] });
  await ready(f, f.root); const before = f.messages.length;
  f.res.writableLength = 257 * 1024;
  fs.writeFileSync(path.join(f.root, 'change.txt'), 'changed');
  await until(() => f.res.ended);
  assert.equal(f.messages.length, before, 'backpressured notifications were not queued');
});
