import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { until, freePort } from './helpers/server.mjs';
import { device, trio, listing } from './helpers/forward-trio.mjs';
import { createForward } from '../forward.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.mjs');
const wsBase = (s) => s.base.replace('http', 'ws');
const heldBy = (s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'room.json'), 'utf8')).room;

// A socket whose opening and closing can be awaited. `closed` resolves with the close code.
function open(url, headers) {
  const ws = new WebSocket(url, { headers });
  ws.messages = [];
  ws.on('message', (raw) => { try { ws.messages.push(JSON.parse(raw)); } catch { /* not json */ } });
  ws.closed = new Promise((resolve) => ws.once('close', resolve));
  ws.on('error', () => {});
  return new Promise((resolve, reject) => { ws.once('open', () => resolve(ws)); ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`))); ws.once('error', reject); });
}
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))]);
// What the host presents when it vouches for `from` on a member: the host's own secret for that member.
const asHost = (h, target, from) => { const m = heldBy(h).members.find((x) => x.deviceId === target.id); return { 'x-room-id': heldBy(h).id, 'x-room-sender': h.id, 'x-room-secret': m.hostSecret, 'x-room-from': from.id }; };

test('a member that leaves closes the terminal it had open through the front device', async (t) => {
  const { h, a } = await trio(t);
  const made = await a.to(h, 'POST', '/api/sessions', { cwd: h.home });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const ws = await open(`${wsBase(a)}/m/${h.id}/ws/${made.data.id}`, { cookie: a.cookie, origin: a.base });
  t.after(() => ws.terminate());
  ws.send(JSON.stringify({ t: 'in', d: 'echo up-$((1+1))\n' }));
  await until(() => ws.messages.some((m) => m.t === 'out' && m.d.includes('up-2')), 8000);
  assert.equal((await a.api('POST', '/leave')).status, 200);
  await within(ws.closed, 3000, 'the front socket closing');
});

test('a kick closes sockets the member holds on the host and, through the host, on another member', async (t) => {
  const { h, a, b } = await trio(t);
  const made = await h.request('POST', '/api/sessions', { cookie: h.cookie, body: { cwd: h.home } });
  const held = heldBy(a);
  const direct = { 'x-room-id': held.id, 'x-room-sender': a.id, 'x-room-from': a.id, 'x-room-secret': held.memberSecret };
  // The same kind of connection A's front device makes: to the host, and from the host to B on A's behalf.
  const onHost = await open(`${wsBase(h)}/ws/${made.data.id}`, { ...direct, origin: h.base });
  const onBeta = await open(`${wsBase(b)}/ws/messages`, { ...asHost(h, b, a), origin: b.base });
  await until(() => onBeta.messages.some((m) => m.t === 'hello'), 5000);
  // A browser of A working on B through the host.
  const viaHost = await open(`${wsBase(a)}/m/${b.id}/ws/messages`, { cookie: a.cookie, origin: a.base });
  await until(() => viaHost.messages.some((m) => m.t === 'hello'), 5000);
  [onHost, onBeta, viaHost].forEach((ws) => t.after(() => ws.terminate()));
  assert.equal((await h.api('POST', '/kick', { deviceId: a.id })).status, 200);
  await within(onHost.closed, 3000, 'the host closing the socket of the kicked member');
  await within(viaHost.closed, 3000, 'the front socket of the kicked member closing');
  await within(onBeta.closed, 5000, 'the other member closing the socket opened for the kicked member');
});

test('a handover closes sockets that went through the old host', async (t) => {
  const { h, a, b } = await trio(t);
  const ws = await open(`${wsBase(a)}/m/${b.id}/ws/messages`, { cookie: a.cookie, origin: a.base });
  t.after(() => ws.terminate());
  await until(() => ws.messages.some((m) => m.t === 'hello'), 5000);
  assert.equal((await h.api('POST', '/handover', { deviceId: a.id })).status, 200);
  await within(ws.closed, 3000, 'the socket closing after the host changed');
});

test('a redirect to a path on the target stays on the target; absolute and other-site ones are untouched', async (t) => {
  const target = http.createServer((req, res) => { res.writeHead(302, { location: decodeURIComponent(req.url.slice(1)) }); res.end(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const own = `http://127.0.0.1:${target.address().port}`;
  const room = { deviceId: () => 'front', route: () => ({ roomId: 'r', sender: 'front', deviceId: 'abcd', name: 'T', addresses: [own], secret: 's', relayTo: null }) };
  const forward = createForward({ room, auth: { deviceFor: () => ({ id: 'd' }) }, collaborators: { guest: () => null }, sendJson: (res, status) => { res.writeHead(status); res.end(); } });
  const front = http.createServer((req, res) => forward.http(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  const locate = async (location) => (await fetch(`http://127.0.0.1:${front.address().port}/m/abcd/${encodeURIComponent(location)}`, { redirect: 'manual' })).headers.get('location');
  assert.equal(await locate('/login?next=%2Fa'), '/m/abcd/login?next=%2Fa');
  assert.equal(await locate('/'), '/m/abcd/');
  for (const same of ['/m/abcd/already', '//other.example/x', 'https://other.example/x', `${own}/absolute`, 'relative/path', '?q=1']) assert.equal(await locate(same), same, same);
});
