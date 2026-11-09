import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, pause } from './helpers/server.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.mjs');

test('helper agents show what they are doing, and the todo list is kept', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const id = (await call('POST', '/api/chat', { tool: 'claude', cwd: s.home })).data.id;
  await call('POST', `/api/chat/${id}/message`, { text: 'use the helpers' });

  await pause(500);
  let events = (await call('GET', `/api/chat/${id}`)).data.events;
  const h1 = events.find((e) => e.id === 'toolu_h1');
  const h2 = events.find((e) => e.id === 'toolu_h2');
  assert.equal(h1.status, 'running');
  assert.equal(h2.status, 'running');
  assert.equal(h1.steps, 2, 'two of the first helper\'s tool calls are counted');
  assert.match(h1.latest, /^Grep needle/, 'the latest one is kept');
  assert.equal(h2.steps, 1);
  assert.ok(Math.abs(Date.now() - h2.activeAt) < 5000, 'the time of the helper\'s last action is kept');
  assert.match(h2.latest, /^Bash npm test/);
  assert.equal(events.some((e) => e.id === 'toolu_c1'), false, 'a helper\'s own tool calls are not events of their own');

  const todo = events.find((e) => e.id === 'toolu_todo');
  assert.deepEqual(todo.todos, [{ text: 'Write plan', status: 'completed' }, { text: 'Build it', status: 'in_progress' }]);

  await pause(1000);
  // The first helper's result arrives at 0.7 s and the turn ends at 0.9 s, which marks anything still going as stopped.
  events = (await call('GET', `/api/chat/${id}`)).data.events;
  assert.equal(events.find((e) => e.id === 'toolu_h1').status, 'ok', 'a finished helper is marked done');
  assert.equal(events.find((e) => e.id === 'toolu_h2').status, 'stopped', 'a helper left running when the turn ends is stopped');
});

test('a background agent counts as running after its call returns, until the SDK says it finished', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const id = (await call('POST', '/api/chat', { tool: 'claude', cwd: s.home })).data.id;
  await call('POST', `/api/chat/${id}/message`, { text: 'start a bgagent' });
  const agent = async () => (await call('GET', `/api/chat/${id}`)).data.events.find((e) => e.id === 'toolu_bg');

  await pause(450);
  let ev = await agent();
  assert.equal(ev.status, 'ok', 'the call itself returned at once');
  assert.equal(ev.agentStatus, 'running', 'but the agent is still working');
  assert.equal(ev.steps, 3);
  assert.equal(ev.latest, 'Edit editing room.js');

  await pause(900);
  ev = await agent();
  assert.equal(ev.agentStatus, 'completed');
  assert.equal(ev.steps, 7);
});
