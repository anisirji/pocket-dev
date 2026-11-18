import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNotifier, createUpdateReminder, macCommand, windowsCommand, linuxCommand, REMIND_EVERY_MS,
} from '../src/machine/desktop-notify.js';

// Nothing here may show anything on a real screen: every notifier gets an injected `run` and an empty env.
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-notify-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const MESSAGE = 'Pocket Dev 1.3.0 is available. Open Pocket Dev Admin and tap Update.';

test('macOS shows a banner with display notification, never a dialog, and the text is an argument', () => {
  const nasty = 'He said "hi" \\ and `ls`';
  const { cmd, args } = macCommand({ title: 'Pocket Dev', message: nasty });
  assert.equal(cmd, 'osascript');
  const script = args.filter((_, i) => args[i - 1] === '-e').join('\n');
  assert.match(script, /display notification/);
  assert.doesNotMatch(script, /display dialog|display alert/);
  assert.doesNotMatch(script, /He said/, 'the text is not inside the script');
  assert.deepEqual(args.slice(-2), ['Pocket Dev', nasty]);
});

test('Windows uses the built-in toast API and passes the text through the environment', () => {
  const { cmd, args, env } = windowsCommand({ title: 'Pocket Dev', message: MESSAGE });
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
  const script = args.at(-1);
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.doesNotMatch(script, /BurntToast/);
  assert.doesNotMatch(script, /is available/, 'the text is not inside the script');
  assert.deepEqual(env, { PD_NOTIFY_TITLE: 'Pocket Dev', PD_NOTIFY_MESSAGE: MESSAGE });
});

test('Linux uses notify-send, and does nothing at all when it is not installed', async () => {
  assert.deepEqual(linuxCommand({ title: 'Pocket Dev', message: 'x' }).cmd, 'notify-send');
  const calls = [];
  const without = createNotifier({ platform: 'linux', env: {}, run: async (c) => { calls.push(c); return true; }, hasProgram: () => false });
  assert.equal(await without.notify({ message: 'x' }), false);
  assert.equal(calls.length, 0);
  const withIt = createNotifier({ platform: 'linux', env: {}, run: async (c) => { calls.push(c); return true; }, hasProgram: (n) => n === 'notify-send' });
  assert.equal(await withIt.notify({ message: 'x' }), true);
  assert.equal(calls[0].cmd, 'notify-send');
});

test('the notifier never throws and says false when the system refuses or the platform is unknown', async () => {
  assert.equal(await createNotifier({ platform: 'darwin', env: {}, run: async () => { throw new Error('boom'); } }).notify({ message: 'x' }), false);
  assert.equal(await createNotifier({ platform: 'darwin', env: {}, run: async () => false }).notify({ message: 'x' }), false);
  assert.equal(await createNotifier({ platform: 'freebsd', env: {}, run: async () => true }).notify({ message: 'x' }), false);
});

test('test seams: a record file captures the text, and the test and silence switches show nothing', async (t) => {
  const file = path.join(tmp(t), 'record');
  const run = async () => { assert.fail('a real notification would have been shown'); };
  await createNotifier({ platform: 'darwin', env: { POCKET_DEV_NOTIFY_RECORD: file }, run }).notify({ message: 'hello' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { title: 'Pocket Dev', message: 'hello' });
  assert.equal(await createNotifier({ platform: 'darwin', env: { POCKET_DEV_NO_DESKTOP_NOTIFY: '1' }, run }).notify({ message: 'x' }), false);
  assert.equal(await createNotifier({ platform: 'darwin', env: { NODE_TEST_CONTEXT: 'child-v8' }, run }).notify({ message: 'x' }), false);
});

// ---- The reminder -----------------------------------------------------------------------------------------------------

function reminder({ view = { available: true, latest: '1.3.0' }, env = {}, saved = {} } = {}) {
  const state = { view, clock: 0, sent: [] };
  const r = createUpdateReminder({
    versionCheck: { view: () => state.view },
    notifier: { notify: async (n) => { state.sent.push(n.message); return true; } },
    config: { read: () => saved }, env, now: () => state.clock,
  });
  return { r, state };
}

test('it speaks once when an update is pending, with the exact text', async () => {
  const { r, state } = reminder();
  assert.equal(await r.tick(), true);
  assert.deepEqual(state.sent, [MESSAGE]);
});

test('it does not speak twice for the same moment, and speaks again after six hours', async () => {
  const { r, state } = reminder();
  await r.tick(); await r.tick();
  assert.equal(state.sent.length, 1);
  state.clock += REMIND_EVERY_MS - 1; await r.tick();
  assert.equal(state.sent.length, 1);
  state.clock += 1; await r.tick();
  assert.equal(state.sent.length, 2);
});

test('it stops the moment the installed version is current, and speaks again if a newer one appears', async () => {
  const { r, state } = reminder();
  await r.tick();
  state.view = { available: false, latest: '1.3.0' };
  state.clock += 60_000;
  assert.equal(await r.tick(), false);
  state.view = null;
  assert.equal(await r.tick(), false);
  state.view = { available: true, latest: '1.4.0' };
  state.clock += 60_000;
  assert.equal(await r.tick(), true, 'a newer release is a new moment');
  assert.equal(state.sent.at(-1), 'Pocket Dev 1.4.0 is available. Open Pocket Dev Admin and tap Update.');
});

test('updateCheck off, the environment switch and updateNotify off each keep it silent', async () => {
  for (const options of [{ saved: { updateCheck: false } }, { env: { POCKET_DEV_NO_UPDATE_CHECK: '1' } }, { saved: { updateNotify: false } }]) {
    const { r, state } = reminder(options);
    assert.equal(await r.tick(), false);
    assert.equal(state.sent.length, 0);
  }
  const { r, state } = reminder({ saved: { updateNotify: true, updateCheck: true } });
  assert.equal(await r.tick(), true);
  assert.equal(state.sent.length, 1);
});
