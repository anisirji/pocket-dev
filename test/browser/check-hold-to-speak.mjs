// Real insecure LAN origin, authenticated secure handoff, and camera-page restoration. No physical media capture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, lanAddress, HOSTNAME, TOKEN } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanup = []; let browser;
try {
  const ip = lanAddress(); assert.ok(ip, 'an active LAN interface is needed to test browser microphone restrictions');
  const server = await startServer({ after: (fn) => cleanup.unshift(fn) }, { network: { wifi: true, internet: { kind: 'domain', hostname: HOSTNAME } }, token: TOKEN });
  fs.writeFileSync(server.lanIp, ip);
  const login = await server.login(), lan = `http://${ip}:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = login.cookie.split('=');
  for (const url of [server.base, lan]) await context.addCookies([{ name, value, url }]);
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  // The destination is intercepted before any external network request.
  await context.route(`https://${HOSTNAME}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Secure connection</title>' }));
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], starts = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/camera/start')) starts.push(request.url()); });
  await page.goto(lan); await page.waitForFunction(() => typeof openCameraSheet === 'function'); await page.evaluate(() => openCameraSheet());
  assert.equal(await page.evaluate(() => isSecureContext), false, 'this is actual insecure HTTP, not a mocked capability');
  const camera = page.locator('.camera-sheet');
  assert.equal(await camera.getByRole('button', { name: 'Hold to speak', exact: true }).isDisabled(), true);
  await camera.locator('.camera-talk-hint').filter({ hasText: 'secure HTTPS connection' }).waitFor();
  const secure = camera.getByRole('button', { name: 'Use secure connection', exact: true }); await secure.waitFor();
  assert.equal(starts.length, 0, 'opening the view starts no capture');
  await secure.click(); await page.waitForURL((url) => url.protocol === 'https:');
  assert.equal(new URL(page.url()).hostname, HOSTNAME); assert.equal(new URL(page.url()).hash, '#camera');
  assert.ok(new URL(page.url()).searchParams.get('h'), 'secure switch uses the existing single-use session handoff');
  await page.goto(server.base);
  await page.evaluate(() => sessionStorage.setItem('pd.chat.stack', JSON.stringify([{ layer: 'list' }])));
  await page.goto(server.base + '/?microphone=secure#camera');
  await camera.waitFor(); assert.equal(await page.locator('.st-sheet').getAttribute('data-page'), 'controls');
  assert.equal(await page.locator('.st-panel-mount .camera-sheet').isVisible(), true);
  assert.equal(await page.locator('.chat-list-screen').isVisible(), false, 'a previously saved chat cannot cover the explicit camera landing');
  assert.equal(starts.length, 0, 'secure landing restores the page without automatically opening any microphone/camera');
  assert.equal(new URL(page.url()).hash, '', 'the camera fragment is consumed once');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/pocket-hold-to-speak-390.png' });
  assert.deepEqual(errors, []);
  console.log('PASS real HTTP microphone restriction, explicit HTTPS session handoff, and restored camera page without automatic media capture');
} finally { await browser?.close(); for (const fn of cleanup) await fn(); }
