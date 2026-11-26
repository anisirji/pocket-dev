import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createConnections } from '../src/auth/connections.js';
import { createRoom } from '../src/rooms/room.js';
import { createSecureChannel } from '../src/network/secure-channel.js';
import { Chat } from '../src/chat/chat.js';
import { createWorkspaceTools } from '../src/chat/workspace-tools.js';

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-connections-unit-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  let members = [{ deviceId: 'aaaa', name: 'This computer', status: 'online' }, { deviceId: 'bbbb', name: 'Peer', status: 'offline', publicKey }];
  const listeners = [], drop = [], pair = [];
  let resolver, keyResolver, advertised;
  const room = {
    members: () => members, deviceId: () => 'aaaa', legacyMembers: [],
    setAccessResolver: (fn, keys) => { resolver = fn; keyResolver = keys; }, setLocalAccess: (value) => { advertised = value; },
    onChange: (fn) => listeners.push(fn), onDrop: (fn) => drop.push(fn), onPair: (fn) => pair.push(fn),
  };
  const connections = createConnections({ room, stateDir, installed: () => ({ claude: true, codex: true }), schemas: async () => ({ claude: [] }) });
  const call = async (method, route, body, { owner = true, origin } = {}) => {
    let result;
    await connections.handleApi({ method, ...(origin && { roomPeer: { origin } }) }, {}, new URL(route, 'http://local'), {
      owner, readJson: async () => body || {}, sendJson: (_res, status, value) => { result = { status, body: value }; },
    });
    return result;
  };
  return { stateDir, room, connections, call, publicKey, resolver: (id) => resolver(id), pin: (id) => keyResolver(id),
    advertised: () => advertised, pair: (personal) => pair.forEach((fn) => fn({ deviceId: 'bbbb', personal })),
    remove: () => { members = members.slice(0, 1); listeners.forEach((fn) => fn()); } };
}

test('installed Claude can be shared without an API-key or subscription gate', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('PATCH', '/api/connections/providers/claude', { enabled: true })).status, 200);
  assert.equal((await f.call('PATCH', '/api/connections/bbbb', { ai: ['claude'] })).status, 200);
  assert.equal(f.connections.allowed('bbbb', 'claude'), true);
  assert.equal(f.connections.allowed('bbbb', 'codex'), false);
  assert.equal(f.resolver('bbbb').computerAccess, false);
  assert.equal(f.pin('bbbb'), f.publicKey);
  const directory = await f.call('GET', '/api/ai/providers', undefined, { origin: 'bbbb', owner: false });
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.providers.map((p) => p.type), ['claude']);
  assert.equal(JSON.stringify(directory.body).includes('publicKey'), false);
});

test('only the target owner can grant computer access, with explicit ownership confirmation', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('PATCH', '/api/connections/bbbb', { computerAccess: true })).status, 400);
  assert.equal((await f.call('PATCH', '/api/connections/bbbb', { computerAccess: true, confirmOwnership: true }, { origin: 'bbbb' })).status, 403);
  assert.equal((await f.call('PATCH', '/api/connections/bbbb', { computerAccess: true, confirmOwnership: true })).status, 200);
  assert.equal(f.resolver('bbbb').computerAccess, true);
  assert.equal(f.advertised().bbbb.computerAccess, true);
});

test('disconnect revokes access and provider sessions; reconnect restores no previous permissions', async (t) => {
  const f = fixture(t); let changes = 0;
  f.connections.onChange(() => changes++);
  await f.call('PATCH', '/api/connections/providers/claude', { enabled: true });
  await f.call('PATCH', '/api/connections/bbbb', { computerAccess: true, confirmOwnership: true, ai: ['claude'] });
  await f.call('DELETE', '/api/connections/bbbb');
  assert.equal(f.connections.connected('bbbb'), false);
  assert.equal(f.connections.allowed('bbbb', 'claude'), false);
  assert.equal(f.resolver('bbbb').computerAccess, false);
  assert.equal((await f.call('POST', '/api/connections/bbbb/reconnect')).status, 200);
  assert.equal(f.connections.connected('bbbb'), true);
  assert.equal(f.connections.allowed('bbbb', 'claude'), false);
  assert.equal(f.resolver('bbbb').computerAccess, false);
  assert.ok(changes >= 4);
  f.remove();
  assert.equal(f.connections.connected('bbbb'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'connections.json'))).grants.bbbb, undefined);
});

test('personal pairing is specific to the peer and pins its identity; external pairing grants no computer access', (t) => {
  const f = fixture(t);
  f.pair(false);
  assert.equal(f.resolver('bbbb').computerAccess, false);
  assert.equal(f.pin('bbbb'), f.publicKey);
  f.pair(true);
  assert.equal(f.resolver('bbbb').computerAccess, true);
  assert.equal(f.resolver('cccc').computerAccess, false);
});

