import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, PHONE_IP } from './helpers/server.mjs';

// A Quick link started by hand: the server is told its hostname in allowedHosts and has no tunnel of its own.
const QUICK = 'hand-quick.trycloudflare.com';
const via = (cookie) => ({ host: QUICK, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP, ...(cookie && { cookie }) });
const allow = (s) => fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config, 'utf8')), allowedHosts: [QUICK] }));

test('a phone away from home makes a login QR for the link it is on, and it works there once', { timeout: 90000 }, async (t) => {
  const s = await startServer(t);
  allow(s);
  const T = await s.login({ headers: via() });
  assert.equal(T.status, 200);
  const id = (await s.request('GET', '/api/settings', { cookie: T.cookie, headers: via(T.cookie) })).data;
  assert.equal(id.via, 'remote');
  assert.equal(id.urls.remote, `https://${QUICK}`, 'the address shown is the one in use');

  const made = await s.request('POST', '/api/settings/qr-key', { cookie: T.cookie, headers: via(T.cookie), body: {} });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.ok(made.data.url.startsWith(`https://${QUICK}/?k=`), made.data.url);
  assert.match(made.data.svg, /<svg/);

  const link = new URL(made.data.url);
  const redeemed = await s.request('GET', link.pathname + link.search, { headers: via() });
  assert.match(redeemed.cookie, /^pd_token=/, 'scanning logs the other phone in with no password');
  const other = await s.request('GET', '/api/settings', { cookie: redeemed.cookie, headers: via(redeemed.cookie) });
  assert.equal(other.status, 200);
  assert.notEqual(other.data.currentDeviceId, id.currentDeviceId, 'a second device');
  assert.equal((await s.request('GET', '/api/settings', { cookie: redeemed.cookie })).status, 401, 'its cookie is for the link, not for Wi-Fi');

  const again = await s.request('GET', link.pathname + link.search, { headers: via() });
  assert.equal(again.cookie, undefined, 'a code works once');
  assert.match(fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8'), new RegExp(`"type":"qr-created".*"address":"https://${QUICK}"`));
});

test('with role access on, an Admin phone can still make a login QR, and the new device is an Admin', { timeout: 90000 }, async (t) => {
  const s = await startServer(t);
  allow(s);
  const T = await s.login({ headers: via() });
  const currentId = (await s.request('GET', '/api/settings', { cookie: T.cookie, headers: via(T.cookie) })).data.currentDeviceId;
  assert.equal((await s.local('POST', '/api/collaborators/enable', { adminDeviceIds: [currentId] })).status, 200);
  const made = await s.request('POST', '/api/settings/qr-key', { cookie: T.cookie, headers: via(T.cookie), body: {} });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const link = new URL(made.data.url);
  const redeemed = await s.request('GET', link.pathname + link.search, { headers: via() });
  const other = await s.request('GET', '/api/settings', { cookie: redeemed.cookie, headers: via(redeemed.cookie) });
  assert.equal(other.status, 200);
  assert.equal(other.data.role, 'admin');
  assert.equal((await s.request('POST', '/api/settings/qr-key', { body: {} })).status, 401, 'no login, no QR');
});

test('on Wi-Fi the settings still show the Wi-Fi addresses', { timeout: 60000 }, async (t) => {
  const s = await startServer(t);
  const A = await s.login();
  const settings = (await s.request('GET', '/api/settings', { cookie: A.cookie })).data;
  assert.equal(settings.via, 'lan');
  assert.ok(settings.urls.lan || settings.urls.local);
});
