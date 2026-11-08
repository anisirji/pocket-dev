import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, HOSTNAME, TOKEN, PHONE_IP, pause, until, lanAddress, freePort, traceServer, startServer } from './helpers/server.mjs';

test('internet access off by default: nothing new answers, no tunnel starts, no outbound lookups', { timeout: 60000 }, async (t) => {
  const trace = await traceServer(t);
  const s = await startServer(t, { traceUrl: trace.url });
  const A = await s.login();
  assert.equal((await s.request('GET', '/api/connection', { cookie: A.cookie })).status, 404);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: A.cookie, body: {} })).status, 404);
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } })).status, 404);
  const landing = await s.request('GET', '/?h=0123456789abcdef');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/login.html', 'a handoff link is an ordinary page request while the feature is off');
  const refused = await s.local('PUT', '/api/remote', { on: true });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Internet access is off/);
  const st = await s.status();
  assert.deepEqual(st.network, { wifi: true, internet: { kind: 'off', hostname: null }, hasToken: false, cloudflared: st.network.cloudflared, tunnel: { status: 'off', kind: null, url: null, error: null } });
  assert.equal(st.urls.remote, null);
  assert.equal(fs.existsSync(path.join(s.record, 'argv')), false, 'cloudflared never ran');
  assert.equal(trace.server.hits, 0, 'no public-address lookup while internet access is off');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 421, 'no tunnel hostname is accepted');
});

test('Wi-Fi access off binds loopback only, so the Mac is reached through the tunnel alone', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { wifi: false, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  assert.equal((await s.request('GET', '/api/status')).status, 200);
  const lan = lanAddress();
  if (lan) {
    await assert.rejects(fetch(`http://${lan}:${s.port}/api/status`, { signal: AbortSignal.timeout(3000) }), 'the LAN address must refuse');
  }
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.equal(st.network.wifi, false);
  assert.equal(st.urls.lan, null);
  assert.equal(st.urls.mdns, null);
  assert.equal((await s.local('POST', '/api/qr', { kind: 'share' })).data.url, `https://${HOSTNAME}`);
  assert.doesNotMatch(s.logs(), /running at http/, 'no LAN address is announced');
  assert.match(s.logs(), new RegExp(`Internet link: https://${HOSTNAME}`));
  const lockout = await s.local('PUT', '/api/network', { internet: { kind: 'off' } });
  assert.equal(lockout.status, 400);
  assert.match(lockout.data.error, /Turn on internet access before/);
  const D = await s.login({ via: 'tunnel' });
  const refused = await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {}, via: 'tunnel' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /Wi-Fi access is off/);
  // A forward listens on the Wi-Fi address, which Wi-Fi access off is meant to keep closed.
  if (lan) {
    fs.writeFileSync(s.lanIp, lan);
    await until(async () => (await s.request('GET', '/api/info', { cookie: D.cookie, via: 'tunnel' })).data.lanIp === lan);
  }
  const devPort = await freePort();
  const forward = await s.request('POST', '/api/forwards', { cookie: D.cookie, body: { port: devPort }, via: 'tunnel' });
  assert.equal(forward.status, 409, JSON.stringify(forward.data));
  assert.match(forward.data.error, /Wi-Fi access is off/);
  assert.deepEqual((await s.request('GET', '/api/info', { cookie: D.cookie, via: 'tunnel' })).data.forwards, []);
  if (lan) await assert.rejects(fetch(`http://${lan}:${devPort}/`, { signal: AbortSignal.timeout(2000) }), 'nothing listens on the Wi-Fi address');
});

