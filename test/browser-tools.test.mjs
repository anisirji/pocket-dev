import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserExecutable, browserAutomationStatus, browserMcpConfig, BROWSER_TOOLS } from '../src/chat/browser-tools.js';
import { remoteCodexThread } from '../src/chat/remote-codex.js';

test('browser detection covers installed Windows Edge, Mac Chrome and Linux Chromium', () => {
  const win = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(browserExecutable({ platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: (file) => file === win }), win);
  assert.match(browserExecutable({ platform: 'darwin', env: {}, exists: (file) => file.includes('Google Chrome') }), /Google Chrome$/);
  assert.equal(browserExecutable({ platform: 'linux', env: {}, find: (name) => name === 'chromium' ? '/usr/bin/chromium' : null, exists: () => true }), '/usr/bin/chromium');
  assert.equal(browserExecutable({ env: { POCKET_DEV_BROWSER_EXECUTABLE: '/missing' }, exists: () => false }), null);
});
test('optional browser dependencies and missing browsers yield setup guidance', () => {
  assert.equal(browserAutomationStatus({ resolvePackage() { throw new Error('not installed'); }, exists: () => false, executable: null }).state, 'setup-required');
  assert.equal(browserAutomationStatus({ resolvePackage: () => '/package/package.json', exists: () => true, executable: null }).available, false);
  assert.equal(browserAutomationStatus({ resolvePackage: () => '/package/package.json', exists: () => true, executable: '/browser' }).state, 'ready');
});
test('personal browser tools are isolated, bounded, shell-free and exclude unsafe host execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-browser-config-')), executable = path.join(root, 'browser'); fs.writeFileSync(executable, 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let config;
  try { config = browserMcpConfig({ cwd: root, imageDir: path.join(root, 'images') }, { executable, headless: true }); }
  catch (error) { if (error.code === 'SETUP_REQUIRED') return t.skip('optional Playwright MCP is not installed'); throw error; }
  assert.equal(config.command, process.execPath); assert.equal(config.cwd, root);
  assert.ok(config.args.includes('--isolated')); assert.ok(config.args.includes('--headless')); assert.ok(config.args.includes('60000'));
  for (const flag of ['--extension', '--storage-state', '--user-data-dir', '--save-session', '--allow-unrestricted-file-access']) assert.equal(config.args.includes(flag), false, flag);
  assert.ok(config.enabled_tools.includes('browser_click')); assert.equal(config.enabled_tools.includes('browser_run_code_unsafe'), false);
  assert.deepEqual(config.env_vars, []);
});
test('shared Codex never inherits browser tools, even if a consumer asks for them', () => {
  const thread = remoteCodexThread('/workspace', { mcp_servers: { pocket_dev_browser: { command: 'node', args: ['browser'] } } }, { model: 'default', browser: 'isolated' });
  assert.equal(thread.config.features.browser_use, false); assert.deepEqual(thread.config.mcp_servers.pocket_dev_browser, { enabled: false });
  for (const tool of thread.dynamicTools) assert.equal(BROWSER_TOOLS.includes(tool.name), false);
  assert.deepEqual(thread.environments, []);
});
