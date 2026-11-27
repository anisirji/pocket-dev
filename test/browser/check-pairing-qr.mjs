// Real QR image decoding and pairing, using disposable servers and browser media.
import assert from 'node:assert/strict';
import { startServer, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanup = [], t = { after: (fn) => cleanup.push(fn) };
let browser;
async function openPhone(page, base) {
  await page.goto(base);
  await page.locator('#settingsBtn').click();
  await page.locator('.st-category[data-category="computers"]').click();
  await page.getByRole('button', { name: 'Connect another computer', exact: true }).click();
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await page.locator('.cc .rs-body').evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [320, 390, 1280]) {
    const a = await startServer(t, { env: { POCKET_DEV_ROOM_PING_MS: '200' } }), b = await startServer(t, { env: { POCKET_DEV_ROOM_PING_MS: '200' } });
    await a.local('POST', '/api/permissions/setup', { status: 'skipped' });
    const login = await b.login();
    const context = await browser.newContext({ viewport: { width, height: 844 }, permissions: ['camera'] });
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: b.base }]);
    const host = await context.newPage(), guest = await context.newPage(), errors = [];
    for (const page of [host, guest]) page.on('pageerror', (e) => errors.push(e.message));
    await host.goto(`${a.admin}#devices`);
    await host.getByRole('button', { name: 'Connect or manage computers' }).click();
    await host.getByRole('button', { name: 'Connect another computer', exact: true }).click();
    await host.getByLabel('My computer', { exact: true }).check();
    await host.getByRole('button', { name: 'Show QR', exact: true }).click();
    await host.locator('.cc-pair-qr svg').waitFor();
    await host.screenshot({ path: `/tmp/pocket-pairing-show-${width}.png` });
    await noOverflow(host);
    // Photo QR: works on a phone using plain HTTP, with no browser camera permission.
    const image = await host.locator('.cc-pair-qr').screenshot();
    await openPhone(guest, b.base);
    await guest.getByLabel('My computer', { exact: true }).check();
    await guest.getByRole('button', { name: 'Show QR', exact: true }).click();
    await guest.locator('.cc-pair-qr svg').waitFor();
    await guest.getByRole('button', { name: 'Scan QR', exact: true }).click();
    await guest.getByRole('button', { name: 'Use camera', exact: true }).click();
    await until(() => guest.locator('.rs-video').evaluate((v) => !!v.srcObject));
    await guest.evaluate(() => { window.pairTestTracks = document.querySelector('.rs-video').srcObject.getTracks(); });
    await guest.keyboard.press('Escape');
    assert.equal(await guest.evaluate(() => pairTestTracks.every((track) => track.readyState === 'ended')), true, 'Back stops camera tracks');
    await guest.getByRole('button', { name: 'Connect another computer', exact: true }).click();
    await guest.getByRole('button', { name: 'Scan QR', exact: true }).click();
    const blank = await guest.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 100; c.getContext('2d').fillRect(0, 0, 100, 100); return c.toDataURL().split(',')[1]; });
    await guest.locator('.cc input[type=file]').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: Buffer.from(blank, 'base64') });
    await until(async () => (await guest.locator('.cc .st-err').innerText()).includes('No QR found'));
    await noOverflow(guest);
    // Ownership choice survives going Back and entering the pairing screen again.
    assert.equal(await guest.getByLabel('My computer', { exact: true }).isChecked(), true);
    if (width === 390) {
      const inviteText = await host.locator('.rs-line').textContent();
      await guest.evaluate((text) => { window.BarcodeDetector = class { async detect() { return [{ rawValue: text }]; } }; }, inviteText);
      await guest.getByRole('button', { name: 'Use camera', exact: true }).click();
    } else {
      await guest.locator('.cc input[type=file]').setInputFiles({ name: 'connection.png', mimeType: 'image/png', buffer: image });
    }
    await until(async () => await guest.locator('.cc-computer').count() === 2);
    await until(async () => await host.locator('.cc-computer').count() === 2);
    assert.equal(await guest.locator('.cc-message').innerText(), 'Computer connected.');
    assert.equal(await host.locator('.cc-message').innerText(), 'Computer connected.');
    const state = (await b.local('GET', '/api/connections')).data;
    assert.equal(state.computers.find((computer) => !computer.self).computerAccess, true);
    await noOverflow(host); await noOverflow(guest);
    if (width === 320) {
      await host.getByRole('button', { name: 'Connect another computer', exact: true }).click();
      let invitations = 0;
      await host.route('**/api/connections/invite', async (route) => {
        invitations++; const response = await route.fetch();
        await route.fulfill({ json: { ...await response.json(), expiresInSeconds: 0.3 } });
      });
      await host.getByRole('button', { name: 'Show QR', exact: true }).click();
      await host.getByText('QR expired. Choose New QR.', { exact: true }).waitFor();
      assert.equal(await host.locator('.cc-pair-qr svg').count(), 0);
      assert.equal(invitations, 1, 'expiry never generates invitations without a user action');
      await host.keyboard.press('Escape');
    }
    await host.keyboard.press('Escape');
    await host.locator('.cc').waitFor({ state: 'detached' });
    assert.equal(await host.getByRole('button', { name: 'Connect or manage computers' }).evaluate((n) => n === document.activeElement), true);
    await guest.screenshot({ path: `/tmp/pocket-pairing-${width}.png` });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS real QR photo pairing, Admin, phone Settings, ownership, camera cleanup, errors and layout at ${width}px`);
  }
} finally {
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
}
