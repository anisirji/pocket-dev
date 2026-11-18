// Isolated browser check: a computer conversation that Claude Code in VS Code still has open, opened from Chats on a
// phone. Opening only reads along; sending a message takes it over with SIGINT. The process table is a fixture, so no
// real program is signalled. PLAYWRIGHT_MODULE and CHROME_PATH can select an existing local browser install.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-held-browser-'));
const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };
const claudeDir = path.join(fixture, 'claude', 'projects');
const project = path.join(fixture, 'project');
const id = '40000000-0000-4000-8000-000000000001';
const file = path.join(claudeDir, project.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.dirname(file), { recursive: true });
const line = (value) => JSON.stringify(value) + '\n';
fs.writeFileSync(file,
  line({ type: 'user', uuid: 'u1', sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Held laptop request' } }) +
  line({ type: 'assistant', uuid: 'a1', sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Held laptop answer.' }] } }));
const old = new Date(Date.now() - 10 * 60_000);
fs.utimesSync(file, old, old);
const exe = '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude';
const vscode = { pid: 424242, ppid: 1, uid: process.getuid(), stat: 'S', started: 1000, exe, args: `${exe} --output-format stream-json --input-format stream-json --resume=${id}` };

let browser;
try {
  const server = await startServer(t, { env: {
    POCKET_DEV_CLAUDE_DIR: claudeDir, POCKET_DEV_CODEX_DIR: path.join(fixture, 'codex'),
    POCKET_DEV_COPILOT_DIR: path.join(fixture, 'copilot'), POCKET_DEV_AGY_DIR: path.join(fixture, 'agy'),
    POCKET_DEV_CLAUDE: path.join(repo, 'test/helpers/fake-claude.mjs'),
  } });
  const table = path.join(server.root, 'no-processes.json');
  fs.writeFileSync(table, JSON.stringify({ processes: [vscode] }));
  const signals = () => JSON.parse(fs.readFileSync(table, 'utf8')).signals ?? [];
  const login = await server.login();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const [name, value] = login.cookie.split('=');
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(server.base);
  await page.locator('[data-view="chat"]').click();
  await page.locator('.chat-computer-row', { hasText: 'Held laptop request' }).click();
  await page.waitForFunction(() => document.querySelector('.chat-log')?.textContent.includes('Held laptop answer.'));
  const status = page.locator('.chat-statusline');
  await page.waitForFunction(() => document.querySelector('.chat-statusline .chat-status-text')?.textContent.startsWith('Open in Claude Code in VS Code'));
  assert.equal(await status.innerText(), 'Open in Claude Code in VS Code on your computer. You can read along here. Sending a message continues it here and closes it there.');
  assert.equal(await page.locator('.chat-statusline .chat-spin').count(), 0, 'no spinner while the computer program is idle');
  assert.equal(await page.locator('.chat-status-stop').isVisible(), false, 'no Stop while the computer program is idle');
  await page.waitForTimeout(4000);
  assert.deepEqual(signals(), [], 'opening and reading along signal nothing');
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'held-idle.png') });

  await page.locator('.chat-input').fill('Carry on from the phone');
  assert.equal(await page.locator('.chat-send').innerText(), 'Send');
  await page.locator('.chat-send').click();
  await page.waitForFunction(() => document.querySelector('.chat-log')?.textContent.includes('That is normal, nothing is lost.'));
  assert.deepEqual(signals(), [{ pid: vscode.pid, signal: 'SIGINT' }], 'sending takes over, SIGINT first');
  assert.match(await page.locator('.chat-log').innerText(), /Continued here\. Claude Code in VS Code on your Mac was closed, so its window may say the session ended\./);
  await page.waitForFunction(() => document.querySelector('.chat-log')?.textContent.includes('Carry on from the phone'));
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'held-taken-over.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: a held computer conversation opens without a signal, reads as idle with Send and no Stop, and a sent message takes it over with SIGINT and a note on what to expect.');
} finally {
  await browser?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
  fs.rmSync(fixture, { recursive: true, force: true });
}
