import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer, until, pause } from './helpers/server.mjs';
import { remoteClaudeOptions } from '../src/chat/remote-claude.js';
import { createWorkspaceTools } from '../src/chat/workspace-tools.js';
import { Chat } from '../src/chat/chat.js';

const fake = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
async function device(t) {
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: fake, POCKET_DEV_ROOM_PING_MS: '200' } });
  s.cookie = (await s.login()).cookie;
  s.call = (method, url, body) => s.request(method, url, { cookie: s.cookie, body });
  s.id = (await s.call('GET', '/api/room')).data.deviceId;
  s.to = (target, method, url, body) => s.call(method, `/m/${target.id}${url}`, body);
  return s;
}
async function pair(t, type = 'external') {
  const a = await device(t), b = await device(t);
  const invite = await a.call('POST', '/api/connections/invite', { connectionType: type });
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const joined = await b.call('POST', '/api/connections/join', { code: invite.data.code, host: a.base, name: 'Workspace B', connectionType: type, addresses: [b.base] });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  return { a, b };
}
async function share(source, consumer, type = 'claude') {
  assert.equal((await source.call('PATCH', `/api/connections/${consumer.id}`, { ai: [type] })).status, 200);
  assert.equal((await source.call('PATCH', `/api/connections/providers/${type}`, { enabled: true })).status, 200);
}

test('membership gives neither computer access nor provider access; only target approval grants access', async (t) => {
  const { a, b } = await pair(t);
  for (const [front, target] of [[a, b], [b, a]]) {
    for (const endpoint of ['/api/files/places', '/api/sessions', '/api/chat', '/api/settings', '/api/power']) assert.equal((await front.to(target, 'GET', endpoint)).status, 403, endpoint);
    assert.deepEqual((await front.to(target, 'GET', '/api/ai/providers')).data.providers, []);
  }
  assert.equal((await a.call('PATCH', `/api/connections/${b.id}`, { computerAccess: true })).status, 400);
  assert.equal((await a.call('PATCH', `/api/connections/${b.id}`, { computerAccess: true, confirmOwnership: true })).status, 200);
  assert.equal((await b.to(a, 'GET', '/api/files/places')).status, 200);
  assert.equal((await a.to(b, 'GET', '/api/files/places')).status, 403, 'the opposite grant is independent');
  assert.equal((await b.to(a, 'PATCH', `/api/connections/${b.id}`, { computerAccess: true, confirmOwnership: true })).status, 403);
  await a.call('PATCH', `/api/connections/${b.id}`, { computerAccess: false });
  assert.equal((await b.to(a, 'GET', '/api/files/places')).status, 403);
});

test('personal pairing explicitly grants only the paired computers; later members do not inherit access', async (t) => {
  const { a, b } = await pair(t, 'personal');
  assert.equal((await b.to(a, 'GET', '/api/files/places')).status, 200);
  assert.equal((await a.to(b, 'GET', '/api/files/places')).status, 200);
  const c = await device(t);
  const invite = (await a.call('POST', '/api/connections/invite', { connectionType: 'external' })).data;
  assert.equal((await c.call('POST', '/api/connections/join', { host: a.base, code: invite.code, addresses: [c.base] })).status, 200);
  await until(async () => (await b.call('GET', '/api/room')).data.room.members.length === 3);
  assert.equal((await c.to(b, 'GET', '/api/files/places')).status, 403);
  assert.equal((await b.to(c, 'GET', '/api/files/places')).status, 403);
  await share(b, c);
  const received = await c.to(b, 'GET', '/api/ai/providers');
  assert.equal(received.status, 200, JSON.stringify(received.data));
  assert.deepEqual(received.data.providers.map((p) => p.type), ['claude']);
  assert.equal((await c.to(a, 'GET', '/api/files/places')).status, 403);
});

