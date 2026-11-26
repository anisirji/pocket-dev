// Phone and desktop check of unified Settings, pairing and shared-provider selection.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, pause } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
const fake = new URL('../helpers/fake-claude.mjs', import.meta.url).pathname;
let browser;
try {
  const a = await startServer(t, { env: { POCKET_DEV_CLAUDE: fake, POCKET_DEV_ROOM_PING_MS: '200' } });
  const b = await startServer(t, { env: { POCKET_DEV_CLAUDE: fake, POCKET_DEV_ROOM_PING_MS: '200' } });
  const logins = await Promise.all([a.login(), b.login()]);
  const call = (s, method, url, body) => s.request(method, url, { cookie: logins[s === a ? 0 : 1].cookie, body });
  const aId = (await call(a, 'GET', '/api/room')).data.deviceId, bId = (await call(b, 'GET', '/api/room')).data.deviceId;
  const invite = (await call(a, 'POST', '/api/connections/invite', { connectionType: 'external' })).data;
  await call(b, 'POST', '/api/connections/join', { host: a.base, code: invite.code, name: 'Workspace laptop', addresses: [b.base] });
  await call(a, 'PATCH', `/api/connections/${bId}`, { ai: ['claude'] });
  await call(a, 'PATCH', '/api/connections/providers/claude', { enabled: true });
  const chat = (await call(b, 'POST', '/api/chat', { tool: `claude@${aId}`, cwd: b.home })).data;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const [name, value] = logins[1].cookie.split('='); await context.addCookies([{ name, value, url: b.base }]);
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (err) => { errors.push(String(err)); console.error('PAGEERROR', String(err)); });
    await page.goto(b.base);
    await pause(800);
    for (let i = 0; i < 10; i++) {
      const next = page.getByRole('button', { name: /^(Next|Done|Got it|Finish|Start|Skip)/i });
      if (!await next.count()) break;
      await next.first().click({ timeout: 1000 }).catch(() => {}); await pause(100);
    }
    await page.locator('#settingsBtn').click();
    await page.getByRole('button', { name: /Security & Devices/ }).click();
    assert.ok(await page.locator('.st-form').isVisible());
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await page.getByRole('button', { name: /Connected computers/ }).click();
    await page.locator('.cc-computer').first().waitFor();
    assert.equal(await page.locator('.cc-computer').count(), 2);
    await page.getByRole('button', { name: 'Others', exact: true }).click();
    assert.equal(await page.locator('.cc-computer').count(), 1);
    await page.locator('.cc-computer').first().click();
    assert.ok((await page.locator('.cc').innerText()).includes('Computer access is not shared.'));
    assert.equal(await page.getByRole('button', { name: 'Open computer', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('.cc').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.evaluate((id) => { location.hash = `chat=${id}`; }, chat.id);
    await page.locator('.chat-provider-chip').waitFor({ timeout: 10000 });
    assert.ok((await page.locator('.chat-provider-chip').innerText()).includes('via'));
    await page.locator('.chat-provider-chip').click();
    assert.equal(await page.locator('.chat-switch-item').count(), 5);
    await page.screenshot({ path: `/tmp/pocket-dev-connections-${width}.png` });
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await context.close();
    console.log(`PASS settings, AI-only details, provider sources and responsive layout at ${width}px`);
  }
} finally {
  await browser?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
