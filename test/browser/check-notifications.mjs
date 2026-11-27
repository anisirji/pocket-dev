// Isolated browser checks: no external push requests or OS notifications are sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
let browser;
try {
  const server = await startServer(t), login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(String(error))); await page.goto(server.base);
  // Register the real worker without asking for notifications or subscribing to a vendor.
  const script = await page.evaluate(async () => { await navigator.serviceWorker.register('/notifications-worker.js'); return (await navigator.serviceWorker.ready).active.scriptURL; });
  assert.equal(script, `${server.base}/notifications-worker.js`);
  await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
  await context.close();

  const controlled = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await controlled.addCookies([{ name, value, url: server.base }]);
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  await controlled.addInitScript((keys) => {
    localStorage.setItem('pd-welcome-shown', '1');
    const calls = window.notificationFixture = { permission: 0, subscribe: 0, unsubscribe: 0, sounds: 0 };
    Object.defineProperty(Notification, 'requestPermission', { value: async () => { calls.permission++; return 'granted'; } });
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/isolated-ui-fixture', toJSON() { return { endpoint: this.endpoint, keys }; }, async unsubscribe() { calls.unsubscribe++; return true; } };
    const registration = { active: { scriptURL: `${location.origin}/notifications-worker.js` }, pushManager: { getSubscription: async () => null, subscribe: async () => { calls.subscribe++; return subscription; } } };
    Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => undefined, register: async () => registration, ready: Promise.resolve(registration) } });
    window.AudioContext = class { state = 'running'; currentTime = 0; destination = {}; resume() { return Promise.resolve(); } close() {} createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } createOscillator() { return { frequency: {}, connect() {}, start() { calls.sounds++; }, stop() {} }; } };
  }, keys);
  const prefs = await controlled.newPage(); prefs.on('pageerror', (error) => errors.push(String(error))); await prefs.goto(server.base);
  await prefs.locator('#settingsBtn').click(); await prefs.locator('[data-category="service"]').click();
  const panel = prefs.locator('.pd-notification-preferences');
  await panel.getByRole('button', { name: 'Enable browser notifications', exact: true }).waitFor();
  assert.equal(await prefs.evaluate(() => notificationFixture.permission), 0, 'opening Settings never requests notification permission');
  await panel.getByRole('button', { name: 'Enable browser notifications', exact: true }).click();
  await panel.getByRole('button', { name: 'Turn off browser notifications', exact: true }).waitFor();
  assert.equal(await prefs.evaluate(() => notificationFixture.permission), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(server.stateDir, 'browser-push.json'))).subscriptions.length, 1);
  await panel.getByRole('button', { name: 'Turn off browser notifications', exact: true }).click();
  await panel.getByRole('button', { name: 'Enable browser notifications', exact: true }).waitFor();
  assert.equal(await prefs.evaluate(() => notificationFixture.unsubscribe), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(server.stateDir, 'browser-push.json'))).subscriptions.length, 0);
  const sounds = panel.getByRole('switch', { name: 'Notification sounds', exact: true });
  assert.equal(await sounds.isChecked(), false); await sounds.check();
  await until(async () => await prefs.evaluate(() => PocketDevNotifications.preferences().sounds));
  await panel.getByRole('heading', { name: 'Notifications', exact: true }).click();
  await prefs.evaluate(async () => { const notice = { id: 'fixture-complete', category: 'aiTasks', title: 'Fixture completed', sound: true }; await PocketDevNotifications.notify(notice); await PocketDevNotifications.notify(notice); });
  assert.equal(await prefs.evaluate(() => notificationFixture.sounds), 1, 'one completion creates one sound');
  assert.equal(await prefs.locator('.pd-alert:visible').count(), 1);
  assert.equal(await prefs.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await prefs.locator('.pd-alert-close').click(); assert.equal(await prefs.locator('.pd-alert:visible').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS real worker registration, explicit push opt-in and removal, quiet defaults, sound deduplication and phone layout');
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