test('handoff: a Wi-Fi cookie for the same device, minted through the tunnel and usable once, on the Wi-Fi address only', { timeout: 90000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  await s.tunnelStatus('connected');
  const D = await s.login({ via: 'tunnel' });
  assert.equal(D.status, 200);
  assert.match(D.headers.get('set-cookie'), /; Secure/, 'the internet cookie is https-only');
  const deviceId = (await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).data.currentDeviceId;
  const devices = async (cookie, via) => (await s.request('GET', '/api/settings', { cookie, via })).data.devices;
  const mint = async () => {
    const r = await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {}, via: 'tunnel' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const link = new URL(r.data.url);
    assert.equal(link.origin, s.base, 'the link uses the Wi-Fi address');
    assert.match(link.searchParams.get('h'), /^[a-f0-9]{64}$/);
    return link.search;
  };
  const redeem = (search, options) => s.request('GET', `/${search}`, options);
  const refused = (r, why) => {
    assert.equal(r.status, 302, why);
    assert.equal(r.headers.get('location'), '/login.html?e=handoff', why);
    assert.equal(r.cookie, undefined, why);
  };

  assert.equal((await s.request('GET', '/api/connection', { cookie: D.cookie, via: 'tunnel' })).data.sameNetwork, null, 'no public address could be learned, so the hint is unknown, never true');
  assert.equal((await s.request('POST', '/api/handoff', { cookie: D.cookie, body: {} })).status, 401, 'the internet cookie is no login on the Wi-Fi address');
  assert.equal((await s.request('POST', '/api/handoff', { body: {}, via: 'tunnel' })).status, 401);
  const leaked = await mint();
  refused(await redeem(leaked, { via: 'tunnel' }), 'a token replayed through the tunnel is refused');
  refused(await redeem(leaked), 'and spent');
  refused(await redeem(await mint(), { headers: { host: `localhost:${s.port}` } }), 'only the Wi-Fi address or .local name may redeem');
  refused(await redeem('?h=' + 'f'.repeat(64)), 'an unknown token');
  const expiring = await mint();
  await pause(1700);
  refused(await redeem(expiring), 'an expired token');

  const search = await mint();
  const landed = await redeem(search);
  assert.equal(landed.status, 200);
  assert.match(landed.data, /location\.replace\("\/" \+ location\.hash\)/, 'the bounce keeps the fragment that names the terminal or chat');
  assert.match(landed.cookie, /^pd_token=/);
  assert.doesNotMatch(landed.headers.get('set-cookie'), /; Secure/, 'the Wi-Fi cookie must work over http');
  const L = landed.cookie;
  refused(await redeem(search), 'single use');
  assert.notEqual(L, D.cookie);
  assert.equal((await s.request('GET', '/api/settings', { cookie: L })).data.currentDeviceId, deviceId, 'the same device on both addresses');
  assert.deepEqual((await devices(L)).map((d) => d.id), [deviceId], 'one device, not two');
  assert.equal((await s.request('POST', '/api/handoff', { cookie: L, body: {} })).status, 403, 'Switch to local is only offered through the tunnel');

  // At the device limit a handoff still succeeds and nobody is logged out.
  assert.equal((await s.local('PUT', '/api/settings', { maxDevices: 1 })).status, 200);
  const again = await redeem(await mint(), { cookie: L });
  assert.equal(again.status, 200);
  assert.equal((await devices(again.cookie)).length, 1);
  assert.equal((await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).status, 200, 'the internet cookie still works');
  assert.equal((await s.request('GET', '/api/settings', { cookie: L })).status, 401, 'the Wi-Fi cookie sent with the redeem was replaced, not kept as a third login');
  const log = (await s.local('GET', '/api/log')).data;
  assert.equal(log.some((e) => e.type === 'device-revoked'), false, 'no eviction');
  assert.deepEqual([...new Set(log.filter((e) => e.type.startsWith('handoff')).map((e) => e.type))].sort(), ['handoff-created', 'handoff-failed', 'handoff-redeemed']);
  const secrets = [search, leaked, expiring].map((q) => q.slice(3));
  const everything = JSON.stringify(log) + fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8') + s.logs();
  assert.ok(secrets.every((token) => !everything.includes(token)), 'handoff tokens never reach a log');

  // Revoking the device ends both cookies.
  assert.equal((await s.request('DELETE', `/api/devices/${deviceId}`, { cookie: again.cookie })).status, 204);
  assert.equal((await s.request('GET', '/api/settings', { cookie: again.cookie })).status, 401);
  assert.equal((await s.request('GET', '/api/settings', { cookie: D.cookie, via: 'tunnel' })).status, 401);

  // The other direction: a phone at home links itself to the internet address so it never meets the password there.
  assert.equal((await s.local('PUT', '/api/settings', { maxDevices: 5 })).status, 200);
  const H = await s.login();
  const homeId = (await s.request('GET', '/api/settings', { cookie: H.cookie })).data.currentDeviceId;
  assert.equal((await s.request('GET', '/api/connection', { cookie: H.cookie })).data.linked, false);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: H.cookie, body: { direction: 'to-remote' }, via: 'tunnel' })).status, 401, 'the Wi-Fi cookie is no login on the internet address');
  assert.equal((await s.request('POST', '/api/handoff', { cookie: H.cookie, body: { direction: 'sideways' } })).status, 400);
  const mintLink = async () => {
    const r = await s.request('POST', '/api/handoff', { cookie: H.cookie, body: { direction: 'to-remote' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const link = new URL(r.data.url);
    assert.equal(link.origin, `https://${HOSTNAME}`);
    return link.search;
  };
  refused(await redeem(await mintLink()), 'a to-remote token is never accepted on the Wi-Fi address');
  assert.equal((await s.local('PUT', '/api/settings', { requireApproval: true })).status, 200);
  const linkSearch = await mintLink();
  const linkedLanding = await redeem(linkSearch, { via: 'tunnel' });
  assert.equal(linkedLanding.status, 200);
  assert.match(linkedLanding.data, /location\.replace\("\/\?linked=1" \+ location\.hash\)/, 'the landing says it just linked, with the fragment');
  assert.match(linkedLanding.headers.get('set-cookie'), /; Secure/);
  const R = linkedLanding.cookie;
  refused(await redeem(linkSearch, { via: 'tunnel' }), 'single use');
  const away = await s.request('GET', '/api/status', { cookie: R, via: 'tunnel' });
  assert.deepEqual([away.status, away.data.status], [200, 'active'], 'no password and no approval on the internet address');
  assert.equal((await s.request('GET', '/api/settings', { cookie: R, via: 'tunnel' })).data.currentDeviceId, homeId, 'the same device');
  assert.equal((await s.request('POST', '/api/handoff', { cookie: R, body: { direction: 'to-remote' }, via: 'tunnel' })).status, 403, 'linking is asked for on Wi-Fi');
  assert.equal((await s.request('GET', '/api/connection', { cookie: H.cookie })).data.linked, true);
  assert.equal((await s.request('GET', '/api/connection', { cookie: R, via: 'tunnel' })).data.linked, true);
  assert.equal((await s.status()).devices.filter((d) => d.status === 'pending').length, 0, 'handoff logins never wait for approval');
  const stranger = await s.login({ via: 'tunnel' });
  assert.equal(stranger.data.pending, true, 'a new device typing the password still waits for approval');
  const linkLog = (await s.local('GET', '/api/log')).data.filter((e) => e.type === 'handoff-redeemed' && e.direction === 'to-remote');
  assert.equal(linkLog.length, 1);
  assert.equal(linkLog[0].host, HOSTNAME);
  assert.equal((await s.request('DELETE', `/api/devices/${homeId}`, { cookie: H.cookie })).status, 204);
  assert.equal((await s.request('GET', '/api/settings', { cookie: R, via: 'tunnel' })).status, 401, 'revoking the device ends the linked cookie too');
  assert.equal((await s.local('PUT', '/api/settings', { requireApproval: false })).status, 200);

  // A collaborator session is never an owner device, so it cannot ask for a handoff.
  const A = await s.login();
  const adminId = (await s.request('GET', '/api/settings', { cookie: A.cookie })).data.currentDeviceId;
  const repo = path.join(s.home, 'project');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.equal((await s.local('PUT', '/api/settings', { maxDevices: 5 })).status, 200);
  assert.equal((await s.local('POST', '/api/collaborators/enable', { adminDeviceIds: [adminId] })).status, 200);
  const grant = await s.request('POST', '/api/collaborators', { cookie: A.cookie, body: { label: 'Reviewer', role: 'viewer', repository: repo, extraFolders: [], ai: false, duration: 3600 } });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  const invite = await s.request('POST', `/api/collaborators/${grant.data.id}/invite`, { cookie: A.cookie, body: {} });
  const token = new URLSearchParams(new URL(invite.data.url).hash.slice(1)).get('token');
  const G = (await s.request('POST', '/api/invitations/accept', { body: { token }, via: 'tunnel' })).cookie;
  assert.match(G, /^pd_collaborator=/);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: G, body: {}, via: 'tunnel' })).status, 403);
  assert.equal((await s.request('POST', '/api/handoff', { cookie: `${G}; ${A.cookie}`, body: {}, via: 'tunnel' })).status, 403, 'a guest cookie never falls through to the owner');
});

