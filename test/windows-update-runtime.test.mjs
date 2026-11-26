import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { windowsUpdateScript, startWindowsUpdate, takeWindowsUpdateResult, waitForWindowsUpdate } from '../src/setup/windows-update.js';

function fixture(t, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-update test's-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'package space', '@anisirji', 'pocket-dev');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: 'test-to' }));
  const npm = path.join(dir, 'fake npm.cmd');
  fs.writeFileSync(npm, `@echo off\r\necho installer fixture\r\nexit /b ${exitCode}\r\n`);
  return { node: process.execPath, npm, root, stateDir: dir, from: 'test-from' };
}
function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('Windows PowerShell installs with quoted paths and reports the real exit code', { skip: process.platform !== 'win32', timeout: 120000 }, async (t) => {
  for (const exitCode of [0, 7]) {
    const options = fixture(t, exitCode);
    const script = path.join(options.stateDir, 'update.ps1');
    fs.writeFileSync(script, '\uFEFF' + windowsUpdateScript(options));
    const result = await powershell(script);
    assert.equal(result.code, 0, result.output);
    const saved = takeWindowsUpdateResult(options.stateDir);
    assert.equal(saved.code, exitCode, result.output);
    assert.equal(saved.ok, exitCode === 0);
    assert.equal(saved.to, 'test-to');
    const log = fs.readFileSync(path.join(options.stateDir, 'update-windows.log'), 'utf8');
    assert.equal((log.match(/attempt \d/g) || []).length, exitCode === 0 ? 1 : 3);
    assert.equal(takeWindowsUpdateResult(options.stateDir), null);
  }
});

test('Windows starts the external updater and receives its result through the actual handoff', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const options = fixture(t);
  const started = await startWindowsUpdate(options);
  assert.equal(started.ok, true, started.error);
  const result = await waitForWindowsUpdate(options.stateDir, { timeoutMs: 45000, everyMs: 200 });
  assert.ok(result, 'the detached Windows helper finishes');
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.to, 'test-to');
});
