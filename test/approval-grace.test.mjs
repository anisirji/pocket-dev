import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const PHONE = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36' };
const OTHER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36' };
const statusOf = async (s, cookie) => (await s.request('GET', '/api/status', { cookie })).data.status;

// The restart route writes this note just before the process exits; the new process reads it at login.
const noteRestart = (s, { ua = PHONE['user-agent'], net = '127.0.0.1', at = Date.now() } = {}) =>
  fs.writeFileSync(path.join(s.stateDir, 'restart-grace.json'), JSON.stringify({ at, ua, net }));

test('after an update the same browser logs in without approval, once; others still wait', { timeout: 90000 }, async (t) => {
  const s = await startServer(t);
  assert.equal((await s.local('PUT', '/api/settings', { requireApproval: true })).status, 200);

  noteRestart(s);
  const stranger = await s.login({ headers: OTHER });
  assert.equal(stranger.data.pending, true, 'a different browser still waits');
  const mine = await s.login({ headers: PHONE });
  assert.equal(mine.data.pending, undefined);
  assert.equal(await statusOf(s, mine.cookie), 'active', 'the browser that asked for the update is let in');
  const again = await s.login({ headers: PHONE });
  assert.equal(again.data.pending, true, 'the note is spent after one login');

  noteRestart(s, { net: '203.0.113.9' });
  assert.equal((await s.login({ headers: PHONE })).data.pending, true, 'another network waits');
  noteRestart(s, { at: Date.now() - 11 * 60_000 });
  assert.equal((await s.login({ headers: PHONE })).data.pending, true, 'an old note is ignored');
  assert.match(fs.readFileSync(path.join(s.stateDir, 'security.log'), 'utf8'), /"by":"update-grace"/);
});

test('recovery code: approves a new device once, wrong codes do not, and the Mac makes it', { timeout: 90000 }, async (t) => {
  const s = await startServer(t);
  assert.equal((await s.local('PUT', '/api/settings', { requireApproval: true })).status, 200);
  assert.equal((await s.status()).recoveryCode, false);
  const made = await s.local('POST', '/api/recovery-code', {});
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const { code } = made.data;
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal((await s.status()).recoveryCode, true);
  assert.equal(JSON.stringify(fs.readFileSync(s.config, 'utf8')).includes(code), false, 'only a hash is stored');
  assert.equal((await s.request('POST', '/api/recovery-code', { body: {} })).status, 401, 'a phone cannot make one');

  const wrong = await s.login({ body: { password: 'test-password', code: 'AAAA-AAAA-AAAA-AAAA' } });
  assert.equal(wrong.status, 401);
  assert.equal((await s.status()).devices.length, 0, 'a wrong code makes no device');
  assert.equal((await s.login({ body: { password: 'nope', code } })).status, 401, 'the code alone is not enough');

  const ok = await s.login({ body: { password: 'test-password', code: code.toLowerCase().replaceAll('-', ' ') } });
  assert.equal(ok.status, 200);
  assert.equal(await statusOf(s, ok.cookie), 'active');
  assert.equal((await s.status()).recoveryCode, false, 'using the code spends it');
  assert.equal((await s.login({ body: { password: 'test-password', code } })).status, 401);

  const plain = await s.login();
  assert.equal(plain.data.pending, true, 'password alone still waits');
  const code2 = (await s.local('POST', '/api/recovery-code', {})).data.code;
  const pendingWithCode = await s.login({ cookie: plain.cookie, body: { password: 'test-password', code: code2 } });
  assert.equal(pendingWithCode.status, 200);
  assert.equal(await statusOf(s, plain.cookie), 'active', 'a waiting device is approved by the code');
});