test('domain tunnel: token in the environment only, never in argv, responses or logs; the hostname is served', { timeout: 60000 }, async (t) => {
  const trace = await traceServer(t);
  const s = await startServer(t, { network: { wifi: true, internet: { kind: 'quick' } }, traceUrl: trace.url });
  const A = await s.login();
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN } })).status, 403, 'a phone cannot widen access');
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME } })).status, 400, 'a domain needs its token');
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: 'pocket' }, token: TOKEN })).status, 400);
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: 'has spaces in it' })).status, 400);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'tunnel-token')), false, 'a refused save writes nothing');
  const saved = await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.hasToken, true);
  assert.equal(fs.statSync(path.join(s.stateDir, 'tunnel-token')).mode & 0o777, 0o600);
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.deepEqual(st.network.internet, { kind: 'domain', hostname: HOSTNAME });
  assert.equal(st.network.tunnel.url, `https://${HOSTNAME}`);
  assert.equal(st.urls.remote, `https://${HOSTNAME}`);
  assert.equal(JSON.parse(fs.readFileSync(s.config, 'utf8')).network.internet.hostname, HOSTNAME);
  assert.equal(s.recorded('argv').trim().split('\n').join(' '), 'tunnel --no-autoupdate run');
  assert.match(s.recorded('env'), new RegExp(`^TUNNEL_TOKEN=${TOKEN}$`, 'm'));
  const everything = JSON.stringify(st) + JSON.stringify((await s.local('GET', '/api/log')).data) + fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8') + s.logs() + fs.readFileSync(s.config, 'utf8');
  assert.equal(everything.includes(TOKEN), false, 'the token never appears in a response, a log or config.json');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 200, 'the domain hostname is accepted on https');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel', headers: { host: `${HOSTNAME}:443` } })).status, 200);
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel', headers: { host: `${HOSTNAME}:8080` } })).status, 421);
  assert.equal((await s.request('GET', '/api/status', { headers: { host: `${HOSTNAME}:443` } })).status, 308, 'without the connector the hostname is only ever sent to https');
  // The connection hint: the phone's public address matches the Mac's, so they share a network.
  const T = await s.login({ via: 'tunnel' });
  assert.equal(T.status, 200);
  const remote = await s.request('GET', '/api/connection', { cookie: T.cookie, via: 'tunnel' });
  assert.equal(remote.status, 200);
  assert.match(remote.data.networkKey, /^[0-9a-f]{12}$/);
  assert.deepEqual(remote.data, { route: 'remote', sameNetwork: true, networkKey: remote.data.networkKey, linked: true, lanUrl: s.base, remoteUrl: `https://${HOSTNAME}`, wifi: true, internet: 'domain' });
  assert.ok(trace.server.hits >= 1, 'the public address came from the trace endpoint');
  const elsewhere = await s.request('GET', '/api/connection', { cookie: T.cookie, via: 'tunnel', headers: { 'cf-connecting-ip': '198.51.100.7' } });
  assert.equal(elsewhere.data.sameNetwork, false);
  assert.notEqual(elsewhere.data.networkKey, remote.data.networkKey);
  assert.notEqual((await s.request('GET', '/api/connection', { cookie: T.cookie, via: 'tunnel', headers: { 'cf-connecting-ip': '2001:db8::1' } })).data.sameNetwork, true, 'an IPv6 phone on a documentation prefix is a mismatch, or unknown on a Mac without global IPv6, never a match');
  const local = (await s.request('GET', '/api/connection', { cookie: A.cookie })).data;
  assert.deepEqual(local, { route: 'local', sameNetwork: null, networkKey: null, linked: false, lanUrl: s.base, remoteUrl: `https://${HOSTNAME}`, wifi: true, internet: 'domain' });
  assert.equal((await s.request('GET', '/api/connection')).status, 401);
  const share = await s.local('POST', '/api/qr', { kind: 'share' });
  assert.equal(share.data.url, `https://${HOSTNAME}`, 'sharing defaults to the internet address');
  assert.equal(new URL((await s.local('POST', '/api/qr', { kind: 'login' })).data.url).origin, `https://${HOSTNAME}`);
  // A bad token is reported with cloudflared's own words.
  const bad = await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: `${TOKEN}bad` });
  assert.equal(bad.status, 200);
  await s.tunnelStatus('error');
  assert.match((await s.status()).network.tunnel.error, /Unauthorized: Failed to get tunnel/);
  assert.equal((await s.local('PUT', '/api/network', { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN })).status, 200);
  await s.tunnelStatus('connected');
  // Disconnect stops the link; Connect brings the domain link back on its own.
  assert.equal((await s.local('PUT', '/api/access', { connected: false })).status, 200);
  assert.equal((await s.status()).network.tunnel.status, 'off');
  assert.equal((await s.local('PUT', '/api/access', { connected: true })).status, 200);
  await s.tunnelStatus('connected');
  // A phone may turn internet access off, and nothing new answers afterwards.
  const off = await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.internet.kind, 'off');
  assert.equal(off.data.tunnel.status, 'off');
  assert.equal(off.data.hasToken, true, 'the token stays for the next time');
  assert.equal((await s.request('GET', '/api/status', { via: 'tunnel' })).status, 421);
  assert.equal((await s.request('PUT', '/api/network', { cookie: A.cookie, body: { internet: { kind: 'off' } } })).status, 404);
});

