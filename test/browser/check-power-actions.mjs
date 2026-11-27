// UI confirmations and cancellation use simulated power responses. No real authorization, sleep or shutdown.
import assert from 'node:assert/strict';
import { startServer, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = []; let browser;
try {
  const server = await startServer({ after: (fn) => cleanups.unshift(fn) });
  const login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript(() => {
      localStorage.setItem('pd-welcome-shown', '1');
      const timeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => timeout(fn, delay === 15000 ? 50 : delay, ...args);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], writes = [], terminals = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') terminals.push(request.postDataJSON()); });
    let cancel = false;
    let state = { awake: 'off', onAC: true, battery: 70, temperature: {}, stayingAwake: false, lidClosed: false, lidSleepDisabled: false, shutdown: null, unsupported: {}, updateInProgress: false };
    await page.route('**/api/power{,/**}', async (route) => {
      const request = route.request(), endpoint = new URL(request.url()).pathname;
      if (request.method() === 'GET') return route.fulfill({ json: state });
      const body = request.postDataJSON();
      writes.push({ method: request.method(), endpoint, body });
      if (request.method() === 'DELETE') { state.shutdown = null; return route.fulfill({ status: 204 }); }
      if (cancel) return route.fulfill({ status: 409, json: { error: 'Administrator approval was canceled. Nothing was changed.', cancelled: true } });
      assert.equal(body.confirmed, true);
      if (endpoint.endsWith('/lid')) { state.lidSleepDisabled = body.disabled; return route.fulfill({ json: state }); }
      if (endpoint.endsWith('/shutdown-force')) state.shutdown = { state: 'pending' };
      return route.fulfill({ status: 202, json: { shutdown: state.shutdown, sleepingInMs: 2000 } });
    });
    await page.goto(server.base); await page.evaluate(() => window.pocketDev.navigation.ready);
    await until(() => page.evaluate(() => !!window.pocketDev.activeSession()));
    const terminalCount = terminals.length;
    const sheet = page.locator('.st-sheet');
    await page.locator('#settingsBtn').click(); await sheet.locator('[data-category="controls"]').click();
    const power = sheet.locator('.st-power .pw'), toggle = power.getByRole('switch', { name: 'Stay awake with the lid closed', exact: true });
    await toggle.waitFor(); await until(async () => !await toggle.isDisabled());
    const confirmation = power.locator('.pw-row .pw-confirm');
    await toggle.click(); await confirmation.waitFor(); assert.equal(writes.length, 0);
    assert.match(await confirmation.innerText(), /administrator password/);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(writes.length, 0);
    await toggle.click(); await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await until(async () => await toggle.getAttribute('aria-checked') === 'true');
    assert.deepEqual(writes.at(-1).body, { disabled: true, confirmed: true });
    assert.equal(await sheet.getAttribute('data-page'), 'controls'); assert.equal(terminals.length, terminalCount);
    cancel = true;
    await toggle.click(); await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await power.locator('.pw-err').filter({ hasText: 'canceled' }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true'); assert.equal(await sheet.isVisible(), true);
    cancel = false;
    await toggle.click(); await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await until(async () => await toggle.getAttribute('aria-checked') === 'false');
    assert.deepEqual(writes.at(-1).body, { disabled: false, confirmed: true });
    await power.getByRole('button', { name: /Put .* to sleep/ }).click();
    const sleep = power.locator('.pw-actions .pw-confirm').filter({ hasText: /Put .* to sleep\?/ });
    await sleep.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes.some((request) => request.endpoint.endsWith('/sleep')), false);
    state.lidSleepDisabled = true;
    await power.getByRole('button', { name: /Put .* to sleep/ }).click();
    await sleep.getByRole('button', { name: 'Sleep', exact: true }).click();
    await until(() => writes.some((request) => request.endpoint.endsWith('/sleep')));
    await page.locator('.pw-screen').waitFor({ state: 'detached' });
    assert.equal(await sheet.isVisible(), true); assert.equal(terminals.length, terminalCount);

    state.shutdown = { state: 'blocked', apps: ['Fixture app'] };
    await page.evaluate(async () => (await window.pocketDev.power).showPowerScreen('mac-shutting-down', window.api, window.pocketDev.powerOptions));
    const screen = page.locator('.pw-screen');
    await screen.getByRole('button', { name: 'Force shut down…', exact: true }).click();
    await screen.locator('.pw-confirm').filter({ hasText: 'Force shut down?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes.some((request) => request.endpoint.endsWith('/shutdown-force')), false);
    cancel = true;
    await screen.getByRole('button', { name: 'Force shut down…', exact: true }).click();
    await screen.getByRole('button', { name: 'Yes, force it', exact: true }).click();
    await screen.getByText('Administrator approval was canceled. Nothing was changed.', { exact: true }).waitFor();
    await screen.getByRole('button', { name: 'OK', exact: true }).click(); await screen.waitFor({ state: 'detached' });
    assert.equal(await sheet.getAttribute('data-page'), 'controls'); assert.equal(terminals.length, terminalCount);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS in-app lid on/off, sleep and force-shutdown confirmation/cancellation; no terminal redirect at ${width}px`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups) await cleanup(); }
