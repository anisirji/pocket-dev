// Native dialog help and browser Back in the existing Settings/Workspace shells.
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
let browser;
try {
  const server = await startServer(t), login = await server.login();
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
    await page.goto(`${server.base}/workspace.html`); await page.locator('#workspaceSettings').click(); await page.getByRole('button', { name: 'Help with Workspace', exact: true }).click();
    await guide.waitFor(); assert.match(await guide.innerText(), /Conflicts keep your draft/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goBack(); await guide.waitFor({ state: 'hidden' }); assert.equal(new URL(page.url()).pathname, '/workspace.html');
    assert.deepEqual(errors, []); await context.close(); console.log(`PASS shared written guides, native dialogs, Escape and browser Back at ${width}px`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