test('the internet hostname is served over https only: plain http is sent on, and https responses carry HSTS', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  await s.tunnelStatus('connected');
  // What Cloudflare relays for http://pocket.example.test while Always Use HTTPS is off.
  const plain = { host: HOSTNAME, 'x-forwarded-proto': 'http', 'cf-connecting-ip': PHONE_IP };
  const page = await s.request('GET', '/?h=abc', { headers: plain });
  assert.equal(page.status, 308);
  assert.equal(page.headers.get('location'), `https://${HOSTNAME}/?h=abc`);
  assert.equal(page.headers.get('set-cookie'), null);
  const login = await s.login({ headers: plain });
  assert.equal(login.status, 308, 'a password sent over plain http logs nothing in');
  assert.equal(login.cookie, undefined);
  assert.equal((await s.request('GET', '/api/status', { headers: { host: HOSTNAME } })).status, 308, 'a direct request naming the hostname is not a Wi-Fi request either');
  assert.equal((await s.status()).devices.length, 0, 'no device was created over http');
  const secure = await s.request('GET', '/api/status', { via: 'tunnel' });
  assert.equal(secure.status, 200);
  assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal((await s.request('GET', '/api/status')).headers.get('strict-transport-security'), null, 'Wi-Fi is http, so no HSTS there');
});

