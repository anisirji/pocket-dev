import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createBrowserPush, parsePushSubscription } from '../src/core/browser-push.js';
import { startServer } from './helpers/server.mjs';

const subscription = (suffix = 'fixture') => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-push-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = new Set(['owner', 'other']), online = new Set(), sent = [], prefs = { aiTasks: true, sounds: false };
  let clock = Date.now(), failure;
  const library = { generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }), sendNotification: async (subscription, payload, options) => { sent.push({ subscription, payload: JSON.parse(payload), options }); if (failure) throw failure; } };
  const push = createBrowserPush({ stateDir: root, authorized: (id) => allowed.has(id), online: (id) => online.has(id), preferences: () => prefs, computerId: () => 'computer', library, now: () => clock });
  return { root, push, allowed, online, sent, prefs, failure: (value) => { failure = value; }, advance: (time) => { clock += time; } };
}
const notice = { id: 'task:1', category: 'aiTasks', title: 'Task completed', body: 'Fixture project', sound: true, action: { kind: 'chat', id: 'abc' } };
test('browser push accepts vendor endpoints and rejects arbitrary requests and malformed keys', () => {
  for (const endpoint of ['http://fcm.googleapis.com/send', 'https://localhost/send', 'https://127.0.0.1/send', 'https://192.168.1.30/send', 'https://fcm.googleapis.com.attacker.test/send', 'https://fcm.googleapis.com:7777/send', 'https://name:secret@fcm.googleapis.com/send', 'https://fcm.googleapis.com/send#fragment']) assert.throws(() => parsePushSubscription({ ...subscription(), endpoint }));
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-pn1p.notify.windows.com']) assert.ok(parsePushSubscription({ ...subscription(), endpoint: `https://${host}/send` }));
  assert.throws(() => parsePushSubscription({ ...subscription(), keys: { p256dh: 'bad', auth: 'bad' } }));
});
test('delivery is opt-in, authenticated, quiet by default and skips visible clients', async (t) => {
  const f = fixture(t); await f.push.deliver(notice); assert.equal(f.sent.length, 0);
  f.push.subscribe('owner', subscription()); f.online.add('owner'); await f.push.deliver(notice); assert.equal(f.sent.length, 0);
  f.online.clear(); await f.push.deliver(notice); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.sound, false); assert.equal(f.sent[0].payload.scope, 'computer:owner'); assert.equal(f.sent[0].options.TTL, 60);
  f.prefs.aiTasks = false; await f.push.deliver(notice); assert.equal(f.sent.length, 1);
  f.prefs.aiTasks = true; f.allowed.delete('owner'); await f.push.deliver(notice); assert.equal(f.sent.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'browser-push.json'))).subscriptions.length, 0);
});
test('subscriptions cannot cross logins, recipients are filtered and expired subscriptions are removed', async (t) => {
  const f = fixture(t), first = subscription(); f.push.subscribe('owner', first);
  assert.equal(f.push.status('owner').registrations.length, 1); assert.equal(f.push.status('other').registrations.length, 0);
  assert.throws(() => f.push.subscribe('other', first), /another login/);
  f.push.subscribe('other', subscription('other'));
  await f.push.deliver({ ...notice, audience: ['other'] }); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.scope, 'computer:other');
  f.failure({ statusCode: 410 }); await f.push.deliver({ ...notice, audience: ['owner'] });
  const stored = () => JSON.parse(fs.readFileSync(path.join(f.root, 'browser-push.json')));
  assert.equal(stored().subscriptions.length, 1);
  for (let i = 0; i < 12; i++) f.push.subscribe('other', subscription(`other-${i}`));
  assert.equal(stored().subscriptions.length, 5, 'per-device list is bounded');
  f.advance(91 * 86400000); f.push.status(); assert.equal(stored().subscriptions.length, 0);
  assert.equal(stored().keys.privateKey, 'private');
});
test('missing optional push support and corrupt state preserve the rest of the app', (t) => {
  const f = fixture(t);
  const missing = createBrowserPush({ stateDir: f.root, library: null }); assert.equal(missing.status().state, 'setup-required');
  fs.writeFileSync(path.join(f.root, 'browser-push.json'), '{bad fixture');
  assert.equal(f.push.status().state, 'failed'); assert.equal(f.push.status().available, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'browser-push.json'), 'utf8'), '{bad fixture');
});
test('push registration requires a login and never exposes stored subscriptions or private keys', { timeout: 20000 }, async (t) => {
  const server = await startServer(t), login = await server.login();
  assert.equal((await server.request('GET', '/api/notifications/push')).status, 401);
  const api = (method, body) => server.request(method, '/api/notifications/push', { body, cookie: login.cookie });
  const state = (await api('GET')).data; assert.equal(state.available, true); assert.equal(typeof state.publicKey, 'string');
  const own = subscription(); assert.equal((await api('POST', own)).status, 200);
  assert.equal(JSON.stringify((await api('GET')).data).includes(own.endpoint), false);
  assert.equal(JSON.stringify((await api('GET')).data).includes('privateKey'), false);
  assert.equal((await api('POST', { ...own, endpoint: 'http://127.0.0.1:7778/' })).status, 400);
  assert.equal((await api('DELETE', { endpoint: own.endpoint })).status, 200);
});
test('push worker drops revoked, stale and cross-login alerts, deduplicates, and uses safe destinations', async () => {
  const handlers = {}, shown = [], navigated = [], claims = new Set();
  let settings = { scope: 'computer:owner', preferences: { aiTasks: true, sounds: false } }, authorized = true;
  const self = { location: { origin: 'https://pocket.example' }, addEventListener: (type, handle) => { handlers[type] = handle; }, registration: { showNotification: async (title, options) => shown.push({ title, ...options }) }, clients: { matchAll: async () => [], openWindow: async (url) => navigated.push(url) } };
  const context = vm.createContext({ self, URL, Date, importScripts() {}, fetch: async () => ({ ok: authorized, json: async () => settings }), PocketNotificationStore: { claim: async (scope, id) => { const key = `${scope}:${id}`; if (claims.has(key)) return false; claims.add(key); return true; } } });
  vm.runInContext(fs.readFileSync(new URL('../public/notifications-worker.js', import.meta.url), 'utf8'), context);
  const deliver = async (payload) => { let pending; handlers.push({ data: { json: () => payload }, waitUntil: (value) => { pending = value; } }); await pending; };
  const payload = { ...notice, scope: 'computer:owner', at: Date.now() };
  authorized = false; await deliver(payload); assert.equal(shown.length, 0);
  authorized = true; await deliver({ ...payload, scope: 'computer:other' }); await deliver({ ...payload, at: Date.now() - 61000 }); assert.equal(shown.length, 0);
  await deliver(payload); await deliver(payload); assert.equal(shown.length, 1); assert.equal(shown[0].silent, true);
  let pending; handlers.notificationclick({ notification: { close() {}, data: { action: { kind: 'chat', id: 'https://attacker.example' } } }, waitUntil: (value) => { pending = value; } }); await pending;
  assert.equal(navigated[0], 'https://pocket.example/');
});
