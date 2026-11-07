import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// checkPermissions reads its tool paths when the module loads, so each scenario runs in its own process with stub tools.
// `wait` is how long a check waits for the tool. It is generous unless the scenario is the timeout itself, because
// the suite runs files in parallel and a slow start must not read as an unanswered prompt.
function check(t, { osascript, firewall, wait = 15_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-perm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return file;
  };
  const env = {
    ...process.env, HOME: dir, POCKET_DEV_PERMISSION_WAIT_MS: String(wait),
    POCKET_DEV_OSASCRIPT: stub('osascript', osascript),
    POCKET_DEV_FIREWALL: stub('firewall', firewall),
  };
  const script = `const { checkPermissions } = await import(${JSON.stringify(path.join(REPO, 'permissions.js'))});
    console.log(JSON.stringify(await checkPermissions()));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(JSON.parse(result.stdout).map((item) => [item.id, item]));
}

const FIREWALL_OFF = 'echo "Firewall is disabled. (State = 0)"';
const FIREWALL_ON = (app) => `case "$1" in --getglobalstate) echo "Firewall is enabled. (State = 1)";; *) echo "${app}";; esac`;

test('everything allowed: Automation and Accessibility granted, firewall off is not needed', (t) => {
  const p = check(t, { osascript: 'echo ok', firewall: FIREWALL_OFF });
  assert.equal(p.automation.state, 'granted');
  assert.equal(p.accessibility.state, 'granted');
  assert.equal(p.firewall.state, 'not-needed');
});

test('Automation denied: names the settings page, and Accessibility cannot be told yet', (t) => {
  const p = check(t, { osascript: 'echo "execution error: Not authorized to send Apple events to System Events. (-1743)" >&2; exit 1', firewall: FIREWALL_OFF });
  assert.equal(p.automation.state, 'missing');
  assert.equal(p.automation.pane, 'Privacy_Automation');
  assert.match(p.automation.fix, /Automation/);
  assert.equal(p.accessibility.state, 'unknown');
});

test('Accessibility denied while Automation is allowed', (t) => {
  const p = check(t, { osascript: 'echo "osascript is not allowed assistive access. (-25211)" >&2; exit 1', firewall: FIREWALL_OFF });
  assert.equal(p.automation.state, 'granted');
  assert.equal(p.accessibility.state, 'missing');
  assert.equal(p.accessibility.pane, 'Privacy_Accessibility');
});

test('an unanswered macOS prompt reads as waiting, not as denied', (t) => {
  const p = check(t, { osascript: 'sleep 30', firewall: FIREWALL_OFF, wait: 600 });
  assert.equal(p.automation.state, 'waiting');
  assert.match(p.automation.detail, /Click Allow/);
});

test('firewall on: permitted is granted; blocked or unlisted is missing', (t) => {
  assert.equal(check(t, { osascript: 'echo ok', firewall: FIREWALL_ON('Incoming connections to this application are permitted') }).firewall.state, 'granted');
  const blocked = check(t, { osascript: 'echo ok', firewall: FIREWALL_ON('Incoming connections to this application are blocked') }).firewall;
  assert.equal(blocked.state, 'missing');
  assert.equal(blocked.pane, 'Firewall');
  assert.equal(check(t, { osascript: 'echo ok', firewall: FIREWALL_ON('The application is not part of the firewall') }).firewall.state, 'missing');
});

test('Full Disk Access reads as missing when a protected folder cannot be listed', (t) => {
  const p = check(t, { osascript: 'echo ok', firewall: FIREWALL_OFF });
  // The stub HOME has no Library folders, so there is nothing to test with.
  assert.equal(p.fullDisk.state, 'unknown');
});

const WINDOWS = (json) => `case "$*" in *CGWindowList*) echo '${json}';; *) echo ok;; esac`;

test('Screen Recording: titled windows mean granted, untitled mean missing, none means unknown', (t) => {
  assert.equal(check(t, { osascript: WINDOWS('{"windows":3,"titled":2}'), firewall: FIREWALL_OFF }).screenRecording.state, 'granted');
  const missing = check(t, { osascript: WINDOWS('{"windows":3,"titled":0}'), firewall: FIREWALL_OFF }).screenRecording;
  assert.equal(missing.state, 'missing');
  assert.equal(missing.pane, 'Privacy_ScreenCapture');
  assert.equal(check(t, { osascript: WINDOWS('{"windows":0,"titled":0}'), firewall: FIREWALL_OFF }).screenRecording.state, 'unknown');
});
