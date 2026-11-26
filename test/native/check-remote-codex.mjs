// Verifies the installed Codex isolation contract without a login or a model prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Chat } from '../../src/chat/chat.js';
import { createRemoteCodexEngine } from '../../src/chat/remote-codex.js';
import { connectCodexRpc } from '../../src/chat/codex-rpc.js';
import { isolatedEnv } from '../isolated-env.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-codex-isolation-'));
fs.mkdirSync(path.join(root, '.codex'));
const marker = path.join(root, 'inherited-server-ran');
fs.writeFileSync(path.join(root, '.codex', 'config.toml'), `[mcp_servers.inherited]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`])}\n`);
const chat = Chat.create({ tool: 'codex', cwd: root, settings: { model: 'default', effort: 'default' } }, root);
const engine = createRemoteCodexEngine(chat, { execute: async () => { throw new Error('No tools run in preflight'); },
  connect: (options) => connectCodexRpc({ ...options, env: isolatedEnv(root) }) });
try {
  await engine.start();
  assert.equal(fs.existsSync(marker), false, 'an inherited MCP process was not started');
  console.log('PASS: native Codex accepted an environment-free thread, disabled inherited MCP, and received no model prompt.');
} finally {
  await engine.stop(); chat.closed = true; clearTimeout(chat.persistTimer);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