test('a cookie works only on the address it was issued for', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  await s.tunnelStatus('connected');
  const L = await s.login();
  assert.equal(L.status, 200);
  const id = (await s.request('GET', '/api/settings', { cookie: L.cookie })).data.currentDeviceId;
  assert.equal((await s.request('GET', '/api/settings', { cookie: L.cookie, via: 'tunnel' })).status, 401, 'a Wi-Fi cookie, which travels over plain http, is no login on the internet address');
  assert.equal((await s.request('GET', '/api/status', { cookie: L.cookie, via: 'tunnel' })).data.status, 'none');
  const link = new URL((await s.request('POST', '/api/handoff', { cookie: L.cookie, body: { direction: 'to-remote' } })).data.url);
  const R = (await s.request('GET', link.pathname + link.search, { via: 'tunnel' })).cookie;
  assert.match(R, /^pd_token=/);
  assert.equal((await s.request('GET', '/api/settings', { cookie: R, via: 'tunnel' })).data.currentDeviceId, id, 'the linked cookie is the same device on the internet address');
  assert.equal((await s.request('GET', '/api/settings', { cookie: R })).status, 401, 'and is no login on Wi-Fi');
  assert.equal((await s.request('GET', '/api/settings', { cookie: L.cookie })).status, 200, 'the Wi-Fi cookie still works where it was issued');
});

