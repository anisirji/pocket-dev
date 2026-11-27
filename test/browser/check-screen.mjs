// Screen UI with fixture images only: no desktop capture, permissions prompt or native input.
import assert from 'node:assert/strict';
import { startServer, until, pause } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
let browser;
try {
  const server = await startServer(t), login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(String(error))); await page.goto(server.base);
  const picture = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#173353'; ctx.fillRect(0, 0, 320, 200); return canvas.toDataURL('image/jpeg').split(',')[1]; }), 'base64');
  await page.route('**/api/screen/support', (route) => route.fulfill({ json: { state: 'ready', available: true, displays: [{ index: 1, name: 'Fixture main display' }, { index: 2, name: 'Fixture second display' }], monitorSelection: true } }));
  await page.route('**/api/screen?**', (route) => { requests.push(new URL(route.request().url())); return route.fulfill({ body: picture, contentType: 'image/jpeg' }); });
  await page.locator('#settingsBtn').click(); await page.locator('[data-category="controls"]').click(); await page.locator('[data-act="screen"]').click();
  const screen = page.locator('.screen-sheet'); await page.waitForFunction(() => document.querySelector('.screen-img').naturalWidth === 320);
  assert.equal(requests[0].searchParams.get('quality'), 'balanced');
  await screen.getByRole('button', { name: 'Screen options', exact: true }).click();
  await screen.getByLabel('Display', { exact: true }).selectOption('2');
  await until(() => requests.some((request) => request.searchParams.get('display') === '2'));
  await screen.getByLabel('Screen quality', { exact: true }).selectOption('high');
  await until(() => requests.some((request) => request.searchParams.get('quality') === 'high'));
  await page.keyboard.press('Escape');
  assert.equal(await screen.isVisible(), true, 'Escape closes the options menu before leaving the viewer');
  const [download] = await Promise.all([page.waitForEvent('download'), screen.getByRole('button', { name: 'Snapshot', exact: true }).click()]); assert.match(download.suggestedFilename(), /^pocket-screen-.*\.jpg$/);
  await screen.getByRole('button', { name: 'Auto: on', exact: true }).click(); const paused = requests.length; await pause(3200); assert.equal(requests.length, paused);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.st-back').click();
  assert.equal(await screen.isVisible(), false); await pause(3200); assert.equal(requests.length, paused, 'leaving the viewer stops capture');
  assert.equal(await screen.locator('img').getAttribute('src'), null, 'preview is released');
  assert.deepEqual(errors, []);
  console.log('PASS screen monitor/quality selection, snapshot download, manual refresh mode, phone layout and cleanup');
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
