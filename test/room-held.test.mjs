import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { trio } from './helpers/forward-trio.mjs';
import { until } from './helpers/server.mjs';

// A change forwarded to a device whose owner has to approve it waits for the answer. The short limit for a silent target
// must not cut that wait off: the front would say "did not answer" while the approval card is still open.
test('a forwarded change waits for approval longer than the short answer limit', { timeout: 60000 }, async (t) => {
  const env = { POCKET_DEV_FORWARD_ANSWER_MS: '600', POCKET_DEV_FORWARD_WRITE_MS: '15000' };
  const { h, a } = await trio(t, { env });
  assert.equal((await h.api('PUT', `/modes/${a.id}`, { mode: 'ask' })).status, 200);
  const dir = path.join(h.home, 'Desktop');
  const held = a.to(h, 'POST', '/api/files/mkdir', { dir, name: 'needs-yes' });
  let card;
  await until(async () => { card = (await h.api('GET', '/approvals')).data.pending?.[0]; return Boolean(card); }, 8000);
  await new Promise((r) => setTimeout(r, 1500)); // longer than the 600 ms short limit
  assert.equal((await h.api('POST', `/approvals/${card.id}`, { decision: 'allow' })).status, 200);
  const done = await held;
  assert.equal(done.status, 201, `the change went through after approval: ${JSON.stringify(done.data)}`);
});

test('a read still gets the short answer limit when the target stays silent', { timeout: 30000 }, async (t) => {
  const env = { POCKET_DEV_FORWARD_ANSWER_MS: '600', POCKET_DEV_FORWARD_WRITE_MS: '15000' };
  const { h, a } = await trio(t, { env });
  assert.equal((await a.to(h, 'GET', '/api/files/places')).status, 200, 'a normal read is unaffected');
});
