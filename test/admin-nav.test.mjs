import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { startServer } from './helpers/server.mjs';

await import('../public/admin-nav.js');
const nav = globalThis.AdminNav;
const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const base = { overview: { pending: 0, failedLogins: { count: 0, guessing: false } }, network: { internet: { kind: 'off' }, tunnel: { status: 'off' } }, access: { connected: true }, service: { installed: true } };

test('hash routing: groups, sections inside groups, and unknown hashes', () => {
  assert.deepEqual(nav.resolveHash('#devices'), { group: 'devices', section: null });
  assert.deepEqual(nav.resolveHash('#settings'), { group: 'computer', section: 'settings' });
  assert.deepEqual(nav.resolveHash('#pending'), { group: 'devices', section: 'pending' });
  assert.deepEqual(nav.resolveHash('#lockdown'), { group: 'security', section: 'lockdown' });
  assert.equal(nav.resolveHash('', 'internet').group, 'internet', 'the remembered group opens when there is no hash');
  assert.equal(nav.resolveHash('#nonsense', 'bogus').group, 'overview');
});

test('attention list and group badges', () => {
  assert.deepEqual(nav.attentionItems(base), []);
  assert.deepEqual(nav.groupBadges([]), {});
  const state = { ...base,
    overview: { pending: 2, failedLogins: { count: 7, guessing: true } },
    network: { internet: { kind: 'quick' }, tunnel: { status: 'error', error: 'boom' } },
    service: { installed: false } };
  const perms = [{ group: 'mac', state: 'missing', title: 'Accessibility' }, { group: 'mac', state: 'unknown', title: 'Full Disk Access' }, { group: 'tools', state: 'missing', title: 'GitHub CLI' }];
  const items = nav.attentionItems(state, perms);
  assert.deepEqual(items.map((i) => i.id), ['guessing', 'pending', 'tunnel', 'permissions', 'service']);
  assert.match(items.find((i) => i.id === 'permissions').text, /Accessibility/);
  assert.doesNotMatch(items.find((i) => i.id === 'permissions').text, /GitHub|Full Disk/);
  assert.deepEqual(nav.groupBadges(items), {
    security: { count: 1, level: 'danger' }, devices: { count: 2, level: 'warn' }, internet: { count: 1, level: 'danger' },
    computer: { count: 2, level: 'warn' },
  });
  const few = nav.attentionItems({ ...base, overview: { pending: 0, failedLogins: { count: 2, guessing: false } } });
  assert.deepEqual(few.map((i) => [i.id, i.level, i.to]), [['failed', 'warn', 'log']]);
  assert.match(nav.attentionItems({ ...base, service: { installed: false } }, [], { isMac: false })[0].text, /this computer/);
});

test('wording: Mac stays on a Mac and becomes computer elsewhere', () => {
  assert.equal(nav.say('Pocket Dev on this Mac', true), 'Pocket Dev on this Mac');
  assert.equal(nav.say('Pocket Dev on this Mac', false), 'Pocket Dev on this computer');
  assert.equal(nav.say('Installed as a launchd service', false), 'Installed as a background service');
  assert.equal(nav.isMacHost('MacIntel'), true);
  assert.equal(nav.isMacHost('Win32'), false);
});

test('admin.html: every group holds its sections, every old id is kept, nav links match groups', () => {
  for (const g of nav.GROUPS) {
    const start = html.indexOf(`id="group-${g.id}"`);
    assert.ok(start > 0, `group-${g.id} exists`);
    const next = html.indexOf('class="group"', start);
    const body = html.slice(start, next === -1 ? html.length : next);
    for (const section of g.sections) assert.match(body, new RegExp(`id="${section}"`), `${section} is inside ${g.id}`);
    assert.match(html, new RegExp(`<a href="#${g.id}" data-group="${g.id}">`));
  }
  for (const id of ['connection', 'internet', 'sharing', 'quickLink', 'messages', 'pending', 'devices', 'log', 'password', 'settings', 'collaborators', 'live', 'permissions', 'service', 'lockdown', 'guessing', 'logRows', 'deviceRows', 'pendingRows', 'lockBtn', 'stopBtn', 'attList', 'logMore']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))], ['quickLink'], 'the only repeated id is the one that was already repeated');
  const danger = html.indexOf('class="danger-zone"');
  assert.ok(danger > html.indexOf('id="group-security"') && danger < html.indexOf('id="group-computer"'), 'the danger zone is at the bottom of Security');
  assert.ok(html.indexOf('id="lockdown"') > danger);
});

test('the Admin listener serves the navigation script', async (t) => {
  const s = await startServer(t, {});
  const res = await fetch(`${s.admin}/admin-nav.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /resolveHash/);
});
