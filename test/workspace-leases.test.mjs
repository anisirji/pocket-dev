import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatApi } from '../src/chat/index.js';

// The API and fake engines run in process; this checks competing conversations without opening a server port.
test('overlapping workspace turns and background helpers exclude another writer, while separate worktrees run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-workspace-leases-'));
  const originalDir = process.env.POCKET_DEV_CHAT_DIR;
  process.env.POCKET_DEV_CHAT_DIR = path.join(root, 'chats');
  let api;
  t.after(async () => { await api?.close(); if (originalDir === undefined) delete process.env.POCKET_DEV_CHAT_DIR; else process.env.POCKET_DEV_CHAT_DIR = originalDir; fs.rmSync(root, { recursive: true, force: true }); });
  const a = path.join(root, 'project'), nested = path.join(a, 'src'), separate = path.join(root, 'worktree');
  for (const dir of [a, nested, separate]) fs.mkdirSync(dir, { recursive: true });
  const running = new Map();
  const engine = { label: 'Claude', settingsSchema: async () => [], installed: () => true,
    create(chat) {
      running.set(chat.id, chat);
      return { start: async () => {}, stop: async () => {}, configure: async () => ({}), interrupt: async () => chat.endTurn({ status: 'interrupted' }),
        send: async ({ text }) => {
          if (text === 'background') { chat.emit({ type: 'tool-run', agentStatus: 'running', status: 'ok' }); chat.endTurn({ status: 'done' }); }
          else if (text !== 'hold') chat.endTurn({ status: 'done' });
        } };
    },
  };
  let config = {};
  api = createChatApi({ engines: { claude: engine }, config: { read: () => config, update: (patch) => { config = { ...config, ...patch }; } },
    readJson: async (req) => req.body, sendJson: (res, status, body) => { Object.assign(res, { status, body }); } });
  const call = async (method, route, body) => { const res = {}; await api.handleApi({ method, body }, res, route); await new Promise(setImmediate); return res; };
  const make = async (cwd) => (await call('POST', '/api/chat', { tool: 'claude', cwd })).body.id;
  const first = await make(a), second = await make(nested), other = await make(separate);
  await call('POST', `/api/chat/${first}/message`, { text: 'hold' });
  await call('POST', `/api/chat/${second}/message`, { text: 'hold' });
  assert.equal((await call('GET', `/api/chat/${second}`)).body.status, 'error');
  await call('POST', `/api/chat/${other}/message`, { text: 'hold' });
  assert.equal((await call('GET', `/api/chat/${other}`)).body.status, 'running');
  await call('POST', `/api/chat/${first}/interrupt`);
  await call('POST', `/api/chat/${second}/message`, { text: 'hold' });
  assert.equal((await call('GET', `/api/chat/${second}`)).body.status, 'running');
  await call('POST', `/api/chat/${second}/interrupt`);
  await call('POST', `/api/chat/${first}/message`, { text: 'background' });
  assert.equal((await call('GET', `/api/chat/${first}`)).body.status, 'idle');
  await call('POST', `/api/chat/${second}/message`, { text: 'hold' });
  assert.match((await call('GET', `/api/chat/${second}`)).body.events.at(-2).message, /helper/);
  const helper = running.get(first).events.find((event) => event.agentStatus === 'running');
  running.get(first).update(helper.id, { agentStatus: 'completed' });
  await call('POST', `/api/chat/${second}/message`, { text: 'hold' });
  assert.equal((await call('GET', `/api/chat/${second}`)).body.status, 'running');
});
