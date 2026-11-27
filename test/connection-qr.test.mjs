import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, HOSTNAME, TOKEN, PHONE_IP } from './helpers/server.mjs';

test('local share and login QR preserve separate authentication semantics with Remote disabled', async (t) => {
  const server = await startServer(t), login = await server.login();
  const state = (await server.local('GET', '/api/state')).data;
  assert.equal(state.qrConnections.remoteEnabled, false);
  const share = await server.local('POST', '/api/qr', { kind: 'share', connection: 'local' });
  assert.equal(share.status, 200); assert.equal(share.data.url, state.qrConnections.local);
  assert.equal(new URL(share.data.url).search, ''); assert.match(share.data.svg, /<svg/);
  assert.equal((await server.request('GET', '/api/settings')).status, 401, 'sharing an address grants no login');
  const key = await server.request('POST', '/api/settings/qr-key', { cookie: login.cookie, body: { connection: 'local' } });
  assert.equal(key.status, 200); assert.equal(new URL(key.data.url).origin, state.qrConnections.local);
  assert.ok(key.data.expiresAt > Date.now());
  const url = new URL(key.data.url), redeemed = await server.request('GET', url.pathname + url.search);
  assert.ok(redeemed.cookie); assert.equal((await server.request('GET', '/api/status', { cookie: redeemed.cookie })).data.status, 'active');
  assert.equal((await server.request('GET', url.pathname + url.search)).cookie, undefined, 'login key stays single-use');
  assert.equal((await server.local('POST', '/api/qr', { kind: 'share', connection: 'remote' })).status, 409);
  assert.equal((await server.request('POST', '/api/settings/qr-key', { body: { connection: 'local' } })).status, 401);
});

test('a failing remote tunnel retains local QR access and fresh LAN addresses', async (t) => {
  const server = await startServer(t, { network: { wifi: true, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN + 'bad' });
  const login = await server.login(), settings = () => server.request('GET', '/api/settings', { cookie: login.cookie });
  const before = (await settings()).data.qrConnections;
  assert.equal(before.remoteEnabled, true); assert.equal(before.remote, `https://${HOSTNAME}`);
  assert.ok(before.local);
  const local = await server.local('POST', '/api/qr', { kind: 'login', connection: 'local' });
  const remote = await server.local('POST', '/api/qr', { kind: 'login', connection: 'remote' });
  assert.equal(local.status, 200); assert.equal(remote.status, 200);
  assert.equal(new URL(local.data.url).origin, before.local); assert.equal(new URL(remote.data.url).origin, before.remote);
  assert.notEqual(new URL(local.data.url).search, new URL(remote.data.url).search, 'each connection receives its own single-use key');
  fs.writeFileSync(server.lanIp, '192.0.2.44');
  const after = (await settings()).data.qrConnections;
  assert.equal(after.local, `http://192.0.2.44:${server.port}`); assert.equal(after.remote, before.remote);
  const current = await server.local('POST', '/api/qr', { kind: 'share', connection: 'local' });
  assert.equal(current.data.url, after.local);
  fs.writeFileSync(server.lanIp, '');
  assert.equal((await settings()).data.qrConnections.local, null, 'a hostname must not stand in for a disconnected LAN');
  assert.equal((await server.local('POST', '/api/qr', { kind: 'share', connection: 'local' })).status, 409);
  fs.writeFileSync(server.lanIp, '192.0.2.44');
  const url = new URL(local.data.url);
  assert.ok((await server.request('GET', url.pathname + url.search)).cookie, 'a remote failure does not invalidate a local login key');
});

test('a remote Settings client can choose Local explicitly without choosing arbitrary addresses', async (t) => {
  const server = await startServer(t), host = 'qr-fixture.trycloudflare.com';
  fs.writeFileSync(server.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(server.config)), allowedHosts: [host] }));
  const headers = { host, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP };
  const login = await server.login({ headers });
  const settings = (await server.request('GET', '/api/settings', { cookie: login.cookie, headers })).data;
  assert.equal(settings.qrConnections.remoteEnabled, true); assert.ok(settings.qrConnections.local);
  for (const connection of ['local', 'remote']) {
    const key = await server.request('POST', '/api/settings/qr-key', { cookie: login.cookie, headers, body: { connection } });
    assert.equal(key.status, 200); assert.equal(new URL(key.data.url).origin, settings.qrConnections[connection]);
  }
  for (const connection of ['https://untrusted.invalid', '__proto__', null, {}, []]) {
    assert.equal((await server.request('POST', '/api/settings/qr-key', { cookie: login.cookie, headers, body: { connection } })).status, 400);
    assert.equal((await server.local('POST', '/api/qr', { kind: 'share', connection })).status, 400);
  }
});

test('selecting Local never enables an explicitly disabled Wi-Fi listener', async (t) => {
  const server = await startServer(t, { network: { wifi: false, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN + 'bad' });
  const state = (await server.local('GET', '/api/state')).data;
  assert.equal(state.qrConnections.local, null); assert.equal(state.qrConnections.remoteEnabled, true);
  assert.equal((await server.local('POST', '/api/qr', { kind: 'share', connection: 'local' })).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(server.config)).network.wifi, false);
  assert.equal((await server.local('POST', '/api/qr', { kind: 'share', connection: 'remote' })).status, 200);
});
