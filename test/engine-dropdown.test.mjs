import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';
import { ENGINE_HELP, GENERIC_HELP, engineHelp } from '../src/chat/engine-help.js';

const FAKE_AGY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-agy.mjs');
const MISSING = path.join(os.tmpdir(), 'pocket-dev-no-such-engine');

test('every engine in the list carries install and sign-in help, with generic advice for an unknown one', () => {
  assert.deepEqual(ENGINE_HELP.claude.install, ['npm install -g @anthropic-ai/claude-code']);
  assert.equal(ENGINE_HELP.claude.login, 'claude auth login');
  assert.deepEqual(ENGINE_HELP.codex.install, ['npm install -g @openai/codex']);
  assert.equal(ENGINE_HELP.codex.login, 'codex login');
  assert.deepEqual(ENGINE_HELP.copilot.install, ['npm install -g @github/copilot']);
  assert.equal(ENGINE_HELP.copilot.login, 'copilot login');
  assert.equal(engineHelp('something-new'), GENERIC_HELP);
  for (const help of [...Object.values(ENGINE_HELP), GENERIC_HELP]) assert.ok(!/(token|password|secret)/i.test(JSON.stringify(help)));
});

test('the options the phone loads list all engines with their installed flag and help, missing ones included', async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_AGY: FAKE_AGY, POCKET_DEV_CODEX: MISSING } });
  const A = await s.login();
  const { status, data } = await s.request('GET', '/api/chat/options', { cookie: A.cookie });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(data.tools), ['claude', 'codex', 'antigravity', 'copilot']);
  assert.equal(data.tools.codex.installed, false);
  assert.equal(data.tools.antigravity.installed, true);
  for (const [tool, info] of Object.entries(data.tools)) assert.ok(info.help && Array.isArray(info.help.install), tool);
  assert.equal(data.tools.codex.help.login, 'codex login');
  assert.equal(data.tools.copilot.help.login, 'copilot login');
  assert.equal(data.tools.copilot.experimental, true);
});

test('a new chat with no messages can change engine', async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_AGY: FAKE_AGY, POCKET_DEV_CODEX: FAKE_AGY } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const created = await call('POST', '/api/chat', { tool: 'antigravity', cwd: s.home });
  assert.equal(created.status, 201);
  const switched = await call('POST', `/api/chat/${created.data.id}/engine`, { tool: 'codex' });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  const chat = (await call('GET', `/api/chat/${created.data.id}`)).data;
  assert.equal(chat.tool, 'codex');
  assert.deepEqual(chat.events.filter((e) => e.type === 'user-text' || e.type === 'assistant-text'), []);
});
