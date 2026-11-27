// Real page reloads against an isolated server. No owner data, real app actions or camera starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [];
let browser;
try {
  const server = await startServer({ after: (fn) => cleanups.unshift(fn) });
  const project = path.join(fs.realpathSync(server.home), 'Refresh project');
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, 'child'));
  fs.writeFileSync(path.join(project, 'child', 'example.txt'), 'Refresh keeps the current folder.');
  const login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const [name, value] = login.cookie.split('=');
    await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => { if (request.method() !== 'GET' && /\/api\/(apps\/|connections\/(invite|join)|camera\/(start|session)|settings\/(password|qr-key))/.test(request.url())) writes.push(request.url()); });
    let apps = [{ pid: 1000, name: 'Refresh Fixture', bundleId: 'test.refresh.fixture', cpu: 1, memMB: 32, windows: 1 }];
    await page.route('**/api/apps', (route) => route.fulfill({ json: { apps } }));
    await page.route('**/api/apps/1000/windows', (route) => route.fulfill({ json: { windows: [] } }));
    await page.goto(server.base); await page.evaluate(() => window.pocketDev.navigation.ready);
    const sheet = page.locator('.st-sheet'), title = sheet.locator('.st-head h2');
    const settings = async (category) => {
      if (await sheet.isVisible()) await sheet.locator('.st-close').click();
      await page.locator('#settingsBtn').click();
      await sheet.locator(`[data-category="${category}"]`).click();
      await page.evaluate(() => window.pocketDev.overlays.settled());
    };
    const reload = async () => {
      await page.evaluate(() => window.pocketDev.overlays.settled());
      await page.reload();
      await page.evaluate(() => window.pocketDev.navigation.ready);
    };
    for (const category of ['connection', 'tools', 'security', 'service', 'computers', 'controls']) {
      await settings(category);
      let scroll;
      if (category === 'security') {
        await sheet.locator('.st-summary').filter({ hasText: 'logged in' }).waitFor();
        scroll = await sheet.locator('.st-body').evaluate((node) => { node.scrollTop = 200; return node.scrollTop; });
        assert.ok(scroll > 0);
      }
      await reload();
      assert.equal(await sheet.isVisible(), true);
      assert.equal(await sheet.getAttribute('data-page'), category);
      if (scroll !== undefined) await until(async () => Math.abs(await sheet.locator('.st-body').evaluate((node) => node.scrollTop) - scroll) < 2);
    }
    await settings('tools');
    await sheet.locator('.sx-provider').filter({ hasText: 'Codex' }).click();
    const historyLength = await page.evaluate(() => history.length);
    for (let run = 0; run < 2; run++) {
      await reload(); assert.equal(await title.innerText(), 'Codex');
      assert.equal(await page.evaluate(() => history.length), historyLength, 'reload does not duplicate history entries');
    }
    await page.goBack(); await sheet.locator('.sx-provider').first().waitFor();
    await page.goBack(); await sheet.locator('.st-nav').waitFor();
    await page.goBack(); await sheet.waitFor({ state: 'hidden' });
    await reload(); assert.equal(await sheet.isVisible(), false, 'closed Settings stays closed');

    await settings('computers'); await sheet.locator('.cc-computer').first().click();
    const computerName = await title.innerText();
    await reload(); assert.equal(await title.innerText(), computerName);
    await page.goBack(); await sheet.getByRole('button', { name: 'Connect another computer', exact: true }).click();
    await sheet.getByRole('radio', { name: /Someone else/ }).check();
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
    await sheet.getByLabel('Connection code', { exact: true }).fill('private code');
    await reload(); await sheet.getByLabel('Connection code', { exact: true }).waitFor();
    assert.equal(await sheet.getByLabel('Connection code', { exact: true }).inputValue(), '');
    await page.goBack(); assert.equal(await sheet.getByRole('radio', { name: /Someone else/ }).isChecked(), true);

    await settings('controls'); await sheet.locator('[data-act="apps"]').click();
    await sheet.locator('.apps-card').filter({ hasText: 'Refresh Fixture' }).click();
    await sheet.getByRole('button', { name: 'Force quit', exact: true }).click();
    await page.locator('dialog.st-confirm').waitFor();
    await reload(); assert.equal(await title.innerText(), 'Refresh Fixture');
    assert.equal(await page.locator('dialog.st-confirm').count(), 0, 'confirmation is not replayed');
    apps = []; await reload(); assert.equal(await title.innerText(), 'Apps', 'missing app falls back to the list');
    apps = [{ pid: 1000, name: 'Refresh Fixture', bundleId: 'test.refresh.fixture', cpu: 1, memMB: 32, windows: 1 }];
    await settings('controls'); await sheet.locator('[data-act="health"]').click();
    await sheet.locator('.health-group').first().waitFor(); await reload();
    await sheet.locator('.health-group').first().waitFor();
    await settings('controls'); await sheet.locator('[data-act="camera"]').click();
    await sheet.locator('.camera-controls').waitFor(); await reload(); await sheet.locator('.camera-controls').waitFor();
    await settings('security'); await sheet.locator('input[name="current"]').fill('private password');
    await reload(); assert.equal(await sheet.locator('input[name="current"]').inputValue(), '');
    assert.equal(writes.length, 0, 'reload never performs a settings mutation, force quit, invitation or camera start');
    await sheet.locator('.st-close').click(); await page.evaluate(() => window.pocketDev.overlays.settled());

    await page.evaluate((root) => window.openFiles(root), project);
    await page.evaluate((folder) => window.openFiles(folder), path.join(project, 'child'));
    await reload(); assert.match(await page.locator('.fx-crumbs').innerText(), /child/);
    await page.locator('.fx-row').filter({ hasText: 'example.txt' }).click();
    await page.locator('.fx-pbody').waitFor(); await reload();
    assert.equal(await page.locator('.fx-ptitle').innerText(), 'example.txt');
    await page.goBack(); await page.locator('.fx-sheet').waitFor({ state: 'detached' });
    await page.goBack(); await until(async () => !(await page.locator('.fx-crumbs').innerText()).includes('child'));
    await page.goBack(); await page.locator('.fx').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.pocketDevMessages.open('everyone'));
    await reload(); await page.locator('.mx-convo-pane .mx-title').filter({ hasText: 'Everyone' }).waitFor();
    await page.evaluate(() => window.pocketDev.overlays.close('messages'));
    await reload(); assert.equal(await page.locator('.mx-convo-pane').isVisible(), false);
    await page.evaluate(() => window.pocketDevChat.open()); await page.locator('.chat-list-screen').waitFor();
    await page.evaluate(() => window.pocketDevSettings.open('security'));
    await reload(); assert.equal(await sheet.getAttribute('data-page'), 'security');
    await sheet.locator('.st-close').click(); await page.locator('.chat-list-screen').waitFor();
    await reload(); await page.locator('.chat-list-screen').waitFor();
    await page.evaluate(() => window.pocketDev.overlays.closeAll());
    await page.evaluate(() => window.pocketDev.overlays.settled());
    await settings('security'); await page.evaluate(() => window.clearPocketWorkspaceData());
    await reload(); assert.equal(await sheet.isVisible(), false, 'clearing login data also clears navigation restoration');
    await settings('security');
    await page.evaluate(() => history.replaceState(history.state, '', '#chat'));
    await reload(); await page.locator('.chat-list-screen').waitFor();
    assert.equal(await sheet.isVisible(), false, 'explicit chat links take precedence over the saved Settings page');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS refresh restores Settings categories/details, Files and Messages; stable Back history and no action replay at ${width}px`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups) await cleanup(); }
