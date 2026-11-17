import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/update-notice.js';

const { createNotice, HIDDEN_LONG_MS } = globalThis.PocketUpdateNotice;
const newer = { available: true, latest: '1.3.0', current: '1.2.0', command: 'pocket-dev update' };

test('nothing shows when no newer version is known, or the answer is missing', async () => {
  const none = createNotice({ fetchUpdate: async () => null });
  await none.load();
  assert.equal(none.info(), null);
  assert.equal(none.pinging(), false);
  const current = createNotice({ fetchUpdate: async () => ({ available: false, latest: '1.2.0', current: '1.2.0' }) });
  await current.load();
  assert.equal(current.info(), null);
});

test('a newer version gives the icon data and a ping', async () => {
  const n = createNotice({ fetchUpdate: async () => newer });
  await n.load();
  assert.deepEqual(n.info(), { latest: '1.3.0', current: '1.2.0', command: 'pocket-dev update', os: null });
  assert.equal(n.pinging(), true);
});

test('Later stops the ping for this page, but the icon data stays', async () => {
  const n = createNotice({ fetchUpdate: async () => newer });
  await n.load();
  n.later();
  assert.equal(n.pinging(), false);
  assert.ok(n.info());
  await n.load();
  assert.equal(n.pinging(), false, 'a refresh in the same page does not undo Later');
});

test('a new page load pings again because Later was only for the old page', async () => {
  const first = createNotice({ fetchUpdate: async () => newer });
  await first.load(); first.later();
  const reopened = createNotice({ fetchUpdate: async () => newer });
  await reopened.load();
  assert.equal(reopened.pinging(), true);
});

test('coming back after more than ten minutes pings again, a short absence does not', async () => {
  let clock = 0, hits = 0;
  const n = createNotice({ now: () => clock, fetchUpdate: async () => { hits++; return newer; } });
  await n.load(); n.later();
  await n.visibility(true); clock += HIDDEN_LONG_MS;
  assert.equal(await n.visibility(false), false, 'exactly ten minutes is still short');
  assert.equal(n.pinging(), false);
  await n.visibility(true); clock += HIDDEN_LONG_MS + 1;
  assert.equal(await n.visibility(false), true);
  assert.equal(n.pinging(), true);
  assert.equal(hits, 2, 'a long absence asks for a fresh look');
});

test('when the look fails the last answer is kept', async () => {
  let fail = false;
  const n = createNotice({ fetchUpdate: async () => { if (fail) throw new Error('offline'); return newer; } });
  await n.load();
  fail = true;
  await n.load();
  assert.ok(n.info());
});

test('an update that has been installed makes the icon go away', async () => {
  let answer = newer;
  const n = createNotice({ fetchUpdate: async () => answer });
  await n.load();
  answer = { available: false, latest: '1.3.0', current: '1.3.0' };
  await n.load();
  assert.equal(n.info(), null);
});

test('the sheet gives three numbered steps worded for the computer, and the one-line alternative', () => {
  const { updateSteps } = globalThis.PocketUpdateNotice;
  const mac = updateSteps('darwin');
  assert.equal(mac.steps.length, 3);
  assert.match(mac.steps[0], /Mac.*Dock/);
  assert.match(mac.steps[0], /pocket-dev admin in Terminal/);
  assert.match(mac.steps[1], /Tap Update and confirm/);
  assert.match(mac.steps[2], /Wait a few seconds.*reconnects by itself/);
  assert.equal(mac.alternative, 'Or, in a terminal on the computer, run: pocket-dev update');
  assert.match(updateSteps('win32').steps[0], /Desktop or in the Start menu.*PowerShell/);
  assert.match(updateSteps('linux').steps[0], /app menu/);
  assert.match(updateSteps('freebsd').steps[0], /pocket-dev admin in a terminal/);
  assert.equal(updateSteps('darwin', 'pocket-dev update').alternative.endsWith('pocket-dev update'), true);
});

test('the operating system from the server is kept with the update info', async () => {
  const n = createNotice({ fetchUpdate: async () => ({ ...newer, os: 'win32' }) });
  await n.load();
  assert.equal(n.info().os, 'win32');
});