test('AI discovery is directional, provider-specific and revocable; no room chat or message sync', async (t) => {
  const { a, b } = await pair(t);
  await share(a, b);
  const providers = await b.to(a, 'GET', '/api/ai/providers');
  assert.equal(providers.status, 200, JSON.stringify(providers.data));
  assert.deepEqual(providers.data.providers.map((p) => p.type), ['claude']);
  assert.deepEqual((await a.to(b, 'GET', '/api/ai/providers')).data.providers, []);
  assert.equal((await b.to(a, 'GET', '/api/chat')).status, 403);
  const opts = (await b.call('GET', '/api/chat/options')).data;
  assert.ok(opts.tools[`claude@${a.id}`]);
  assert.equal((await b.call('POST', '/api/room/sync/chats/pull', {})).status, 410);
  assert.equal((await b.call('POST', '/api/room/sync/messages/pull', {})).status, 410);
  await a.call('PATCH', '/api/connections/providers/claude', { enabled: false });
  assert.deepEqual((await b.to(a, 'GET', '/api/ai/providers')).data.providers, []);
  assert.equal((await b.call('POST', '/api/chat', { tool: `claude@${a.id}`, cwd: b.home })).status, 403);
});

test('shared Claude uses the original chat lifecycle and source switching preserves history', async (t) => {
  const { a, b } = await pair(t);
  await share(a, b);
  const created = await b.call('POST', '/api/chat', { tool: `claude@${a.id}`, cwd: b.home });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  assert.equal(created.data.provider.deviceId, a.id);
  assert.equal(created.data.workspace.deviceId, b.id);
  assert.equal((await b.call('POST', `/api/chat/${id}/message`, { text: 'hello' })).status, 202);
  let chat;
  await until(async () => { chat = (await b.call('GET', `/api/chat/${id}`)).data; return chat.events.some((e) => e.text === 'first answer') && chat.status === 'idle'; }, 15000);
  assert.equal((await a.call('GET', '/api/chat')).data.length, 0, 'consumer chats never join the owner history');
  const switched = await b.call('POST', `/api/chat/${id}/engine`, { tool: 'claude' });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.provider.deviceId, b.id);
  const after = (await b.call('GET', `/api/chat/${id}`)).data;
  assert.ok(after.events.some((e) => e.text === 'first answer'));
});

test('remote Claude options remove all local tools and inherited configuration', async () => {
  const opts = remoteClaudeOptions(async () => 'ok');
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.settings.disableAllHooks, true);
  assert.equal((await opts.canUseTool('Bash', { command: 'echo host' })).behavior, 'deny');
  assert.equal((await opts.canUseTool('Read', { file_path: '/etc/passwd' })).behavior, 'deny');
  assert.equal((await opts.canUseTool('mcp__workspace__read_file', { path: 'src/a.js' })).behavior, 'allow');
});

test('workspace file tools reject traversal, symlinks, secrets, and require approvals before writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-ai-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'workspace');
  fs.writeFileSync(path.join(root, 'private.txt'), 'host private');
  fs.symlinkSync(path.join(root, 'private.txt'), path.join(cwd, 'link'));
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=hidden');
  const chat = Chat.create({ tool: 'claude', cwd, settings: {} }, root); chat.startTurn();
  const workspace = createWorkspaceTools(chat, { sandbox: null });
  t.after(() => { workspace.close(); clearTimeout(chat.persistTimer); });
  assert.equal(await workspace.execute('read_file', { path: 'a.txt' }), 'workspace');
  for (const file of ['../private.txt', 'link', '.env']) await assert.rejects(workspace.execute('read_file', { path: file }));
  const writing = workspace.execute('write_file', { path: 'a.txt', content: 'updated' });
  await until(() => chat.requests.size === 1);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'workspace');
  chat.answer([...chat.requests.keys()][0], { decision: 'allow' }); await writing;
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'updated');
  workspace.close();
  await assert.rejects(workspace.execute('read_file', { path: 'a.txt' }), /no longer active/);
});

test('room host cannot impersonate a trusted computer using its relay credentials', async (t) => {
  const { a, b } = await pair(t, 'personal');
  const held = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'room.json'), 'utf8'));
  const headers = { 'x-room-id': held.room.id, 'x-room-sender': b.id, 'x-room-from': b.id, 'x-room-secret': held.room.memberSecret, 'x-connection-target': a.id,
    'x-connection-time': String(Date.now()), 'x-connection-nonce': crypto.randomBytes(16).toString('hex'), 'x-connection-signature': 'forged' };
  assert.equal((await a.request('GET', '/api/files/places', { headers })).status, 403);
});

