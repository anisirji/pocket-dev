import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, pause } from './helpers/server.mjs';

const FAKE_AGY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-agy.mjs');

async function open(t, env = {}) {
  const s = await startServer(t, { env: { POCKET_DEV_AGY: FAKE_AGY, ...env } });
  const A = await s.login();
  const call = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
  const created = await call('POST', '/api/chat', { tool: 'antigravity', cwd: s.home });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const get = async () => (await call('GET', `/api/chat/${id}`)).data;
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const c = await get(); if (pred(c)) return c; await pause(40); }
    throw new Error(`timed out: ${JSON.stringify(await get())}`);
  };
  return { call, id, get, until };
}

test('Antigravity answers through agy acp, with its thinking, and the chat goes idle', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' })).status, 202);
  const chat = await c.until((x) => x.status === 'idle' && x.events.some((e) => e.type === 'assistant-text'));
  assert.equal(chat.tool, 'antigravity');
  assert.equal(chat.events.find((e) => e.type === 'assistant-text').text, 'Hello from agy');
  assert.equal(chat.events.find((e) => e.type === 'thinking').text, 'thinking');
  assert.equal(chat.sessionId, 'agy-session-1');
});

test('a permission request waits for the phone, and the choice reaches agy', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission' });
  const waiting = await c.until((x) => x.status === 'waiting-permission');
  const req = waiting.events.find((e) => e.type === 'permission-request');
  assert.equal(req.title, 'Run ls');
  assert.equal((await c.call('POST', `/api/chat/${c.id}/answer`, { requestId: req.requestId, decision: 'deny' })).status, 200);
  const done = await c.until((x) => x.status === 'idle' && x.events.some((e) => e.type === 'assistant-text'));
  assert.equal(done.events.find((e) => e.type === 'assistant-text').text, 'chose no');
  assert.equal(done.events.find((e) => e.type === 'tool-run').status, 'error');
});

test('Approve for this chat remembers the tool, so the next request is not asked', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission' });
  const req = (await c.until((x) => x.status === 'waiting-permission')).events.find((e) => e.type === 'permission-request');
  await c.call('POST', `/api/chat/${c.id}/answer`, { requestId: req.requestId, decision: 'allow-chat' });
  await c.until((x) => x.status === 'idle' && x.events.some((e) => e.text === 'chose ok'));
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'permission again' });
  const done = await c.until((x) => x.status === 'idle' && x.events.filter((e) => e.text === 'chose ok').length === 2);
  assert.equal(done.events.filter((e) => e.type === 'permission-request').length, 1);
});

test('Stop cancels the turn in agy', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'slow' });
  await c.until((x) => x.status === 'running' && x.events.some((e) => e.text === 'working'));
  await c.call('POST', `/api/chat/${c.id}/interrupt`, {});
  // The 5 second fallback in Pocket Dev would also end the turn, so a quick finish proves agy got the cancel.
  await c.until((x) => x.status === 'idle', 3000);
});

test('a signed-out agy says how to sign in', { timeout: 60000 }, async (t) => {
  const c = await open(t, { FAKE_AGY_SIGNED_OUT: '1' });
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' });
  const chat = await c.until((x) => x.events.some((e) => e.type === 'error'));
  assert.match(chat.events.find((e) => e.type === 'error').message, /agy acp --login/);
});

test('an agy that cannot start says so', { timeout: 60000 }, async (t) => {
  const c = await open(t, { POCKET_DEV_AGY: '/nonexistent/agy' });
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' });
  const chat = await c.until((x) => x.events.some((e) => e.type === 'error'));
  assert.match(chat.events.find((e) => e.type === 'error').message, /Could not start Antigravity/);
});

test('a chat that went to sleep resumes its agy session without replaying the old conversation', { timeout: 60000 }, async (t) => {
  const c = await open(t, { FAKE_AGY_LOAD: '1', POCKET_DEV_CHAT_IDLE_SECONDS: '1' });
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' });
  await c.until((x) => x.status === 'idle' && x.events.some((e) => e.type === 'assistant-text'));
  await pause(3500);
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'again' });
  const chat = await c.until((x) => x.status === 'idle' && x.events.filter((e) => e.type === 'result').length === 2);
  assert.ok(chat.events.some((e) => e.type === 'status' && /Waking up/.test(e.text)), 'the engine really slept and woke');
  assert.deepEqual(chat.events.filter((e) => e.type === 'assistant-text').map((e) => e.text), ['Hello from agy', 'Hello from agy']);
  assert.ok(!JSON.stringify(chat.events).includes('old answer'), 'the replayed history is not shown again');
});

test('the chosen model is sent to agy, and can be changed between turns', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  const picked = await c.call('PATCH', `/api/chat/${c.id}`, { settings: { model: 'claude-opus-4-6-thinking' } });
  assert.equal(picked.status, 200, JSON.stringify(picked.data));
  await c.call('POST', `/api/chat/${c.id}/message`, { text: 'hello' });
  const chat = await c.until((x) => x.status === 'idle' && x.events.some((e) => e.type === 'assistant-text'));
  assert.equal(chat.settings.model, 'claude-opus-4-6-thinking');
  const again = await c.call('PATCH', `/api/chat/${c.id}`, { settings: { model: 'gemini-3.8-flash-low' } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.applied.model, 'next-turn');
});

test('a spent Antigravity quota becomes a usage limit error, so the chat offers to continue with another model', { timeout: 60000 }, async (t) => {
  const c = await open(t);
  assert.equal((await c.call('POST', `/api/chat/${c.id}/message`, { text: 'quota-out' })).status, 202);
  const chat = await c.until((x) => x.status === 'idle' && x.events.some((e) => e.type === 'error'));
  const error = chat.events.find((e) => e.type === 'error');
  assert.equal(error.message, 'Antigravity usage limit reached. Resets in 153h25m35s.');
  assert.match(error.message, /\blimit reached\b/i);
});

test('only a short spent-quota answer counts as a limit; a normal answer that mentions a quota does not', async () => {
  const { antigravityQuotaNotice } = await import('../src/chat/limits.js');
  assert.equal(antigravityQuotaNotice('Hello from agy'), null);
  assert.equal(antigravityQuotaNotice('You can raise the quota in settings.'), null);
  assert.equal(antigravityQuotaNotice(`${'The quota section of the doc explains how limits are reached. '.repeat(10)}`), null);
  assert.deepEqual(antigravityQuotaNotice('Individual quota reached. Please upgrade.'), { type: 'error', message: 'Antigravity usage limit reached.' });
});
