import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  windowsUpdateScript, windowsUpdateOptions, startWindowsUpdate, takeWindowsUpdateResult, waitForWindowsUpdate, RESULT_FILE, SCRIPT_FILE,
} from '../src/setup/windows-update.js';
import { createUpdateRunner } from '../src/setup/update-runner.js';
import { createVersionCheck, createUpdater, runInstall } from '../src/setup/update.js';

// Windows refuses to rename the package folder while Pocket Dev runs from it (npm error EBUSY ... rename), so an update
// there must stop Pocket Dev from outside it, install, and start it again.

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-winupd-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail('timed out'); };
const ROOT = "C:\\Users\\O'Neil\\AppData\\Roaming\\npm\\node_modules\\@anisirji\\pocket-dev";
const BASE = { node: 'C:\\Program Files\\nodejs\\node.exe', npm: 'C:\\Program Files\\nodejs\\npm.cmd', root: ROOT, stateDir: 'C:\\Users\\O\'Neil\\.pocket-dev', from: '2.1.3' };

test('the script stops everything running from the package folder before npm runs, then starts the task again', () => {
  const s = windowsUpdateScript({ ...BASE, task: 'dev.pocket.server', runTask: true, keep: [41, 42] });
  const order = ['schtasks /End /TN \'dev.pocket.server\'', 'Stop-Process', 'install -g @anisirji/pocket-dev@latest', 'update-result.json', 'schtasks /Run /TN \'dev.pocket.server\''].map((x) => s.indexOf(x));
  for (const i of order) assert.ok(i > -1, s);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'stop, then install, then record, then start');
  assert.match(s, /\$root = 'C:\\Users\\O''Neil\\AppData/, 'a quote in the path is doubled for PowerShell');
  assert.match(s, /\$keep = @\(0, 41, 42\)/);
  assert.match(s, /\$keep -notcontains \$_\.ProcessId/);
  assert.match(s, /Set-Location -LiteralPath 'C:\\Users\\O''Neil\\.pocket-dev'/, 'the script itself never works inside the package folder');
  assert.doesNotMatch(s, /'start', '--no-open'/, 'the task starts it, not a new window');
});

test('a copy started in a terminal is started again in a new window; with no task nothing is ended or run', () => {
  const s = windowsUpdateScript({ ...BASE, startHere: true });
  assert.doesNotMatch(s, /schtasks/);
  assert.doesNotMatch(s, /service-run\.ps1/, 'a standalone or test install does not stop an unrelated service runner');
  assert.match(s, /Start-Process -FilePath 'C:\\Program Files\\nodejs\\node\.exe' -ArgumentList @\('C:\\Users\\O''Neil\\AppData\\Roaming\\npm\\node_modules\\@anisirji\\pocket-dev\\bin\\pocket-dev\.js', 'start', '--no-open'\)/);
});

test('the options end an installed task, start it again only when it was running, and keep the connection settings', () => {
  const env = { PORT: '7777', POCKET_DEV_ADMIN_PORT: '7778', HOME: 'x', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' };
  const service = windowsUpdateOptions({ from: '1', npm: 'npm', service: { installed: true, running: true, isThisServer: true }, startHere: false, env });
  assert.equal(service.runTask, true);
  assert.equal(service.startHere, false);
  assert.ok(service.task);
  assert.deepEqual(service.env, { POCKET_DEV_ADMIN_PORT: '7778', PORT: '7777', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' });
  const stopped = windowsUpdateOptions({ from: '1', npm: 'npm', service: { installed: true, running: false }, startHere: true, env });
  assert.equal(stopped.runTask, false);
  assert.equal(stopped.startHere, true);
  const none = windowsUpdateOptions({ from: '1', npm: 'npm', service: { installed: false }, startHere: true, env });
  assert.equal(none.task, null);
  assert.equal(windowsUpdateOptions({ from: '1', npm: 'npm', service: { installed: true, running: true }, startHere: true, env }).startHere, false, 'the task already starts it');
});

test('the helper starts through WMI, outside Pocket Dev, and falls back to a detached start', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, RESULT_FILE), '{}');
  const calls = [];
  const ok = await startWindowsUpdate({ ...BASE, stateDir: dir }, { run: async (args, o) => { calls.push({ args, o }); return { code: 0 }; } });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-2), '-EncodedCommand');
  assert.match(Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le'), /Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @\{ CommandLine = 'powershell\.exe .*-File "[^"]+update-windows\.ps1"'/);
  assert.equal(fs.existsSync(path.join(dir, RESULT_FILE)), false, 'an old result is cleared first');
  const script = fs.readFileSync(path.join(dir, SCRIPT_FILE), 'utf8');
  assert.equal(script.charCodeAt(0), 0xfeff, 'PowerShell 5.1 needs the byte order mark');

  const fallback = [];
  assert.deepEqual(await startWindowsUpdate({ ...BASE, stateDir: dir }, { run: async (args, o) => { fallback.push(o.wait); return { code: o.wait ? 5 : 0 }; } }), { ok: true });
  assert.deepEqual(fallback, [true, false]);
  const failed = await startWindowsUpdate({ ...BASE, stateDir: dir }, { run: async () => ({ code: null, error: 'no powershell' }) });
  assert.deepEqual(failed, { ok: false, error: 'no powershell' });
});

