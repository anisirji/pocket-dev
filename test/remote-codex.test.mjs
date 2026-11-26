import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteCodexEngine } from '../src/chat/remote-codex.js';
import { Chat } from '../src/chat/chat.js';

function fixture(t, { environments = [], servers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-remote-codex-'));
  const chat = Chat.create({ tool: 'codex', cwd: root, settings: { model: 'default', effort: 'default' } }, root);
  const calls = [], writes = [], tools = [];
  let options, closed = false;
  const rpc = { call: async (method, params) => {
    if (closed) throw new Error('closed');
    calls.push([method, params]);
    if (method === 'config/read') return { config: { mcp_servers: { files: { command: 'must-not-run' } } } };
    if (method === 'thread/start') return { thread: { id: 'shared-thread', environments }, model: 'test-model' };
    if (method === 'mcpServerStatus/list') return { data: servers };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }, write: (msg) => writes.push(msg), close: () => { closed = true; } };
  const engine = createRemoteCodexEngine(chat, { connect: async (given) => { options = given; return rpc; }, execute: async (name, args) => { tools.push([name, args]); return 'workspace content'; } });
  t.after(async () => { await engine.stop(); chat.closed = true; clearTimeout(chat.persistTimer); fs.rmSync(root, { recursive: true, force: true }); });
  return { chat, engine, rpc, calls, writes, tools, options: () => options, closed: () => closed };
}

test('shared Codex uses the source login with an independent environment-free thread and workspace tools', async (t) => {
  const f = fixture(t); await f.engine.start();
  assert.equal(f.options().socketPath, null, 'the owner daemon and private histories are not attached');
  assert.equal(f.options().experimental, true);
  const start = f.calls.find(([name]) => name === 'thread/start')[1];
  assert.deepEqual(start.environments, []);
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config.mcp_servers.files.enabled, false);
  assert.equal(start.config.features.shell_tool, false);
  assert.equal(start.config.features.apps, false);
  assert.ok(start.dynamicTools.some((tool) => tool.name === 'read_file'));
  f.chat.startTurn();
  await f.engine.send({ text: 'read the project', images: [{ mediaType: 'image/png', data: 'AAAA' }] });
  const turn = f.calls.find(([name]) => name === 'turn/start')[1];
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.input[1].url, 'data:image/png;base64,AAAA');
  assert.equal(turn.input[1].path, undefined, 'the source is never asked to open a consumer path');
  f.rpc.onMessage({ id: 11, method: 'item/tool/call', params: { threadId: 'shared-thread', tool: 'read_file', arguments: { path: 'src/app.js' } } });
  await new Promise(setImmediate);
  assert.deepEqual(f.tools, [['read_file', { path: 'src/app.js' }]]);
  assert.equal(f.writes.at(-1).result.contentItems[0].text, 'workspace content');
  f.rpc.onMessage({ method: 'item/started', params: { threadId: 'shared-thread', item: { id: 'answer', type: 'agentMessage', text: '' } } });
  f.rpc.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'shared-thread', itemId: 'answer', delta: 'Done' } });
  f.rpc.onMessage({ method: 'turn/completed', params: { threadId: 'shared-thread', turn: { status: 'completed' } } });
  assert.equal(f.chat.find('answer').text, 'Done');
  assert.equal(f.chat.status, 'idle');
});

test('Codex versions that ignore environment isolation are refused before any prompt', async (t) => {
  for (const environments of [null, [{ environmentId: 'local' }]]) {
    const f = fixture(t, { environments });
    await assert.rejects(f.engine.start(), /cannot isolate/);
    assert.equal(f.closed(), true);
    assert.equal(f.calls.some(([name]) => name === 'turn/start'), false);
  }
});

test('inherited MCP capabilities and source-computer tool approvals are never shared', async (t) => {
  const unsafe = fixture(t, { servers: [{ name: 'files', tools: { read: {} } }] });
  await assert.rejects(unsafe.engine.start(), /cannot isolate/);
  assert.equal(unsafe.closed(), true);
  const f = fixture(t); await f.engine.start();
  f.rpc.onMessage({ id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-thread', command: 'read source private files' } });
  await new Promise(setImmediate);
  assert.equal(f.writes.at(-1).error.code, -32601);
  assert.equal(f.tools.length, 0);
});
