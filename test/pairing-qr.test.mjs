import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const stored = (s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'room.json'), 'utf8'));

for (const [showType, scanType] of [['personal', 'personal'], ['personal', 'external'], ['external', 'personal'], ['external', 'external']]) {
  test(`QR pairing from local Admin and phone Settings: ${showType}/${scanType}`, async (t) => {
    const a = await startServer(t), b = await startServer(t);
    const login = await b.login();
    const invite = await a.local('POST', '/api/connections/invite', { connectionType: showType });
    assert.equal(invite.status, 200);
    assert.match(invite.data.svg, /<svg/);
    assert.equal(new URL(invite.data.address).port, String(a.port), 'QR advertises public port, never local Admin');
    const own = await b.local('POST', '/api/connections/invite', { connectionType: scanType });
    assert.equal(own.status, 200);
    const before = stored(b);
    const wrong = await b.local('POST', '/api/connections/join', { code: 'WRNG-WRNG', host: a.base, connectionType: scanType });
    assert.equal(wrong.status, 403);
    assert.deepEqual(stored(b), before, 'a failed scan preserves existing state');
    const joined = await b.request('POST', '/api/connections/join', { cookie: login.cookie, body: { code: invite.data.code, host: a.base, connectionType: scanType } });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.callback.ok, true);
    assert.equal(stored(b).deviceId, before.deviceId);
    assert.deepEqual(stored(b).identity, before.identity);
    const bothPersonal = showType === 'personal' && scanType === 'personal';
    for (const s of [a, b]) {
      const summary = await s.local('GET', '/api/connections');
      assert.equal(summary.status, 200);
      assert.equal(summary.data.computers.length, 2);
      assert.equal(summary.data.computers.find((c) => !c.self).computerAccess, bothPersonal);
    }
    const oldRoom = stored(b).room;
    const rejected = await b.local('POST', '/api/connections/join', { code: own.data.code, host: a.base, connectionType: scanType });
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.error, /Existing connections have been kept/);
    assert.deepEqual(stored(b).room, oldRoom);
  });
}

test('local Admin pairing retains origin and CSRF protection', async (t) => {
  const a = await startServer(t);
  const noHeader = await a.request('POST', '/api/connections/invite', { adminRequest: true, csrf: false, body: {} });
  assert.equal(noHeader.status, 403);
  const foreign = await a.request('POST', '/api/connections/invite', { adminRequest: true, headers: { origin: 'https://untrusted.example' }, body: {} });
  assert.equal(foreign.status, 403);
  assert.equal(stored(a).room, null);
});
