// Real QR generation and decoding, with a failing local tunnel fixture and no external network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, HOSTNAME, TOKEN, pause } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
const output = process.env.POCKET_DEV_TEST_OUTPUT_DIR || os.tmpdir();
let browser;
try {
  const server = await startServer(t), login = await server.login();
  await server.local('POST', '/api/permissions/setup', { status: 'skipped' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const decoder = await browser.newPage(); await decoder.addScriptTag({ path: fileURLToPath(new URL('../../public/vendor/jsqr/jsQR.js', import.meta.url)) });
  const decode = async (code) => {
    const svg = await code.locator('svg').evaluate((element) => element.outerHTML);
    return decoder.evaluate(async (svg) => {
      const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 600;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 600, 600); const pixels = ctx.getImageData(0, 0, 600, 600);
      return jsQR(pixels.data, 600, 600)?.data;
    }, svg);
  };
  const changeRemote = (enabled) => server.local('PUT', '/api/network', enabled
    ? { internet: { kind: 'domain', hostname: HOSTNAME }, token: TOKEN + 'bad' } : { internet: { kind: 'off' } });
  for (const width of process.env.POCKET_DEV_QR_TEST_WIDTH ? [Number(process.env.POCKET_DEV_QR_TEST_WIDTH)] : [390, 1280]) {
    fs.writeFileSync(server.lanIp, '127.0.0.1'); await changeRemote(false);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript(() => {
      localStorage.setItem('pd-welcome-shown', '1'); window.qrCopies = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.qrCopies.push(text); } } });
    });
    await context.route(`https://${HOSTNAME}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Selected remote URL</title>' }));
    const admin = await context.newPage(), errors = [], calls = []; admin.setDefaultTimeout(20000);
    admin.on('pageerror', (error) => errors.push(error.message));
    let failRemote = false, shortExpiry = false;
    await admin.route('**/api/qr', async (route) => {
      const body = route.request().postDataJSON(); calls.push(body);
      if (failRemote && body.connection === 'remote') return route.fulfill({ status: 503, json: { error: 'Fixture remote connection unavailable' } });
      if (shortExpiry && body.kind === 'login') { const response = await route.fetch(), data = await response.json(); return route.fulfill({ json: { ...data, expiresAt: Date.now() + 900 } }); }
      return route.continue();
    });
    await admin.goto(server.admin + '/#sharing'); await admin.locator('#shareQrBtn:enabled').click();
    const share = admin.locator('#shareQr'); await share.locator('svg').waitFor();
    assert.equal(await share.getByRole('tab').count(), 0, 'remote-off UI contains no visible connection switch');
    const localUrl = await admin.locator('#shareQrUrl').innerText(); assert.equal(localUrl, server.base);
    assert.equal(await decode(admin.locator('#shareQrCode')), localUrl);
    await share.getByRole('button', { name: 'Copy link', exact: true }).click(); assert.equal(await admin.evaluate(() => qrCopies.at(-1)), localUrl);
    const [localPopup] = await Promise.all([admin.waitForEvent('popup'), share.getByRole('link', { name: 'Open', exact: true }).click()]);
    await localPopup.waitForLoadState('domcontentloaded'); assert.equal(new URL(localPopup.url()).origin, server.base); await localPopup.close();
    assert.equal((await changeRemote(true)).status, 200);
    await share.getByRole('tab', { name: 'Remote connection', exact: true }).waitFor();
    assert.equal(await share.getByRole('tab', { name: 'Local connection', exact: true }).getAttribute('aria-selected'), 'true');
    await share.getByRole('tab', { name: 'Remote connection', exact: true }).click();
    await admin.waitForFunction((url) => document.getElementById('shareQrUrl').textContent === url && !!document.querySelector('#shareQrCode svg'), `https://${HOSTNAME}`);
    assert.equal(await decode(admin.locator('#shareQrCode')), `https://${HOSTNAME}`);
    await share.getByRole('button', { name: 'Copy link', exact: true }).click(); assert.equal(await admin.evaluate(() => qrCopies.at(-1)), `https://${HOSTNAME}`);
    const before = calls.filter((call) => call.kind === 'share' && call.connection === 'local').length;
    await share.getByRole('tab', { name: 'Local connection', exact: true }).click();
    assert.equal(await admin.locator('#shareQrUrl').innerText(), localUrl);
    assert.equal(calls.filter((call) => call.kind === 'share' && call.connection === 'local').length, before, 'returning to Local reuses its current code');
    fs.writeFileSync(server.lanIp, '192.0.2.44');
    const changedUrl = `http://192.0.2.44:${server.port}`;
    await admin.waitForFunction((url) => document.getElementById('shareQrUrl').textContent === url && !!document.querySelector('#shareQrCode svg'), changedUrl);
    assert.equal(await decode(admin.locator('#shareQrCode')), changedUrl, 'IP changes replace the actual encoded QR, not just its label');
    fs.writeFileSync(server.lanIp, '');
    await share.getByText('Local access is unavailable. Check Wi-Fi and local access on the computer.', { exact: true }).waitFor();
    assert.equal(await share.locator('svg').count(), 0, 'losing Wi-Fi removes the old QR instead of substituting an offline hostname');
    fs.writeFileSync(server.lanIp, '192.0.2.44');
    await admin.waitForFunction((url) => document.getElementById('shareQrUrl').textContent === url && !!document.querySelector('#shareQrCode svg'), changedUrl);
    await share.getByRole('tab', { name: 'Remote connection', exact: true }).click(); failRemote = true;
    await admin.locator('#shareQrBtn').click(); await share.getByText('Fixture remote connection unavailable', { exact: true }).waitFor();
    await share.getByRole('tab', { name: 'Local connection', exact: true }).click(); assert.equal(await decode(admin.locator('#shareQrCode')), changedUrl);
    await changeRemote(false); await admin.waitForFunction(() => document.querySelector('#shareQr .cq-tabs').hidden);
    assert.equal(await admin.locator('#shareQrUrl').innerText(), changedUrl);
    shortExpiry = true; await admin.locator('#qrBtn').click(); await admin.locator('#qrCode svg').waitFor();
    await admin.locator('#qr').getByText('The login QR expired. Show a new code.', { exact: true }).waitFor();
    const loginCount = calls.filter((call) => call.kind === 'login').length; await pause(3200);
    assert.equal(calls.filter((call) => call.kind === 'login').length, loginCount, 'expiry and polling never mint a new login key automatically');
    assert.equal(await admin.locator('#qrCode svg').count(), 0);
    await admin.screenshot({ path: path.join(output, `pocket-connection-qr-admin-${width}.png`) });

    await changeRemote(true); const phone = await context.newPage(); phone.setDefaultTimeout(20000); phone.on('pageerror', (error) => errors.push(error.message));
    await phone.goto(server.base); await phone.locator('#settingsBtn').click(); await phone.locator('[data-category="security"]').click();
    await phone.locator('[data-act="qr"]:enabled').click(); const picker = phone.locator('.st-connection-qr'); await picker.locator('.st-qr svg').waitFor();
    assert.equal(await picker.getByRole('tab', { name: 'Local connection', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(new URL(await decode(picker.locator('.st-qr'))).origin, changedUrl);
    await picker.getByRole('tab', { name: 'Remote connection', exact: true }).focus(); await phone.keyboard.press('Enter'); await picker.locator('.st-qr svg').waitFor();
    await phone.waitForFunction((host) => document.querySelector('.st-connection-qr .cq-url').href.startsWith(host), `https://${HOSTNAME}/`);
    const remoteLogin = await decode(picker.locator('.st-qr')); assert.equal(new URL(remoteLogin).origin, `https://${HOSTNAME}`);
    await picker.getByRole('button', { name: 'Copy login link', exact: true }).click(); assert.equal(await phone.evaluate(() => qrCopies.at(-1)), remoteLogin);
    const [remotePopup] = await Promise.all([phone.waitForEvent('popup'), picker.getByRole('link', { name: 'Open', exact: true }).click()]);
    await remotePopup.waitForLoadState('domcontentloaded'); assert.equal(remotePopup.url(), remoteLogin); await remotePopup.close();
    await picker.getByRole('tab', { name: 'Local connection', exact: true }).click(); fs.writeFileSync(server.lanIp, '192.0.2.55');
    await phone.waitForFunction((base) => document.querySelector('.st-connection-qr .cq-url').href.startsWith(base) && !!document.querySelector('.st-qr svg'), `http://192.0.2.55:${server.port}/`);
    assert.equal(new URL(await decode(picker.locator('.st-qr'))).origin, `http://192.0.2.55:${server.port}`);
    if (width === 390) await phone.setViewportSize({ width: 320, height: 900 });
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'connection tabs fit the smallest supported phone');
    await phone.screenshot({ path: path.join(output, `pocket-connection-qr-settings-${width}.png`) });
    let release, received;
    const held = new Promise((resolve) => { received = resolve; });
    await phone.route('**/api/settings/qr-key', async (route) => {
      if (route.request().postDataJSON().connection !== 'remote') return route.continue();
      await new Promise((resolve) => { release = resolve; received(); }); await route.continue();
    });
    await picker.getByRole('tab', { name: 'Remote connection', exact: true }).click();
    await phone.locator('[data-act="qr"]').click(); await held;
    await phone.locator('.st-close').click(); assert.equal(await picker.locator('svg').count(), 0);
    release(); await pause(300);
    assert.equal(await picker.locator('svg').count(), 0, 'late QR responses cannot reopen a closed interface');
    assert.equal(await picker.locator('.cq-url').getAttribute('href'), null, 'closing Settings removes all login links');
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS shared Local/Remote QR at ${width}px: scan/decode, copy/open, local default, failures, IP changes, expiry and cleanup`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