function identities() {
  const keys = new Map(['aaaa', 'bbbb'].map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const room = (id) => ({ deviceId: () => id,
    signMessage: (message) => crypto.sign(null, Buffer.from(message), keys.get(id).privateKey).toString('base64'),
    verifyMessage: (peer, message, signature) => crypto.verify(null, Buffer.from(message), keys.get(peer).publicKey, Buffer.from(signature, 'base64')),
  });
  return room;
}
test('relayed AI data is encrypted and rejects alteration, replay, and a forged source identity', () => {
  const room = identities();
  const consumer = createSecureChannel({ room: room('aaaa'), peerId: 'bbbb', consumer: true });
  const provider = createSecureChannel({ room: room('bbbb'), peerId: 'aaaa', consumer: false });
  const hello = provider.serverHello(consumer.publicKey); consumer.acceptHello(hello);
  const message = consumer.seal({ t: 'tool-result', result: 'PRIVATE PROJECT' });
  assert.equal(message.includes('PRIVATE PROJECT'), false);
  const altered = JSON.parse(message); altered.body = Buffer.from('tampered').toString('base64');
  assert.throws(() => provider.open(JSON.stringify(altered)));
  assert.deepEqual(provider.open(message), { t: 'tool-result', result: 'PRIVATE PROJECT' });
  assert.throws(() => provider.open(message), /replayed/);
  assert.deepEqual(consumer.open(provider.seal({ t: 'done' })), { t: 'done' });
  const other = createSecureChannel({ room: room('aaaa'), peerId: 'bbbb', consumer: true });
  assert.throws(() => other.acceptHello(hello), /verified/);
});

test('legacy state and project copies survive migration without inheriting admin privileges', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-legacy-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, 'collaborator-workspaces', 'saved'); fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'work.txt'), 'valuable unfinished work');
  fs.writeFileSync(path.join(root, 'room.json'), JSON.stringify({ deviceId: 'aaaa', room: { id: 'room', hostId: 'aaaa', revoked: [], members: [
    { deviceId: 'aaaa', name: 'Owner', level: 'admin', role: 'host', addresses: ['http://owner'], joinedAt: 1 },
    { deviceId: 'bbbb', name: 'Legacy peer', level: 'admin', role: 'member', addresses: ['http://peer'], joinedAt: 1 },
  ] }, outbox: [] }));
  const room = createRoom({ stateDir: root, every: () => () => {}, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  createConnections({ room, stateDir: root });
  assert.deepEqual(room.view().room.trustedAdmins, []);
  assert.equal(fs.readFileSync(path.join(copy, 'work.txt'), 'utf8'), 'valuable unfinished work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'room.json'))).deviceId, 'aaaa');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'connections.json'))).migration.legacyDeviceIds.length, 2);
});

test('workspace operations support chunked reads, owner questions, directories, and hard-link write protection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-tools-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'private');
  fs.linkSync(outside, path.join(cwd, 'link'));
  fs.writeFileSync(path.join(cwd, 'large'), 'a'.repeat(300000) + 'tail');
  const chat = Chat.create({ tool: 'claude', cwd, settings: {} }, root); chat.startTurn();
  const tools = createWorkspaceTools(chat, { sandbox: null });
  t.after(() => { tools.close(); chat.closed = true; clearTimeout(chat.persistTimer); });
  assert.equal(await tools.execute('read_file', { path: 'large', offset: 300000, length: 4 }), 'tail');
  const directory = tools.execute('create_directory', { path: 'src' });
  chat.answer([...chat.requests.keys()][0], { decision: 'allow' }); await directory;
  assert.ok(fs.statSync(path.join(cwd, 'src')).isDirectory());
  const question = tools.execute('ask_user', { question: 'Which framework?', choices: ['React', 'Vue'] });
  chat.answer([...chat.requests.keys()][0], { answers: { answer: ['Vue'] } }); assert.equal(await question, 'Vue');
  const writing = tools.execute('write_file', { path: 'link', content: 'must not write' });
  chat.answer([...chat.requests.keys()][0], { decision: 'allow' });
  await assert.rejects(writing, /hard-linked/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});

test('real Room pairing signs identities end to end without granting transitive computer access', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-pair-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const devices = new Map();
  const transport = async (url, options) => {
    const target = devices.get(new URL(url).origin); let result;
    await target.room.handleApi({ method: options.method, headers: options.headers }, {}, new URL(url), {
      readJson: async () => JSON.parse(options.body), sendJson: (_res, status, body) => { result = { status, body }; },
    });
    return { status: result.status, json: async () => result.body };
  };
  const make = (name) => {
    const address = `http://${name}`, stateDir = path.join(root, name);
    const room = createRoom({ stateDir, urls: () => ({ lan: address }), every: () => () => {}, fetchImpl: transport });
    const connections = createConnections({ room, stateDir });
    const call = async (method, route, body) => {
      let result;
      await connections.handleApi({ method }, {}, new URL(route, address), { owner: true, readJson: async () => body,
        sendJson: (_res, status, body) => { result = { status, body }; } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
    };
    const computer = { room, connections, call, address }; devices.set(address, computer); return computer;
  };
  const a = make('host'), b = make('personal'), c = make('external');
  await a.room.create({ addresses: [a.address] });
  const personal = a.room.invite({}, { connectionType: 'personal' });
  await b.call('POST', '/api/connections/join', { code: personal.code, host: a.address, addresses: [b.address], connectionType: 'personal' });
  assert.equal(a.connections.grant(b.room.deviceId()).computerAccess, true);
  assert.equal(b.connections.grant(a.room.deviceId()).computerAccess, true);
  const external = a.room.invite({}, { connectionType: 'external' });
  await c.call('POST', '/api/connections/join', { code: external.code, host: a.address, addresses: [c.address], connectionType: 'personal' });
  await b.room.tick();
  assert.equal(a.connections.grant(c.room.deviceId()).computerAccess, false, 'joiner cannot promote an external invitation');
  assert.equal(b.connections.grant(c.room.deviceId()).computerAccess, false, 'personal trust does not extend to new members');
  const route = b.room.route(a.room.deviceId());
  const headers = { 'x-room-id': route.roomId, 'x-room-sender': route.sender, 'x-room-secret': route.secret, 'x-room-from': b.room.deviceId(),
    ...b.room.signRequest(a.room.deviceId(), 'GET', '/api/files/places') };
  const principal = a.room.authPeerRequest(headers, { method: 'GET', path: '/api/files/places' });
  assert.equal(principal.level, 'admin');
  assert.throws(() => a.room.authPeerRequest(headers, { method: 'GET', path: '/api/files/places' }), /already used/);
  const wrongTarget = { ...headers, ...b.room.signRequest(c.room.deviceId(), 'GET', '/api/files/places') };
  assert.throws(() => a.room.authPeerRequest(wrongTarget, { method: 'GET', path: '/api/files/places' }), /signed/);
  await a.call('PATCH', `/api/connections/${b.room.deviceId()}`, { computerAccess: false });
  const revoked = { ...headers, ...b.room.signRequest(a.room.deviceId(), 'GET', '/api/files/places') };
  assert.equal(a.room.authPeerRequest(revoked, { method: 'GET', path: '/api/files/places' }).level, 'external');
});

test('shared workspace permissions honor Plan, Accept edits, Never ask and explicitly selected Bypass', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-modes-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = Chat.create({ tool: 'claude', cwd: root, settings: { mode: 'plan' } }, root); chat.startTurn();
  const tools = createWorkspaceTools(chat, { sandbox: null });
  t.after(() => { tools.close(); chat.closed = true; clearTimeout(chat.persistTimer); });
  await assert.rejects(tools.execute('write_file', { path: 'work.txt', content: 'plan must not write' }), /read only/);
  assert.equal(fs.existsSync(path.join(root, 'work.txt')), false);
  chat.settings.mode = 'acceptEdits';
  await tools.execute('write_file', { path: 'work.txt', content: 'edits approved by mode' });
  assert.equal(chat.requests.size, 0);
  chat.settings.mode = 'dontAsk';
  await assert.rejects(tools.execute('write_file', { path: 'work.txt', content: 'unapproved' }), /never ask/);
  assert.equal(fs.readFileSync(path.join(root, 'work.txt'), 'utf8'), 'edits approved by mode');
  chat.settings.mode = 'bypassPermissions';
  await tools.execute('write_file', { path: 'work.txt', content: 'explicitly approved by mode' });
  assert.equal(chat.requests.size, 0);
  assert.equal(fs.readFileSync(path.join(root, 'work.txt'), 'utf8'), 'explicitly approved by mode');
  await assert.rejects(tools.execute('write_file', { path: '../outside', content: 'must stay inside' }), /outside/);
});

test('cancelling one expired tool approval prevents its write without closing other workspace operations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-tool-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = Chat.create({ tool: 'claude', cwd: root, settings: {} }, root); chat.startTurn();
  const tools = createWorkspaceTools(chat, { sandbox: null });
  t.after(() => { tools.close(); chat.closed = true; clearTimeout(chat.persistTimer); });
  const request = new AbortController();
  const writing = tools.execute('write_file', { path: 'late.txt', content: 'must not appear' }, { signal: request.signal });
  const requestId = [...chat.requests.keys()][0];
  request.abort();
  await assert.rejects(writing, /no longer active/);
  assert.equal(chat.requests.size, 0);
  chat.answer(requestId, { decision: 'allow' });
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), false);
  fs.writeFileSync(path.join(root, 'current.txt'), 'still active');
  assert.equal(await tools.execute('read_file', { path: 'current.txt' }), 'still active');
});
