import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { startServer, PHONE_IP } from './helpers/server.mjs';

const QUICK = 'hand-quick.trycloudflare.com';
const via = { host: QUICK, 'x-forwarded-proto': 'https', 'cf-connecting-ip': PHONE_IP };
const allow = (s) => fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config, 'utf8')), allowedHosts: [QUICK] }));

test('a hand-started Quick link login survives a server restart', { timeout: 90000 }, async (t) => {
  const a = await startServer(t);
  allow(a);
  assert.equal((await a.local('PUT', '/api/settings', { requireApproval: true })).status, 200);
  const pending = await a.login({ headers: via });
  assert.equal(pending.data.pending, true, JSON.stringify([pending.status, pending.data]));
  const id = (await a.status()).devices.find((d) => d.status === 'pending').id;
  assert.equal((await a.local('POST', `/api/devices/${id}/approve`, {})).status, 200);
  assert.equal((await a.request('GET', '/api/status', { cookie: pending.cookie, headers: via })).data.status, 'active');
  const stored = JSON.parse(fs.readFileSync(path.join(a.stateDir, 'devices.json'), 'utf8')).devices;
  a.proc.kill('SIGTERM');
  await once(a.proc, 'exit');
  const b = await startServer(t, { devices: stored });
  allow(b);
  const after = await b.request('GET', '/api/status', { cookie: pending.cookie, headers: via });
  assert.equal(after.data.status, 'active', JSON.stringify([after.status, after.data]));
});
