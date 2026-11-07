import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { connectCodexRpc } from '../chat/codex-rpc.js';
import { Chat } from '../chat/chat.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await pause(20); }
  assert.fail('Condition timed out');
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-'));
  const socketPath = path.join(dir, 'server.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const requests = [];
  let connections = 0;
  const reply = (ws, id, result) => ws.send(JSON.stringify({ id, result }));
  const notify = (ws, method, params) => ws.send(JSON.stringify({ method, params }));
  wss.on('connection', (ws) => {
    connections++;
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      requests.push(msg);
      if (msg.id == null || !msg.method) return;
      if (msg.method === 'initialize') return reply(ws, msg.id, { userAgent: 'fixture' });
      if (msg.method === 'model/list') return reply(ws, msg.id, { data: [{ model: 'fixture', displayName: 'Fixture', hidden: false }] });
      if (msg.method === 'thread/resume' && msg.params.threadId === 'locked') {
        return ws.send(JSON.stringify({ id: msg.id, error: { message: 'thread locked already has an active writer' } }));
      }
      if (msg.method === 'thread/resume' || msg.method === 'thread/start') {
        await pause(25);
        return reply(ws, msg.id, { thread: { id: msg.params.threadId || 'new-thread' }, model: 'fixture' });
      }
      if (msg.method === 'turn/start') return reply(ws, msg.id, { turn: { id: 'turn-1' } });
      if (msg.method === 'thread/unsubscribe') return reply(ws, msg.id, {});
      if (msg.method === 'never-answers') return;
      reply(ws, msg.id, { echo: msg.params });
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socketPath, wss, requests, notify, connections: () => connections };
}

test('shared daemon accepts multiple clients; disconnecting one leaves the other usable', async (t) => {
  const f = await fixture(t);
  const options = { bin: '/must-not-spawn', socketPath: f.socketPath };
  const a = await connectCodexRpc(options), b = await connectCodexRpc(options);
  t.after(() => { a.close(); b.close(); });
  assert.equal(a.shared, true);
  assert.equal(f.connections(), 2);
  assert.equal((await a.call('thread/resume', { threadId: 'terminal-thread' })).thread.id, 'terminal-thread');
  a.close();
  assert.equal((await b.call('model/list')).data.length, 1);
  assert.equal(f.requests.some((r) => /shutdown|archive/.test(r.method)), false);
});

test('missing and stale sockets fall back to stdio; timeouts and close reject pending calls', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-stdio-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
});
`, { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const stale of [false, true]) {
    const socketPath = path.join(dir, stale ? 'stale.sock' : 'absent.sock');
    if (stale) {
      execFileSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socketPath]);
      assert.equal(fs.statSync(socketPath).isSocket(), true);
    }
    const rpc = await connectCodexRpc({ bin, env: process.env, socketPath });
    t.after(() => rpc.close());
    assert.equal(rpc.shared, false);
    await assert.rejects(rpc.call('never-answers', {}, 15), /did not answer/);
    const pending = rpc.call('never-answers');
    rpc.close();
    await assert.rejects(pending, /connection closed/);
    await assert.rejects(rpc.call('anything'), /reconnect/);
  }
});

test('shared server loss rejects calls and reports the disconnect once', async (t) => {
  const f = await fixture(t);
  const rpc = await connectCodexRpc({ socketPath: f.socketPath });
  t.after(() => rpc.close());
  const gone = [];
  rpc.onGone = (err) => gone.push(err.message);
  const pending = rpc.call('never-answers');
  for (const ws of f.wss.clients) ws.terminate();
  await assert.rejects(pending, /disconnected/);
  await until(() => gone.length === 1);
  rpc.close();
  assert.equal(gone.length, 1);
});

async function engineFixture(t) {
  const f = await fixture(t);
  const oldSocket = process.env.POCKET_DEV_CODEX_SOCKET;
  const oldBin = process.env.POCKET_DEV_CODEX;
  process.env.POCKET_DEV_CODEX_SOCKET = f.socketPath;
  process.env.POCKET_DEV_CODEX = '/must-not-spawn';
  let codex;
  try { codex = await import(`../chat/codex.js?fixture=${encodeURIComponent(f.dir)}`); }
  finally {
    if (oldSocket === undefined) delete process.env.POCKET_DEV_CODEX_SOCKET; else process.env.POCKET_DEV_CODEX_SOCKET = oldSocket;
    if (oldBin === undefined) delete process.env.POCKET_DEV_CODEX; else process.env.POCKET_DEV_CODEX = oldBin;
  }
  const makeChat = (sessionId) => {
    const chat = Chat.create({ tool: 'codex', cwd: f.dir, sessionId, settings: { model: 'default', approvalPolicy: 'untrusted', sandbox: 'workspace-write', effort: 'default' } }, f.dir);
    const engine = codex.createCodexEngine(chat);
    chat.engine = engine;
    t.after(async () => { await engine.stop(); chat.remove(); });
    return { chat, engine };
  };
  return { ...f, codex, makeChat };
}

test('model discovery and startup share a connection without racing; questions and replies round-trip', async (t) => {
  const f = await engineFixture(t);
  const { chat, engine } = f.makeChat('terminal-thread');
  const [models] = await Promise.all([f.codex.listModels(), engine.start()]);
  assert.equal(models[1].value, 'fixture');
  assert.equal(f.connections(), 1);
  chat.startTurn();
  await engine.send({ text: 'hello', images: [] });
  const ws = [...f.wss.clients][0];
  f.notify(ws, 'item/started', { threadId: chat.sessionId, item: { type: 'agentMessage', id: 'reply', text: '' } });
  f.notify(ws, 'item/agentMessage/delta', { threadId: chat.sessionId, itemId: 'reply', delta: 'Hello' });
  ws.send(JSON.stringify({ id: 'ask-1', method: 'item/tool/requestUserInput', params: { threadId: chat.sessionId, questions: [{ id: 'q', header: 'Choose', question: 'Which option?', options: [{ label: 'One', description: 'First' }] }] } }));
  await until(() => chat.requests.size === 1);
  assert.equal(chat.find('reply').text, 'Hello');
  const [requestId, request] = [...chat.requests][0];
  assert.equal(request.event.questions[0].options[0].label, 'One');
  chat.answer(requestId, { answers: { q: ['One'] } });
  await until(() => f.requests.some((r) => r.id === 'ask-1' && r.result));
  assert.deepEqual(f.requests.find((r) => r.id === 'ask-1' && r.result).result, { answers: { q: { answers: ['One'] } } });
  f.notify(ws, 'turn/completed', { threadId: chat.sessionId, turn: { id: 'turn-1', status: 'completed' } });
  await until(() => chat.turn === null);
  assert.equal(chat.events.at(-1).status, 'done');
  await engine.stop();
  await until(() => f.wss.clients.size === 0);
});

test('a foreign writer gets an actionable error and releases the failed startup connection', async (t) => {
  const f = await engineFixture(t);
  const { engine } = f.makeChat('locked');
  await assert.rejects(engine.start(), /Close its original Codex session/);
  await until(() => f.wss.clients.size === 0);
  const next = f.makeChat('another-thread');
  await next.engine.start();
  assert.equal(next.chat.sessionId, 'another-thread');
  assert.equal(f.connections(), 2);
});

test('Never ask takes effect during a turn, declines pending and new approvals, and preserves questions', async (t) => {
  const f = await engineFixture(t);
  const { chat, engine } = f.makeChat('approval-thread');
  await engine.start();
  chat.startTurn();
  await engine.send({ text: 'work', images: [] });
  const ws = [...f.wss.clients][0];
  const request = (id, method, params = {}) => ws.send(JSON.stringify({ id, method, params: { threadId: chat.sessionId, ...params } }));
  const response = (id) => f.requests.find((r) => r.id === id && r.result)?.result;
  request('pending-command', 'item/commandExecution/requestApproval', { command: 'fixture-command' });
  request('question', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Which folder?', options: [{ label: 'One' }] }] });
  await until(() => chat.requests.size === 2);
  chat.settings.approvalPolicy = 'never';
  const applied = await engine.configure({ approvalPolicy: 'never', effort: 'high' });
  assert.deepEqual(applied, { approvalPolicy: 'now', effort: 'next-turn' });
  await until(() => response('pending-command'));
  assert.equal(response('pending-command').decision, 'decline');
  assert.equal(chat.requests.size, 1);
  assert.equal([...chat.requests.values()][0].event.type, 'question');
  const promptsBefore = chat.events.filter((e) => e.type === 'permission-request').length;
  chat.addGrant('files');
  request('new-command', 'item/commandExecution/requestApproval', { command: 'another-command' });
  request('file-change', 'item/fileChange/requestApproval', { itemId: 'file' });
  request('cancel-only', 'item/commandExecution/requestApproval', { command: 'cancel-command', availableDecisions: ['accept', 'cancel'] });
  await until(() => response('new-command') && response('file-change') && response('cancel-only'));
  assert.equal(response('new-command').decision, 'decline');
  assert.equal(response('file-change').decision, 'decline', 'Never ask must not auto-approve an old grant');
  assert.equal(response('cancel-only').decision, 'cancel');
  assert.equal(chat.events.filter((e) => e.type === 'permission-request').length, promptsBefore);
  const questionId = [...chat.requests.keys()][0];
  chat.answer(questionId, { answers: { q: ['One'] } });
  await until(() => response('question'));
  assert.deepEqual(response('question'), { answers: { q: { answers: ['One'] } } });
  f.notify(ws, 'turn/completed', { threadId: chat.sessionId, turn: { id: 'turn-1', status: 'completed' } });
  await until(() => chat.turn === null);
  chat.startTurn();
  await engine.send({ text: 'continue', images: [] });
  assert.equal(f.requests.filter((r) => r.method === 'turn/start').at(-1).params.approvalPolicy, 'never');
});
