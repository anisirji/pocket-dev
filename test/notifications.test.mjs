import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Chat } from '../src/chat/chat.js';
import { createNotifications, notificationSettings, updateNotificationSettings } from '../src/core/notifications.js';
import { startServer, until, pause } from './helpers/server.mjs';
const config = () => { let value = {}; return { read: () => value, update: (changes) => { value = { ...value, ...changes }; } }; };
const socket = () => Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, messages: [], send(text) { this.messages.push(JSON.parse(text)); }, close() { this.emit('close'); } });
const memoryChat = () => { const chat = new Chat({ id: 'abcdef012345', tool: 'codex', cwd: '/project', settings: {} }, '/not-written/chat.json'); chat.schedulePersist = chat.persist = () => {}; return chat; };

test('task activity uses confirmed engine outcomes and pending cards, including background helpers', async () => {
  const chat = memoryChat(); assert.equal(chat.activity, 'ready');
  chat.emit({ type: 'assistant-text', text: 'Finished writing a sentence.' }); assert.equal(chat.activity, 'ready');
  chat.startTurn(); assert.equal(chat.activity, 'working');
  const answer = chat.ask({ type: 'question', questions: [] }); assert.equal(chat.activity, 'awaiting-input'); chat.cancelRequests(); await answer;
  chat.emit({ id: 'helper', type: 'tool-run', agentStatus: 'running' }); chat.endTurn({ status: 'done' }); assert.equal(chat.activity, 'working');
  chat.update('helper', { agentStatus: 'ok' }); assert.equal(chat.activity, 'completed');
  chat.startTurn(); chat.endTurn({ status: 'interrupted' }); assert.equal(chat.activity, 'interrupted');
  chat.emit({ type: 'error', message: 'Disconnected' }); assert.equal(chat.activity, 'interrupted');
});
test('live notifications are deduplicated, do not replay on reconnect, and respect quiet preferences', () => {
  const settings = config(), hub = createNotifications({ config: settings, computerId: () => 'computer', computerName: () => 'Fixture computer' }), client = socket(); hub.attach(client, { id: 'device' });
  const chat = memoryChat(); chat.activityListener = hub.chatEvent;
  chat.startTurn(); chat.endTurn({ status: 'done' });
  assert.equal(client.messages.filter((message) => message.t === 'notification').length, 1);
  const result = chat.events.find((event) => event.type === 'result'); hub.chatEvent(chat, result);
  assert.equal(client.messages.filter((message) => message.t === 'notification').length, 1);
  const reconnect = socket(); hub.attach(reconnect, { id: 'device' }, [chat.view()]); assert.deepEqual(reconnect.messages.map((message) => message.t), ['hello']);
  updateNotificationSettings(settings, { preferences: { aiTasks: false }, updateNotify: false, updateCheck: true });
  chat.startTurn(); chat.endTurn({ status: 'done' }); assert.equal(client.messages.filter((message) => message.t === 'notification').length, 1);
  assert.deepEqual(notificationSettings(settings).updateCheck, true); assert.equal(notificationSettings(settings).updateNotify, false);
  hub.close();
});
test('completion is delayed until confirmed background helpers finish, with one alert', () => {
  const hub = createNotifications({ config: config() }), client = socket(), chat = memoryChat(); hub.attach(client, { id: 'device' }); chat.activityListener = hub.chatEvent;
  chat.startTurn(); chat.emit({ id: 'helper', type: 'tool-run', agentStatus: 'running' }); chat.endTurn({ status: 'done' });
  assert.equal(client.messages.filter((message) => message.t === 'notification').length, 0);
  chat.update('helper', { agentStatus: 'ok' }); chat.update('helper', { agentStatus: 'ok' });
  assert.equal(client.messages.filter((message) => message.t === 'notification').length, 1);
});
test('preferences reject unknown or non-boolean settings atomically', () => {
  const settings = config(), original = notificationSettings(settings);
  for (const body of [{ preferences: { sounds: 'yes' } }, { updateCheck: false, preferences: { unexpected: true } }, { shell: 'run something' }]) assert.throws(() => updateNotificationSettings(settings, body));
  assert.deepEqual(notificationSettings(settings), original);
});
test('notifications use an authenticated live socket and never replay a completed task after reconnect', { timeout: 30000 }, async (t) => {
  let tool = 'antigravity', env = { POCKET_DEV_AGY: fileURLToPath(new URL('./helpers/fake-agy.mjs', import.meta.url)) };
  if (process.platform === 'win32') {
    // The Windows Codex npm launcher executes JavaScript through Node without a
    // shell. Unlike a shebang fixture, it is an executable protocol stand-in here.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-notification-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const bin = path.join(root, 'codex.cmd'), entry = path.join(root, 'node_modules/@openai/codex/bin/codex.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(bin, 'This batch file must not execute.');
    fs.writeFileSync(entry, `const send=m=>console.log(JSON.stringify(m));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 const result=m.method==='model/list'?{data:[]}:m.method==='thread/start'?{thread:{id:'notification-fixture'},model:'fixture'}:m.method==='turn/start'?{turn:{id:'fixture-turn'}}:{};
 send({id:m.id,result});
 if(m.method==='turn/start')setTimeout(()=>send({method:'turn/completed',params:{threadId:'notification-fixture',turn:{id:'fixture-turn',status:'completed'}}}),80);
});`);
    tool = 'codex'; env = { POCKET_DEV_CODEX: bin };
  }
  const server = await startServer(t, { env }), login = await server.login();
  const connect = () => new WebSocket(server.base.replace('http', 'ws') + '/ws/notifications', { headers: { cookie: login.cookie, origin: server.base } });
  const messages = [], ws = connect(); t.after(() => ws.terminate()); ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await until(() => messages.some((message) => message.t === 'hello'));
  const call = (method, url, body) => server.request(method, url, { cookie: login.cookie, body });
  assert.equal((await server.request('GET', '/api/notifications')).status, 401);
  const chat = (await call('POST', '/api/chat', { tool, cwd: server.home })).data;
  await call('POST', `/api/chat/${chat.id}/message`, { text: 'echo-prompt fixture' });
  await until(() => messages.some((message) => message.t === 'notification' && /completed/.test(message.notification.title)));
  assert.equal(messages.filter((message) => message.t === 'notification').length, 1);
  assert.equal((await call('GET', `/api/chat/${chat.id}`)).data.activity, 'completed');
  ws.close(); const later = [], reconnect = connect(); t.after(() => reconnect.terminate()); reconnect.on('message', (raw) => later.push(JSON.parse(raw)));
  await until(() => later.some((message) => message.t === 'hello')); await pause(150);
  assert.equal(later.filter((message) => message.t === 'notification').length, 0);
  const saved = await call('PUT', '/api/notifications', { preferences: { sounds: false, aiTasks: false }, updateNotify: false, updateCheck: true });
  assert.equal(saved.status, 200); assert.equal(saved.data.preferences.aiTasks, false);
  assert.equal((await call('PUT', '/api/notifications', { preferences: { unsafe: true } })).status, 400);
});
test('private message alerts reach the intended owner device only, with no alert to the sender or other devices', { timeout: 30000 }, async (t) => {
  const server = await startServer(t), owners = [];
  for (const name of ['Sender', 'Recipient', 'Unrelated']) {
    const login = await server.login(), settings = (await server.request('GET', '/api/settings', { cookie: login.cookie })).data;
    await server.local('PATCH', `/api/devices/${settings.currentDeviceId}`, { name });
    const owner = { cookie: login.cookie, inbox: [] };
    const ws = new WebSocket(server.base.replace('http', 'ws') + '/ws/notifications', { headers: { cookie: owner.cookie, origin: server.base } });
    t.after(() => ws.terminate()); ws.on('message', (raw) => owner.inbox.push(JSON.parse(raw)));
    await until(() => owner.inbox.some((message) => message.t === 'hello')); owners.push(owner);
  }
  const people = (await server.request('GET', '/api/messages/people', { cookie: owners[0].cookie })).data.people;
  const recipient = people.find((person) => person.name === 'Recipient'); assert.ok(recipient);
  const sent = await server.request('POST', '/api/messages', { cookie: owners[0].cookie, body: { text: 'Private fixture message', to: recipient.id } }); assert.equal(sent.status, 201);
  await until(() => owners[1].inbox.some((message) => message.t === 'notification')); await pause(100);
  assert.equal(owners[0].inbox.filter((message) => message.t === 'notification').length, 0);
  assert.equal(owners[2].inbox.filter((message) => message.t === 'notification').length, 0);
  assert.equal(owners[1].inbox.filter((message) => message.t === 'notification').length, 1);
  assert.equal(owners[1].inbox.find((message) => message.t === 'notification').notification.body, 'Private fixture message');
});
