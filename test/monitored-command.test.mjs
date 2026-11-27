import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, until, pause } from './helpers/server.mjs';

test('opt-in Mac commands notify only their creator after confirmed exit and never rerun an accepted action', { skip: process.platform !== 'darwin', timeout: 30000 }, async (t) => {
  const server = await startServer(t, { env: { SHELL: '/bin/zsh' } }), login = await server.login();
  const second = await server.login({ headers: { 'user-agent': 'Second fixture device' } });
  const all = [], others = [];
  for (const [cookie, messages] of [[login.cookie, all], [second.cookie, others]]) {
    const ws = new WebSocket(server.base.replace('http', 'ws') + '/ws/notifications', { headers: { cookie, origin: server.base } });
    ws.on('message', (raw) => messages.push(JSON.parse(raw))); t.after(() => ws.terminate());
    await until(() => messages.some((message) => message.t === 'hello'));
  }
  const call = (method, endpoint, body) => server.request(method, endpoint, { cookie: login.cookie, body });
  const body = { cwd: server.home, command: 'printf x >> count.txt; sleep 0.2', monitor: true, requestId: 'command-fixture-action-1234' };
  const [first, duplicate] = await Promise.all([call('POST', '/api/sessions', body), call('POST', '/api/sessions', body)]);
  assert.equal(first.status, 201); assert.equal(first.data.id, duplicate.data.id);
  await until(() => all.some((message) => message.notification?.action?.id === first.data.id));
  assert.equal(fs.readFileSync(path.join(server.home, 'count.txt'), 'utf8'), 'x');
  const notice = all.find((message) => message.notification?.action?.id === first.data.id).notification;
  assert.equal(notice.title, 'Monitored command completed'); assert.equal(notice.category, 'builds');
  assert.equal(notice.action.kind, 'terminal'); assert.match(notice.body, /Exit code 0/);
  assert.doesNotMatch(JSON.stringify(notice), /count.txt|printf/);
  assert.equal(others.filter((message) => message.t === 'notification').length, 0, 'another login receives no command alert');
  assert.equal((await call('POST', '/api/sessions', { ...body, command: 'printf bad >> count.txt' })).status, 409);
  assert.equal((await call('POST', '/api/sessions', { monitor: true, command: 'echo bad' })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { monitor: 'yes' })).status, 400);
  const failed = await call('POST', '/api/sessions', { ...body, command: 'exit 7', requestId: 'command-fixture-failure-1234' });
  await until(() => all.some((message) => message.notification?.action?.id === failed.data.id));
  assert.match(all.find((message) => message.notification?.action?.id === failed.data.id).notification.body, /Exit code 7/);
  await call('DELETE', `/api/sessions/${first.data.id}`);
  assert.equal((await call('POST', '/api/sessions', body)).status, 409);
  assert.equal(fs.readFileSync(path.join(server.home, 'count.txt'), 'utf8'), 'x');
  const previous = all.filter((message) => message.t === 'notification').length;
  await call('PUT', '/api/notifications', { preferences: { builds: false } });
  const quiet = await call('POST', '/api/sessions', { ...body, command: 'exit 0', requestId: 'command-fixture-quiet-1234' });
  await until(async () => (await call('GET', '/api/sessions')).data.find((entry) => entry.id === quiet.data.id)?.exitCode === 0);
  await pause(100); assert.equal(all.filter((message) => message.t === 'notification').length, previous);
  const ordinary = await call('POST', '/api/sessions', { cwd: server.home, command: 'exit 0' });
  await until(async () => (await call('GET', '/api/sessions')).data.find((entry) => entry.id === ordinary.data.id)?.exitCode === 0);
  assert.equal(all.filter((message) => message.t === 'notification').length, previous, 'ordinary terminal activity stays quiet');
});
