import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isolatedEnv } from './isolated-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(30); }
  assert.fail('Condition timed out');
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const CONNECTOR = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7' };

test('Messages between the Mac, owner devices and guests', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-messages-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ password: 'test-password', awake: 'off', fileRoots: [home], maxDevices: 20 }));
  const port = await freePort(), adminPort = await freePort();
  const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;
  const stub = path.join(root, 'stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "No\\n"\n', { mode: 0o700 });
  const env = isolatedEnv(home, {
    SHELL: '/bin/zsh', PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: config,
    POCKET_DEV_STATE_DIR: state, POCKET_DEV_NO_OPEN: '1', POCKET_DEV_TERMINAL_HOST: 'off', POCKET_DEV_CLAUDE: '/nonexistent/claude', POCKET_DEV_CODEX: '/nonexistent/codex',
    POCKET_DEV_PMSET: stub, POCKET_DEV_IOREG: stub, POCKET_DEV_TOP: stub, POCKET_DEV_MEMORY_PRESSURE: stub, POCKET_DEV_UPDATE_CHECK: stub, POCKET_DEV_OSASCRIPT: stub, POCKET_DEV_SIPS: stub,
    POCKET_DEV_PROCESS_FIXTURE: path.join(root, 'no-processes.json'),
  });
  const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env: isolatedEnv(home, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), pause(5000).then(() => proc.kill('SIGKILL'))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => { assert.equal(proc.exitCode, null, `server exited: ${logs}`); return logs.includes('Admin (this Mac only)'); });

  async function request(method, endpoint, { cookie, body, raw, name, headers = {}, mac = false, csrf = true } = {}) {
    const res = await fetch((mac ? admin : base) + endpoint, {
      method, redirect: 'manual',
      headers: { ...(cookie && { cookie }), ...(csrf && { [mac ? 'x-pocket-admin' : 'x-pocket-dev']: '1' }),
        ...(body !== undefined && { 'content-type': 'application/json' }), ...(raw !== undefined && { 'content-type': 'application/octet-stream' }),
        ...(name && { 'x-filename': encodeURIComponent(name) }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const local = (method, endpoint, body) => request(method, endpoint, { mac: true, body: body ?? (method === 'GET' ? undefined : {}) });
  // Zeros from one reused 1 MB chunk, so the test never holds the whole body.
  function streamUpload(cookie, bytes, { declare = true, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/messages/files`, { method: 'POST', headers: { cookie, 'x-pocket-dev': '1', 'x-filename': 'zeros.bin', ...(declare && { 'content-length': bytes }), ...headers } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text || '{}') }));
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(MB);
      let sent = 0;
      const pump = () => {
        while (sent < bytes) {
          const piece = Math.min(MB, bytes - sent);
          sent += piece;
          if (!req.write(piece === MB ? chunk : chunk.subarray(0, piece))) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
  }
  async function socket(cookie, origin = base) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/messages`, { headers: { ...(cookie && { cookie }), origin } });
    sockets.add(ws);
    ws.on('error', () => {});
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    ws.closed = new Promise((resolve) => ws.once('close', resolve));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
    await until(() => ws.inbox.some((m) => m.t === 'hello'));
    return ws;
  }
  const texts = (ws) => ws.inbox.flatMap((m) => (m.t === 'message' ? [m.message.text] : m.t === 'hello' ? m.messages.map((x) => x.text) : []));
  const filesOnDisk = () => fs.readdirSync(path.join(state, 'messages', 'files'));

  const login = async (name) => {
    const { cookie } = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const { currentDeviceId: id } = (await request('GET', '/api/settings', { cookie })).data;
    assert.equal((await local('PATCH', `/api/devices/${id}`, { name })).status, 200);
    return { cookie, id };
  };
  const A = await login('Pixel'), B = await login('iPad'), C = await login('Laptop');
  const [sA, sB, sC] = [await socket(A.cookie), await socket(B.cookie), await socket(C.cookie)];
  const peopleOf = async (cookie) => (await request('GET', '/api/messages/people', { cookie })).data.people;
  const idOf = async (cookie, name) => (await peopleOf(cookie)).find((p) => p.name === name).id;

  await t.test('writes need the CSRF header and the socket checks Origin', async () => {
    assert.equal((await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'x' }, csrf: false })).status, 403);
    assert.equal((await request('POST', '/api/messages/files', { cookie: A.cookie, raw: 'x', csrf: false })).status, 403);
    await assert.rejects(socket(A.cookie, 'http://evil.example'), /HTTP 403/);
    await assert.rejects(socket(undefined), /HTTP 401/);
    assert.equal((await request('GET', '/api/messages')).status, 401);
  });

  await t.test('a group message reaches every participant, the Mac included', async () => {
    assert.equal((await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'hello all' } })).status, 201);
    for (const ws of [sA, sB, sC]) await until(() => texts(ws).includes('hello all'));
    const mac = (await local('GET', '/api/messages')).data;
    const seen = mac.messages.find((m) => m.text === 'hello all');
    assert.deepEqual(seen.from, { id: seen.from.id, name: 'Pixel', kind: 'device' });
    assert.equal(seen.chat, 'everyone');
    assert.equal((await local('POST', '/api/messages', { text: 'from the Mac' })).status, 201);
    for (const ws of [sA, sB, sC]) await until(() => texts(ws).includes('from the Mac'));
    assert.equal(sB.inbox.findLast((m) => m.t === 'message').message.from.kind, 'mac');
  });

  await t.test('a direct message reaches only its two parties', async () => {
    const sent = await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'just you', to: await idOf(A.cookie, 'iPad') } });
    assert.equal(sent.status, 201);
    await until(() => texts(sA).includes('just you') && texts(sB).includes('just you'));
    assert.equal(sB.inbox.findLast((m) => m.t === 'message').message.chat, await idOf(B.cookie, 'Pixel'));
    await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'marker' } });
    await until(() => texts(sC).includes('marker'));
    assert.ok(!texts(sC).includes('just you'), 'a third device never receives it');
    assert.ok(!(await local('GET', '/api/messages')).data.messages.some((m) => m.text === 'just you'), 'the Mac is not a party');
  });

  let video, direct;
  const unsentIds = [];
  await t.test('any file type uploads; video seeks with Range; risky types always download', async () => {
    const mp4 = Buffer.concat([Buffer.from('\0\0\0\x18ftypisom\0\0\0\0'), Buffer.alloc(4000, 7)]);
    video = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: mp4, name: 'clip.mov' })).data;
    assert.equal(video.kind, 'video');
    const svg = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', name: 'logo.svg' })).data;
    const fake = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: '<!doctype html><script>alert(1)</script>', name: 'photo.png' })).data;
    const html = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: '<html><script>alert(1)</script></html>', name: 'page.html' })).data;
    const zip = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: Buffer.from('PK\x03\x04rest'), name: 'archive.zip' })).data;
    assert.deepEqual([svg.kind, fake.kind, html.kind, zip.kind], ['file', 'file', 'file', 'file']);
    assert.equal((await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'files', files: [video.id, svg.id, fake.id, html.id, zip.id] } })).status, 201);
    await until(() => texts(sC).includes('files'));
    assert.deepEqual(sC.inbox.findLast((m) => m.t === 'message').message.files.map((f) => f.name), ['clip.mov', 'logo.svg', 'photo.png', 'page.html', 'archive.zip']);

    const part = await fetch(`${base}/api/messages/files/${video.id}`, { headers: { cookie: C.cookie, range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${mp4.length}`);
    assert.equal(part.headers.get('content-type'), 'video/mp4');
    assert.match(part.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), mp4.subarray(100, 200));
    for (const f of [svg, fake, html, zip]) {
      const res = await fetch(`${base}/api/messages/files/${f.id}`, { headers: { cookie: C.cookie } });
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', f.name);
      assert.match(res.headers.get('content-disposition'), /^attachment/, f.name);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), 'sandbox');
    }
    const forced = await fetch(`${base}/api/messages/files/${video.id}?download=1`, { headers: { cookie: C.cookie } });
    assert.match(forced.headers.get('content-disposition'), /^attachment; filename="clip.mov"/);
  });

  await t.test('only people who can see the message can fetch its attachment', async () => {
    const note = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: 'between us', name: 'note.txt' })).data;
    direct = (await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'private file', to: await idOf(A.cookie, 'iPad'), files: [note.id] } })).data;
    assert.equal((await request('GET', `/api/messages/files/${note.id}`, { cookie: B.cookie })).data, 'between us');
    assert.equal((await request('GET', `/api/messages/files/${note.id}`, { cookie: C.cookie })).status, 404);
    assert.equal((await request('GET', `/api/messages/files/${note.id}`, { mac: true })).status, 404);
    assert.equal((await request('GET', `/api/messages/files/${note.id}`)).status, 401);
    const unsent = (await request('POST', '/api/messages/files', { cookie: A.cookie, raw: 'draft', name: 'draft.txt' })).data;
    unsentIds.push(unsent.id);
    assert.equal((await request('POST', '/api/messages', { cookie: C.cookie, body: { files: [unsent.id] } })).status, 400, 'nobody can send another person\'s upload');
  });

  await t.test('only the sender or the owner deletes; deleting removes the files; others hide', async () => {
    const sent = (await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'files' } })).data;
    const withFiles = (await local('GET', '/api/messages')).data.messages.find((m) => m.files.length === 5);
    assert.ok(filesOnDisk().includes(video.id));
    assert.equal((await request('DELETE', `/api/messages/${withFiles.seq}`, { cookie: C.cookie })).status, 204, 'an owner device may delete');
    await until(() => sB.inbox.some((m) => m.t === 'removed' && m.seqs.includes(withFiles.seq)));
    for (const f of withFiles.files) assert.ok(!filesOnDisk().includes(f.id), f.name);
    assert.equal((await request('GET', `/api/messages/files/${video.id}`, { cookie: A.cookie })).status, 404);
    assert.equal((await request('POST', `/api/messages/${sent.seq}/hide`, { cookie: B.cookie })).status, 204);
    assert.ok(!(await request('GET', '/api/messages', { cookie: B.cookie })).data.keep.includes(sent.seq), 'hidden for B');
    assert.ok((await request('GET', '/api/messages', { cookie: C.cookie })).data.keep.includes(sent.seq), 'still there for C');
  });

  await t.test('an offline device gets what it missed when it reconnects', async () => {
    const last = Math.max(...sC.inbox.flatMap((m) => (m.t === 'message' ? [m.message.seq] : m.t === 'hello' ? m.messages.map((x) => x.seq) : [])));
    sC.close();
    await sC.closed;
    await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'while you were away' } });
    await local('POST', '/api/messages', { text: 'the Mac too' });
    const back = new WebSocket(`${base.replace('http', 'ws')}/ws/messages?after=${last}`, { headers: { cookie: C.cookie, origin: base } });
    sockets.add(back);
    const [raw] = await once(back, 'message');
    const hello = JSON.parse(raw);
    assert.deepEqual(hello.messages.map((m) => m.text), ['while you were away', 'the Mac too']);
    assert.ok(hello.keep.includes(last), 'keep lists everything still visible');
  });

  await t.test('over the connector a file may be 100 MB; the page is told before it uploads', async () => {
    const limits = (await request('GET', '/api/messages', { cookie: A.cookie, headers: CONNECTOR })).data.limits;
    assert.equal(limits.fileMax, 100 * MB);
    assert.equal((await request('GET', '/api/messages', { cookie: A.cookie })).data.limits.fileMax, null);
    const declared = await streamUpload(A.cookie, 100 * MB + 1, { headers: CONNECTOR });
    assert.equal(declared.status, 413);
    assert.equal(declared.data.error, 'Over the internet you can send files up to 100 MB. This file is 100.0 MB. Connect on the same Wi-Fi as the Mac to send it.');
    const counted = await streamUpload(A.cookie, 101 * MB, { declare: false, headers: CONNECTOR });
    assert.equal(counted.status, 413);
    assert.match(counted.data.error, /^Over the internet you can send files up to 100 MB/);
  });

  await t.test('on Wi-Fi a 150 MB file uploads while the server\'s memory stays flat', async () => {
    const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(proc.pid)], { encoding: 'utf8' })) * 1024;
    const before = rss();
    let peak = before;
    const sampler = setInterval(() => { peak = Math.max(peak, rss()); }, 25);
    const res = await streamUpload(A.cookie, 150 * MB);
    clearInterval(sampler);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(fs.statSync(path.join(state, 'messages', 'files', res.data.id)).size, 150 * MB);
    unsentIds.push(res.data.id);
    assert.ok(peak - before < 60 * MB, `server grew ${Math.round((peak - before) / MB)} MB while receiving 150 MB`);
  });

  await t.test('revoking a device closes its socket at once', async () => {
    assert.equal((await local('POST', `/api/devices/${B.id}/revoke`)).status, 200);
    await Promise.race([sB.closed, pause(3000).then(() => assert.fail('revoked socket stayed open'))]);
    assert.equal((await request('GET', '/api/messages', { cookie: B.cookie })).status, 401);
  });

  await t.test('the CLI sends as the Mac from an argument, piped stdin or --file, by name or device code', async () => {
    const cli = (args, input) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), 'message', ...args], { env, input, encoding: 'utf8' });
    const byName = cli(['hello', 'Pixel', '--to', 'pixel']);
    assert.equal(byName.status, 0, byName.stderr);
    assert.equal(byName.stdout.trim(), 'Sent to Pixel.');
    await until(() => texts(sA).includes('hello Pixel'));
    const got = sA.inbox.findLast((m) => m.t === 'message').message;
    assert.deepEqual([got.from.kind, got.chat], ['mac', await idOf(A.cookie, 'Mac')]);
    assert.equal(cli(['to the laptop', '--to', C.id.slice(-4)]).stdout.trim(), 'Sent to Laptop.');
    assert.equal(cli([], 'piped text\n').status, 0);
    await until(() => texts(sA).includes('piped text'));
    const file = path.join(root, 'report.txt');
    fs.writeFileSync(file, 'report body');
    assert.equal(cli(['--file', file]).status, 0);
    await until(() => sA.inbox.some((m) => m.t === 'message' && m.message.files[0]?.name === 'report.txt'));
    const sentFile = sA.inbox.findLast((m) => m.t === 'message').message.files[0];
    assert.equal((await request('GET', `/api/messages/files/${sentFile.id}`, { cookie: A.cookie })).data, 'report body');
    const empty = cli([], '');
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /^usage: pocket-dev message/);
    assert.match(cli(['x', '--to', 'nobody']).stderr, /Nobody in Messages matches "nobody"/);
  });

  await t.test('guests see group history from their grant on, never others\' direct chats, and only display names', async () => {
    await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'before the grant' } });
    assert.equal((await local('POST', '/api/collaborators/enable', { adminDeviceIds: [A.id] })).status, 200);
    const repo = path.join(home, 'project');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const grant = await local('POST', '/api/collaborators', { label: 'Reviewer', role: 'viewer', repository: repo, extraFolders: [], ai: false, duration: 3600 });
    assert.equal(grant.status, 201, JSON.stringify(grant.data));
    const invite = await local('POST', `/api/collaborators/${grant.data.id}/invite`);
    const token = new URLSearchParams(new URL(invite.data.url).hash.slice(1)).get('token');
    const G = (await request('POST', '/api/invitations/accept', { body: { token } })).cookie;
    assert.match(G, /^pd_collaborator=/);
    await request('POST', '/api/messages', { cookie: A.cookie, body: { text: 'after the grant' } });

    const seen = (await request('GET', '/api/messages', { cookie: G })).data;
    assert.deepEqual(seen.messages.map((m) => m.text), ['after the grant']);
    assert.equal((await request('GET', `/api/messages/files/${direct.files[0].id}`, { cookie: G })).status, 404, 'another pair\'s file');
    assert.deepEqual(seen.you, { id: seen.you.id, name: 'Reviewer', kind: 'guest' });
    for (const p of seen.people) assert.deepEqual(Object.keys(p).sort(), ['id', 'kind', 'name'], 'no codes for a guest');
    const raw = JSON.stringify(seen);
    for (const secret of [A.id, A.id.slice(-4), '127.0.0.1', 'device:']) assert.ok(!raw.includes(secret), secret);
    assert.equal((await peopleOf(A.cookie)).find((p) => p.kind === 'device' || p.name === 'Reviewer')?.name, 'Reviewer', 'the owner sees the guest');

    const sG = await socket(G);
    assert.deepEqual(sG.inbox[0].messages.map((m) => m.text), ['after the grant']);
    assert.equal((await request('POST', '/api/messages', { cookie: G, body: { text: 'hi from a guest' } })).status, 201);
    await until(() => texts(sA).includes('hi from a guest'));
    assert.deepEqual(sA.inbox.findLast((m) => m.t === 'message').message.from.kind, 'guest');
    const macView = (await local('GET', '/api/messages')).data.messages.find((m) => m.text === 'hi from a guest');
    assert.equal(macView.from.name, 'Reviewer');
    const own = (await request('GET', '/api/messages', { cookie: G })).data.messages.find((m) => m.text === 'hi from a guest');
    assert.equal(own.canDelete, true, 'a guest may delete what it sent');
    const theirs = (await request('GET', '/api/messages', { cookie: G })).data.messages.find((m) => m.text === 'after the grant');
    assert.equal((await request('DELETE', `/api/messages/${theirs.seq}`, { cookie: G })).status, 403, 'but not other people\'s');
    assert.equal((await request('POST', `/api/messages/${theirs.seq}/hide`, { cookie: G })).status, 204);
    assert.equal((await request('POST', '/api/messages/clear', { cookie: G, body: {} })).status, 403);

    assert.equal((await local('DELETE', `/api/collaborators/${grant.data.id}`)).status, 204);
    await Promise.race([sG.closed, pause(3000).then(() => assert.fail('revoked guest socket stayed open'))]);
    assert.equal((await request('GET', '/api/messages', { cookie: G })).status, 403);
    await assert.rejects(socket(G), /HTTP 403/);
  });

  await t.test('the Admin page sees storage, clears one chat or all, and lockdown closes sockets', async () => {
    const storage = (await local('GET', '/api/messages/storage')).data;
    assert.ok(storage.chats.some((c) => c.id === 'everyone'));
    assert.equal(typeof storage.freeBytes, 'number');
    const pair = storage.chats.find((c) => c.title === 'Pixel and iPad');
    assert.ok(pair.count >= 2);
    assert.ok((await local('POST', '/api/messages/clear', { chat: pair.id })).data.removed >= 2);
    assert.ok(!(await local('GET', '/api/messages/storage')).data.chats.some((c) => c.id === pair.id));
    assert.equal((await local('POST', '/api/messages/clear', {})).status, 200);
    assert.deepEqual((await local('GET', '/api/messages/storage')).data.chats, []);
    assert.deepEqual(filesOnDisk().sort(), [...unsentIds].sort(), 'only uploads nobody sent remain');
    assert.match(fs.readFileSync(path.join(state, 'security.log'), 'utf8'), /"type":"messages-cleared"/);
    assert.equal((await local('POST', '/api/lockdown', { also: [] })).status, 200);
    await Promise.race([sA.closed, pause(3000).then(() => assert.fail('lockdown left a Messages socket open'))]);
  });
});