test('the result is read once, with PowerShell\'s byte order mark, and an old one is ignored', (t) => {
  const dir = tmp(t);
  const at = Date.now();
  fs.writeFileSync(path.join(dir, RESULT_FILE), `\uFEFF${JSON.stringify({ ok: false, code: -4082, from: '2.1.3', to: '2.1.3', output: 'npm error code EBUSY', at })}`);
  assert.deepEqual(takeWindowsUpdateResult(dir), { ok: false, code: -4082, from: '2.1.3', to: '2.1.3', output: ['npm error code EBUSY'] });
  assert.equal(takeWindowsUpdateResult(dir), null, 'read once');
  fs.writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ ok: true, at: at - 60 * 60_000 }));
  assert.equal(takeWindowsUpdateResult(dir), null);
});

test('the command waits for the result and gives up after its time limit', async () => {
  let n = 0;
  assert.deepEqual(await waitForWindowsUpdate('x', { everyMs: 1, take: () => (++n === 3 ? { ok: true } : null) }), { ok: true });
  assert.equal(await waitForWindowsUpdate('x', { everyMs: 1, timeoutMs: 5, take: () => null }), null);
});

function windowsRunner(t, { handOff, last = null } = {}) {
  const check = createVersionCheck({ version: '2.1.3', stateDir: tmp(t), lookup: async () => '2.1.4' });
  const handed = [];
  const r = createUpdateRunner({
    versionCheck: check, kind: 'global', version: '2.1.3', readVersion: () => '2.1.3', platform: 'win32',
    run: async () => assert.fail('npm must not run inside Pocket Dev on Windows'),
    serviceInfo: async () => ({ installed: true, running: true, isThisServer: true }),
    handOff: async (o) => { handed.push(o); return handOff ? handOff(o) : { ok: true }; },
    takeResult: () => last,
  });
  return { r, check, handed };
}

test('on Windows the Admin Update hands the install to the script and waits for the restart', async (t) => {
  const { r, check, handed } = windowsRunner(t);
  await check.refresh();
  assert.equal(r.view().windows, true);
  assert.equal((await r.start()).status, 202);
  await until(() => r.phase() === 'restarting');
  assert.deepEqual(handed, [{ from: '2.1.3', service: { installed: true, running: true, isThisServer: true } }]);
  assert.match(r.view().message, /stops, installs 2\.1\.4 and starts again/);
});

test('on Windows a helper that cannot start is reported, and npm\'s failure is shown after the restart', async (t) => {
  const { r, check } = windowsRunner(t, { handOff: () => ({ ok: false, error: 'Windows did not start the update helper.' }) });
  await check.refresh();
  await r.start();
  await until(() => r.phase() === 'failed');
  assert.match(r.view().error, /did not start: Windows did not start the update helper/);

  const after = windowsRunner(t, { last: { ok: false, code: -4082, output: ['npm error code EBUSY'] } }).r;
  assert.equal(after.phase(), 'failed');
  assert.deepEqual(after.view().output, ['npm error code EBUSY']);
  assert.match(after.view().error, /npm exited with code -4082/);
});

test('pocket-dev update on Windows reports the script\'s result instead of running npm itself', async () => {
  const lines = [];
  const make = (result) => createUpdater({
    version: '2.1.3', run: async () => assert.fail('npm must not run here'), handOff: async () => result,
    hasService: async () => true, restartService: async () => assert.fail('the script already started it'),
  });
  assert.equal(await runInstall({ out: (l) => lines.push(l), update: make({ ok: true, code: 0, output: ['added 1 package'], to: '2.1.4' }) }), 0);
  assert.ok(lines.includes('Updated Pocket Dev 2.1.3 to 2.1.4.'), lines.join('\n'));
  assert.ok(lines.includes('Pocket Dev was stopped for the install and started again.'));
  lines.length = 0;
  assert.equal(await runInstall({ out: (l) => lines.push(l), update: make({ ok: false, code: -4082, output: ['npm error code EBUSY'] }) }), 1);
  assert.match(lines.join('\n'), /npm error code EBUSY[\s\S]*npm exited with code -4082/);
  lines.length = 0;
  assert.equal(await runInstall({ out: (l) => lines.push(l), update: make(null) }), 1);
  assert.match(lines.join('\n'), /did not finish within 10 minutes/);
});