test('a devices file from before multi-address cookies still logs its devices in, on Wi-Fi only', { timeout: 60000 }, async (t) => {
  const oldToken = 'a'.repeat(64), olderToken = 'b'.repeat(64);
  const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const s = await startServer(t, { network: { internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN, devices: [
    { tokenHash: hash(oldToken), id: 'old00001', name: 'Old phone', ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', createdAt: 1700000000000, lastSeen: 1700000000000, ip: '192.168.1.9', via: 'password', status: 'active' },
    { tokenHash: hash(olderToken), id: 'old00002', name: 'Older phone', createdAt: 1690000000000, lastSeen: 1690000000000, ip: '192.168.1.8', via: 'qr' },
  ] });
  await s.tunnelStatus('connected');
  for (const token of [oldToken, olderToken]) {
    assert.equal((await s.request('GET', '/api/settings', { cookie: `pd_token=${token}` })).status, 200, 'every old cookie still works on Wi-Fi');
    assert.equal((await s.request('GET', '/api/settings', { cookie: `pd_token=${token}`, via: 'tunnel' })).status, 401, 'an old cookie was issued before the internet link existed, so it is a Wi-Fi cookie');
  }
  const settings = (await s.request('GET', '/api/settings', { cookie: `pd_token=${oldToken}` })).data;
  assert.deepEqual(settings.devices.map((d) => d.id).sort(), ['old00001', 'old00002']);
  assert.equal(settings.currentDeviceId, 'old00001');
  assert.equal(JSON.stringify(settings).includes(hash(oldToken)), false, 'cookie hashes never leave the server');
  assert.equal((await s.request('DELETE', '/api/devices/old00002', { cookie: `pd_token=${oldToken}` })).status, 204);
  assert.equal((await s.request('GET', '/api/settings', { cookie: `pd_token=${olderToken}` })).status, 401);
  const saved = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'devices.json'), 'utf8')).devices;
  assert.deepEqual(saved.map((d) => [d.id, d.tokenHash, d.tokenHashes]), [['old00001', hash(oldToken), [{ hash: hash(oldToken), host: 'lan' }]]], 'saved in both shapes; an old cookie is recorded as the Wi-Fi cookie it was');
});

