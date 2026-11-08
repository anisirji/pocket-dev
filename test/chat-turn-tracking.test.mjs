import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, pause } from './helpers/server.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.mjs');

test('a chat says running for as long as Claude works, including a turn nobody asked for', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const created = await call('POST', '/api/chat', { tool: 'claude', cwd: s.home });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  assert.equal((await call('POST', `/api/chat/${id}/message`, { text: 'please do the background thing' })).status, 202);

  // The fake answers and finishes, then 600 ms later starts working again on its own and finishes at 1.8 s.
  const seen = [];
  const stopVisible = [];
  const end = Date.now() + 3500;
  while (Date.now() < end) {
    const chat = (await call('GET', `/api/chat/${id}`)).data;
    if (seen.at(-1) !== chat.status) seen.push(chat.status);
    if (chat.status === 'running') stopVisible.push(chat.runningSince !== null);
    await pause(40);
  }
  assert.deepEqual(seen, ['running', 'idle', 'running', 'idle'], `the second stretch of work is seen as a turn: ${seen.join(' → ')}`);
  assert.ok(stopVisible.length && stopVisible.every(Boolean), 'runningSince is set whenever it says running, which is what shows Stop');
  const events = (await call('GET', `/api/chat/${id}`)).data.events;
  assert.equal(events.filter((e) => e.type === 'result').length, 2, 'both turns ended with a result');
});

test('a plain answer is still one turn: running, then idle', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const id = (await call('POST', '/api/chat', { tool: 'claude', cwd: s.home })).data.id;
  await call('POST', `/api/chat/${id}/message`, { text: 'hello' });
  const seen = [];
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const status = (await call('GET', `/api/chat/${id}`)).data.status;
    if (seen.at(-1) !== status) seen.push(status);
    await pause(40);
  }
  assert.deepEqual(seen.filter((x) => x !== 'running' || seen.indexOf(x) === 0), ['running', 'idle'].slice(0, seen.length > 1 ? 2 : 1));
  assert.equal(seen.at(-1), 'idle');
  assert.ok(seen.filter((x) => x === 'running').length === 1, `no extra turns appear: ${seen.join(' → ')}`);
});
