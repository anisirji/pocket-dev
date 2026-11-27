// Native dialog help and browser Back in the existing Settings/Workspace shells.
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
let browser;
try {
  const server = await startServer(t, { env: { POCKET_DEV_CLAUDE: new URL('../helpers/fake-claude.mjs', import.meta.url).pathname } }), login = await server.login();
  const chat = await server.request('POST', '/api/chat', { cookie: login.cookie, body: { tool: 'claude', cwd: server.home, title: 'Help check' } });
  assert.equal(chat.status, 201);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } }); const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const page = await context.newPage(), errors = []; page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(server.base); await page.locator('#settingsBtn').click(); await page.locator('[data-category="tools"]').click();
    await page.getByRole('button', { name: 'Help with AI Tools', exact: true }).click();
    const guide = page.locator('dialog.pd-guide'); await guide.waitFor(); assert.match(await guide.innerText(), /Browser → Separate browser/);
    await page.goBack(); await guide.waitFor({ state: 'hidden' }); assert.equal(await page.locator('.st-sheet').isVisible(), true, 'Back preserves Settings');
    await page.getByRole('button', { name: 'Help with AI Tools', exact: true }).click(); await page.keyboard.press('Escape'); await guide.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.st-sheet').isVisible(), true);
    await page.goto(`${server.base}/#chat=${chat.data.id}`); await page.locator('.chat-menu').click();
    await page.getByRole('button', { name: 'Help with AI Chat', exact: true }).click();
    await guide.waitFor(); assert.match(await guide.innerText(), /Continue on computer/);
    assert.equal(await guide.getByRole('link', { name: 'Watch tutorial' }).count(), 0, 'no placeholder tutorial');
    await page.goBack(); await guide.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.chat-settings-sheet').isVisible(), true, 'Back preserves Chat settings');
    await page.goto(`${server.base}/workspace.html`); await page.locator('#workspaceSettings').click(); await page.getByRole('button', { name: 'Help with Workspace', exact: true }).click();
    await guide.waitFor(); assert.match(await guide.innerText(), /Conflicts keep your draft/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goBack(); await guide.waitFor({ state: 'hidden' }); assert.equal(new URL(page.url()).pathname, '/workspace.html');
    assert.deepEqual(errors, []); await context.close(); console.log(`PASS shared written guides, native dialogs, Escape and browser Back at ${width}px`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
