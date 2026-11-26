import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCodexRpc } from '../src/chat/codex-rpc.js';
import { isolatedEnv } from './isolated-env.mjs';

test('Codex npm batch launchers run through Node with argument boundaries intact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket codex npm '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex.cmd');
  fs.writeFileSync(bin, 'this batch file must never execute');
  const entry = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === 'test/args') console.log(JSON.stringify({ id: m.id, result: process.argv.slice(2) }));
});`);
  const args = ['--disable', 'shell_tool', 'one argument & no shell'];
  const rpc = await connectCodexRpc({ bin, args, env: isolatedEnv(root) });
  t.after(() => rpc.close());
  assert.deepEqual(await rpc.call('test/args'), ['app-server', ...args]);
  await rpc.close();
  fs.rmSync(path.dirname(entry), { recursive: true });
  await assert.rejects(connectCodexRpc({ bin, env: isolatedEnv(root) }), /Cannot locate the Codex npm launcher/);
});
