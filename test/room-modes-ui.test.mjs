import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLeftText, bannerText, canChange, modesAllowedFor, canEndBypass, roleOf, describeRequest, riskText, waitingText, answererText, friendlyError, MODE_ORDER, MODE_INFO, BYPASS_CHOICES } from '../public/modes-core.js';

test('time left reads as hours and minutes, then minutes and seconds', () => {
  const now = 1_000_000;
  assert.equal(timeLeftText(now + 2 * 3600_000 + 5 * 60_000, now), '2 h 05 min');
  assert.equal(timeLeftText(now + 12 * 60_000 + 9_000, now), '12:09');
  assert.equal(timeLeftText(now + 59_100, now), '1:00');
  assert.equal(timeLeftText(now + 5_000, now), '0:05');
  assert.equal(timeLeftText(now - 1, now), 'ending now');
  assert.equal(timeLeftText('always', now), 'Always');
  assert.equal(timeLeftText(null, now), 'Always');
});

test('the banner names who is in Bypass and how long is left', () => {
  const now = 0;
  assert.equal(bannerText([{ name: 'Beta', banner: false }], now), '');
  assert.match(bannerText([{ name: 'Beta', banner: true, bypassUntil: 90 * 60_000 }], now), /^Bypass is on for Beta: no questions asked, full access, 1 h 30 min left\.$/);
  assert.match(bannerText([{ name: 'A', banner: true, bypassUntil: 60_000 }, { name: 'B', banner: true, bypassUntil: 'always' }], now), /A and B.*until you end it/);
  assert.match(bannerText([1, 2, 3].map((n) => ({ name: `D${n}`, banner: true, bypassUntil: 600_000 * n })), now), /D1 and 2 others.*30:00 left/);
});

test('only the owner and the assigned person may change a mode, and the assigned person never turns Bypass on or changes their own', () => {
  assert.equal(canChange({ role: 'owner', mode: 'bypass', targetId: 'b', selfId: 'me' }), true);
  assert.equal(canChange({ role: 'assigned', mode: 'ask', targetId: 'b', selfId: 'me' }), true);
  assert.equal(canChange({ role: 'assigned', mode: 'bypass', targetId: 'b', selfId: 'me' }), false);
  assert.equal(canChange({ role: 'assigned', mode: 'ask', targetId: 'me', selfId: 'me' }), false);
  assert.equal(canChange({ role: 'none', mode: 'ask', targetId: 'b', selfId: 'me' }), false);
  assert.deepEqual(modesAllowedFor('owner'), MODE_ORDER);
  assert.deepEqual(modesAllowedFor('assigned'), ['read-only', 'plan', 'ask', 'auto']);
  assert.deepEqual(modesAllowedFor('none'), []);
  assert.equal(canEndBypass('none'), false);
  assert.equal(canEndBypass('assigned'), true);
  assert.equal(roleOf({ isLocal: true }), 'owner');
  assert.equal(roleOf({ isLocal: false, assignedTo: 'me', selfId: 'me' }), 'assigned');
  assert.equal(roleOf({ isLocal: false, assignedTo: 'x', selfId: 'me' }), 'none');
  assert.equal(roleOf({ isLocal: false, assignedTo: null, selfId: 'me' }), 'none');
});

test('every mode has a label and a one-line explanation; Bypass choices are 1-4 hours or always', () => {
  for (const m of MODE_ORDER) assert.ok(MODE_INFO[m].label && MODE_INFO[m].line.length < 90, m);
  assert.deepEqual(BYPASS_CHOICES.map(([v]) => v), [1, 2, 3, 4, 'always']);
});

test('held requests are described in plain words', () => {
  const d = (summary, path = '') => describeRequest({ summary, path }).title;
  assert.equal(d('POST /api/files/trash /Users/x/Desktop/old_videos'), 'Delete old_videos');
  assert.equal(d('POST /api/files/trash /a/one.txt, /a/two.txt'), 'Delete one.txt, two.txt');
  assert.equal(d('POST /api/files/mkdir /Users/x/Desktop/new'), 'Create folder new');
  assert.equal(d('POST /api/sessions'), 'Open a terminal');
  assert.equal(d('WS /ws/terminal'), 'Open a terminal');
  assert.equal(d('POST /api/power'), 'Change the power settings (sleep, restart or shut down)');
  assert.equal(d('POST /api/forwards'), 'Open a port to the internet');
  assert.equal(d('POST /api/sessions /Users/x : rm -rf build'), 'Run the command: rm -rf build');
  assert.match(d('POST /api/unknown/thing'), /^Change something on this device \(POST \/api\/unknown\/thing\)$/);
  assert.equal(describeRequest({ summary: 'POST /api/files/trash /Users/x/Desktop/old_videos' }).detail, '/Users/x/Desktop/old_videos');
  assert.equal(riskText({ why: 'deletes outside the granted folders' }), 'Deletes outside the granted folders.');
  assert.equal(riskText({ why: 'deletes a large item (/var/x/home/Desktop/old_videos)' }), 'Deletes a large item (Desktop/old_videos).');
  assert.equal(riskText({}), '');
});

test('waiting time, who answered and errors are plain', () => {
  assert.equal(waitingText(0, 3_000), 'Just now');
  assert.equal(waitingText(0, 42_000), 'Waiting 42 s');
  assert.equal(waitingText(0, 5 * 60_000), 'Waiting 5 min');
  assert.equal(answererText('owner'), 'the owner');
  assert.equal(answererText('assigned:Alpha'), 'Alpha');
  assert.equal(answererText(undefined), 'someone else');
  assert.match(friendlyError(new Error('Failed to fetch')), /offline/);
  assert.match(friendlyError(null, true), /offline/);
  assert.equal(friendlyError(new Error('Already allowed by owner.')), 'Already allowed by owner.');
});
