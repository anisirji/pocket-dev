// Isolated browser integration: native session files -> real server -> the Chats UI.
// PLAYWRIGHT_MODULE and CHROME_PATH can select an existing local browser install.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-unified-browser-'));
const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };
const claudeDir = path.join(fixture, 'claude', 'projects');
const project = path.join(fixture, 'project');
const nativeDir = path.join(claudeDir, project.replace(/[^A-Za-z0-9]/g, '-'));
const codexDir = path.join(fixture, 'codex');
const copilotDir = path.join(fixture, 'copilot');
for (const dir of [project, nativeDir, path.join(codexDir, 'sessions'), copilotDir]) fs.mkdirSync(dir, { recursive: true });
const ids = Array.from({ length: 35 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const nativeFile = (id) => path.join(nativeDir, `${id}.jsonl`);
const stamp = new Date().toISOString();
const line = (value) => JSON.stringify(value) + '\n';
for (const [i, id] of ids.entries()) {
  fs.writeFileSync(nativeFile(id),
    line({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: project, timestamp: stamp, message: { role: 'user', content: `Laptop request ${i + 1}` } }) +
    line({ type: 'assistant', uuid: `a-${id}`, sessionId: id, cwd: project, timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: `Laptop answer ${i + 1}, preserve the complete conversation.` }] } }));
  const time = new Date(Date.now() - (i + 5) * 60000);
  fs.utimesSync(nativeFile(id), time, time);
}
const copilotId = '20000000-0000-4000-8000-000000000001';
fs.mkdirSync(path.join(copilotDir, copilotId));
fs.writeFileSync(path.join(copilotDir, copilotId, 'workspace.yaml'), `id: ${copilotId}\ncwd: ${project}\nname: Copilot laptop conversation\nupdated_at: ${stamp}\n`);
fs.writeFileSync(path.join(copilotDir, copilotId, 'events.jsonl'),
  line({ type: 'user.message', data: { content: 'Copilot laptop request' }, timestamp: stamp }) +
  line({ type: 'assistant.message', data: { content: 'Copilot laptop answer' }, timestamp: stamp }));

let browser;
try {
  const server = await startServer(t, { env: {
    POCKET_DEV_CLAUDE_DIR: claudeDir, POCKET_DEV_CODEX_DIR: codexDir,
    POCKET_DEV_COPILOT_DIR: copilotDir, POCKET_DEV_AGY_DIR: path.join(fixture, 'agy'),
    POCKET_DEV_CLAUDE: path.join(repo, 'test/helpers/fake-claude.mjs'),
    POCKET_DEV_COPILOT: path.join(repo, 'test/helpers/fake-copilot.mjs'),
  } });
  fs.writeFileSync(path.join(server.root, 'no-processes.json'), JSON.stringify({ processes: [] }));
  const login = await server.login();
  assert.equal(login.status, 200);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) });
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600 });
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const [name, value] = login.cookie.split('=');
    await context.addCookies([{ name, value, url: server.base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(server.base);
    await page.locator('[data-view="chat"]').click();
    await page.waitForSelector('.chat-computer-row');
    assert.equal(await page.locator('#resumeBtn').count(), 0, 'no separate Resume entry');
    assert.equal(await page.locator('.hist:not([hidden])').count(), 0, 'the history sheet stays closed');
    assert.equal(await page.locator('.chat-computer-row').count(), 30, 'first page has thirty computer conversations');
    await page.locator('.chat-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-computer-row').length >= 35);
    assert.equal(await page.locator('.chat-more').isVisible(), false, 'Show more disappears at the end');
    let failRefresh = true;
    await page.route('**/api/history/chats?**', async (route) => {
      if (failRefresh) {
        failRefresh = false;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture history scan failed' }) });
      }
      return route.continue();
    });
    await page.locator('.chat-refresh').click();
    await page.waitForSelector('.chat-open-error');
    await page.locator('.chat-open-error').getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-open-error').length === 0 && document.querySelectorAll('.chat-computer-row').length === 30);
    await page.locator('.chat-search').fill('Copilot laptop');
    await page.waitForFunction(() => document.querySelectorAll('.chat-computer-row').length === 1);
    assert.match(await page.locator('.chat-computer-row').innerText(), /Copilot laptop/);
    await page.locator('.chat-search').fill('no conversation matches this');
    await page.waitForFunction(() => document.querySelectorAll('.chat-row').length === 0);
    await page.locator('.chat-search').fill('Laptop request 1');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-computer-row .chat-row-title')].some((row) => row.textContent === 'Laptop request 1'));
    const row = page.locator('.chat-computer-row').filter({ has: page.locator('.chat-row-title', { hasText: /^Laptop request 1$/ }) });
    // Exercise busy handoff confirmation without signalling any process on this computer.
    let attempts = 0;
    let confirmedBusy = false;
    await page.route(`**/api/history/claude/${ids[0]}/open-chat`, async (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'busy', error: 'This conversation is writing a reply. Stop it and open here?' }) });
      confirmedBusy = route.request().postDataJSON()?.confirmBusy === true;
      return route.continue();
    });
    page.once('dialog', (dialog) => dialog.accept());
    await row.click();
    await page.waitForSelector('.chat-convo-screen:not([hidden]) .chat-input');
    await page.waitForFunction(() => document.querySelector('.chat-log')?.textContent.includes('Laptop answer 1, preserve the complete conversation.'));
    assert.equal(attempts, 2);
    assert.equal(confirmedBusy, true, 'busy continuation needs explicit confirmation');
    assert.match(await page.locator('.chat-log').innerText(), /Laptop request 1/);
    await page.locator('.chat-menu').click();
    assert.equal(await page.locator('.chat-continue-computer').isVisible(), true, 'computer continuation belongs to chat settings');
    await page.locator('.chat-continue-computer').click();
    await page.waitForSelector('.hist-mac-cmd');
    assert.match(await page.locator('.hist-mac-cmd').innerText(), new RegExp(`claude --resume ${ids[0]}`));
    await page.locator('.hist-mac').getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.chat-settings-wrap .chat-sheet-head button').click();
    await page.locator('.chat-back').click();
    await page.locator('.chat-search').fill('');
    await page.locator('.chat-refresh').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-row:not(.chat-computer-row)')].some((node) => node.textContent.includes('Laptop request 1')));
    assert.equal(await page.locator('.chat-computer-row .chat-row-title').filter({ hasText: /^Laptop request 1$/ }).count(), 0, 'imported native session has one row');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px document has no horizontal overflow`);
    assert.ok(await page.locator('.chat-list-screen').evaluate((node) => node.scrollWidth <= node.clientWidth), `${width}px Chats has no horizontal overflow`);
    assert.deepEqual(errors, []);
    await context.close();
    // Keep the desktop pass independent from the phone pass.
    const chats = await server.request('GET', '/api/chat', { cookie: login.cookie });
    for (const chat of chats.data) await server.request('DELETE', `/api/chat/${chat.id}`, { cookie: login.cookie });
  }
  console.log('PASS: real native files, phone and desktop list, search, pagination, failed scan retry, busy confirmation, imported history, dedupe, in-chat computer continuation, back navigation and no horizontal overflow.');
} finally {
  await browser?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
  fs.rmSync(fixture, { recursive: true, force: true });
}