test('Quick link: on demand from Admin, a random address, and off again', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { network: { internet: { kind: 'quick' } } });
  assert.equal((await s.status()).network.tunnel.status, 'off', 'a restart never publishes a Quick link');
  const on = await s.local('PUT', '/api/remote', { on: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  await s.tunnelStatus('connected');
  const st = await s.status();
  assert.equal(st.network.tunnel.url, 'https://quick-fixture-1.trycloudflare.com');
  assert.equal(st.urls.remote, st.network.tunnel.url);
  assert.equal(s.recorded('argv').trim().split('\n').slice(0, 3).join(' '), 'tunnel --no-autoupdate --url');
  assert.doesNotMatch(s.recorded('env'), /^TUNNEL_TOKEN=/m);
  const quick = (host, cookie) => ({ host, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP, ...(cookie && { cookie }) });
  assert.equal((await s.request('GET', '/api/status', { headers: quick('quick-fixture-1.trycloudflare.com') })).status, 200);
  // Linking to a Quick link: the token is bound to that start's hostname, so the next start needs a new link.
  const A = await s.login();
  const linkUrl = (await s.request('POST', '/api/handoff', { cookie: A.cookie, body: { direction: 'to-remote' } })).data.url;
  assert.equal(new URL(linkUrl).origin, 'https://quick-fixture-1.trycloudflare.com');
  assert.equal((await s.request('GET', '/api/connection', { cookie: A.cookie })).data.linked, false);
  const stale = (await s.request('POST', '/api/handoff', { cookie: A.cookie, body: { direction: 'to-remote' } })).data.url;
  const linked = await s.request('GET', new URL(linkUrl).pathname + new URL(linkUrl).search, { headers: quick('quick-fixture-1.trycloudflare.com') });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal((await s.request('GET', '/api/connection', { cookie: A.cookie })).data.linked, true);
  assert.equal((await s.local('PUT', '/api/remote', { on: false })).data.status, 'off');
  assert.equal((await s.local('PUT', '/api/remote', { on: true })).status, 200);
  await s.tunnelStatus('connected');
  assert.equal((await s.status()).network.tunnel.url, 'https://quick-fixture-2.trycloudflare.com', 'a new start gives a new address');
  assert.equal((await s.request('GET', new URL(stale).pathname + new URL(stale).search, { headers: quick('quick-fixture-1.trycloudflare.com') })).status, 421, 'the old hostname is no longer served');
  const wrongHost = await s.request('GET', new URL(stale).pathname + new URL(stale).search, { headers: quick('quick-fixture-2.trycloudflare.com') });
  assert.equal(wrongHost.status, 302, 'a token for the old hostname is refused on the new one');
  assert.equal(wrongHost.cookie, undefined);
  assert.equal((await s.request('GET', '/api/connection', { cookie: A.cookie })).data.linked, false, 'the phone is asked to link again');
  assert.equal((await s.request('GET', '/api/settings', { headers: quick('quick-fixture-2.trycloudflare.com', linked.cookie) })).status, 401, 'the cookie from the first link was issued for the old hostname, so the new one asks for the password or a new link');
  // The CLI talks to the running server through its admin page.
  const cli = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), 'internet', ...args], { env: { ...process.env, POCKET_DEV_STATE_DIR: s.stateDir, POCKET_DEV_CONFIG: s.config }, encoding: 'utf8', input: '' });
  assert.match(cli('status').stdout, /Link: connected at https:\/\/quick-fixture-2\.trycloudflare\.com/);
  const offAgain = await s.local('PUT', '/api/remote', { on: false });
  assert.equal(offAgain.data.status, 'off');
  assert.equal((await s.request('GET', '/api/status', { headers: { host: 'quick-fixture-2.trycloudflare.com' } })).status, 421);
  const viaCli = cli('off');
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.match(viaCli.stdout, /Internet access: off/);
  assert.equal((await s.status()).network.internet.kind, 'off');
  const changed = (await s.local('GET', '/api/log?filter=changes')).data.find((e) => e.type === 'network-changed');
  assert.equal(changed.by, 'cli');
});