test('the real SDK MCP bridge reads and writes on the consumer and never on the provider', async (t) => {
  const remoteFake = fileURLToPath(new URL('./helpers/fake-remote-claude.mjs', import.meta.url));
  const a = await startServer(t, { env: { POCKET_DEV_CLAUDE: remoteFake, POCKET_DEV_ROOM_PING_MS: '200' } });
  a.cookie = (await a.login()).cookie; a.call = (m, u, body) => a.request(m, u, { cookie: a.cookie, body }); a.id = (await a.call('GET', '/api/room')).data.deviceId;
  const b = await device(t);
  const invite = (await a.call('POST', '/api/connections/invite', { connectionType: 'external' })).data;
  await b.call('POST', '/api/connections/join', { host: a.base, code: invite.code, addresses: [b.base] }); await share(a, b);
  fs.writeFileSync(path.join(a.home, 'identity.txt'), 'PROVIDER PRIVATE');
  fs.writeFileSync(path.join(b.home, 'identity.txt'), 'WORKSPACE CONTENT');
  const id = (await b.call('POST', '/api/chat', { tool: `claude@${a.id}`, cwd: b.home })).data.id;
  await b.call('POST', `/api/chat/${id}/message`, { text: 'read-workspace' });
  let chat;
  await until(async () => { chat = (await b.call('GET', `/api/chat/${id}`)).data; return chat.status === 'idle' && chat.events.some((e) => e.type === 'assistant-text'); }, 15000);
  const answer = chat.events.find((e) => e.type === 'assistant-text').text;
  assert.match(answer, /WORKSPACE CONTENT/); assert.doesNotMatch(answer, /PROVIDER PRIVATE|UNSAFE OPTIONS/);
  await b.call('POST', `/api/chat/${id}/message`, { text: 'write-workspace' });
  await until(async () => (await b.call('GET', `/api/chat/${id}`)).data.pending, 15000);
  chat = (await b.call('GET', `/api/chat/${id}`)).data;
  const request = chat.events.findLast((e) => e.type === 'permission-request');
  assert.equal(fs.existsSync(path.join(b.home, 'result.txt')), false);
  assert.equal((await b.call('POST', `/api/chat/${id}/answer`, { requestId: request.requestId, decision: 'allow' })).status, 200);
  await until(() => fs.existsSync(path.join(b.home, 'result.txt')));
  assert.equal(fs.readFileSync(path.join(b.home, 'result.txt'), 'utf8'), 'written by remote AI');
  assert.equal(fs.existsSync(path.join(a.home, 'result.txt')), false);
});

test('provider revocation stops a pending workspace approval and prevents the write', async (t) => {
  const remoteFake = fileURLToPath(new URL('./helpers/fake-remote-claude.mjs', import.meta.url));
  const { a, b } = await pair(t);
  // Reuse A's state and identity with the MCP fixture.
  a.proc.kill('SIGTERM'); await new Promise((resolve) => a.proc.once('exit', resolve));
  const source = await startServer(t, { reuse: { root: a.root, port: a.port, adminPort: a.adminPort }, env: { POCKET_DEV_CLAUDE: remoteFake, POCKET_DEV_ROOM_PING_MS: '200' } });
  source.cookie = (await source.login()).cookie; source.id = a.id; source.call = (m, u, body) => source.request(m, u, { cookie: source.cookie, body });
  await share(source, b);
  const id = (await b.call('POST', '/api/chat', { tool: `claude@${a.id}`, cwd: b.home })).data.id;
  await b.call('POST', `/api/chat/${id}/message`, { text: 'write-workspace' });
  await until(async () => (await b.call('GET', `/api/chat/${id}`)).data.pending, 15000);
  await source.call('PATCH', '/api/connections/providers/claude', { enabled: false });
  await until(async () => (await b.call('GET', `/api/chat/${id}`)).data.status === 'error');
  const chat = (await b.call('GET', `/api/chat/${id}`)).data;
  assert.equal(chat.pending, false);
  assert.equal(fs.existsSync(path.join(b.home, 'result.txt')), false);
});
