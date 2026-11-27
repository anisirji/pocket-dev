// Local approval and real sockets with an inert native-adapter fixture. Never injects OS input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, until, pause } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-control-browser-')), cleanups = [], t = { after: (fn) => cleanups.push(fn) };
let browser;
try {
  const python = path.join(root, 'inert-input'), osascript = path.join(root, 'inert-displays'), record = path.join(root, 'inputs.jsonl');
  fs.writeFileSync(python, `#!/usr/bin/env node
const fs = require('node:fs');
const ready = () => console.log(JSON.stringify({state:'ready',code:'READY',message:'Inert test adapter'}));
ready();
if (!process.argv.includes('--check')) require('node:readline').createInterface({input:process.stdin}).on('line', line => { const request = JSON.parse(line); if (request.event) fs.appendFileSync(process.env.POCKET_DEV_INPUT_RECORD, JSON.stringify(request.event)+'\\n'); console.log(JSON.stringify({id:request.id,state:'ready'})); });
`, { mode: 0o700 });
  fs.writeFileSync(osascript, `#!/usr/bin/env node
console.log(process.argv.some(value=>value.includes('NSScreen.screens')) ? JSON.stringify([{index:1,id:123,name:'Inert fixture display',width:320,height:200}]) : '[]');
`, { mode: 0o700 });
  const server = await startServer(t, { env: { POCKET_DEV_INPUT_PYTHON: python, POCKET_DEV_OSASCRIPT: osascript, POCKET_DEV_INPUT_RECORD: record } }), login = await server.login();
  await server.local('POST', '/api/permissions/setup', { status: 'skipped' });
  assert.equal((await server.request('GET', '/api/screen/control/support')).status, 401);
  assert.equal((await server.request('POST', '/api/screen/control/approve', { cookie: login.cookie, body: { allow: true } })).status, 404, 'the phone cannot approve its own request');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const phone = await context.newPage(), admin = await browser.newPage(), errors = []; for (const page of [phone, admin]) page.on('pageerror', (error) => errors.push(String(error)));
  await phone.goto(server.base); const picture = Buffer.from(await phone.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width=320;canvas.height=200;return canvas.toDataURL('image/jpeg').split(',')[1]; }), 'base64');
  await phone.route('**/api/screen?**', (route) => route.fulfill({ body: picture, contentType: 'image/jpeg' }));
  await phone.waitForFunction(() => typeof openScreenSheet === 'function'); await phone.evaluate(() => openScreenSheet());
  await admin.goto(server.admin);
  const screen = phone.locator('.screen-sheet'); await screen.getByRole('button', { name: 'Control', exact: true }).click();
  await screen.getByRole('button', { name: 'Cancel request', exact: true }).waitFor();
  assert.equal(fs.existsSync(record), false, 'requesting control never injects an input');
  await admin.getByRole('button', { name: 'Allow and remember', exact: true }).click();
  await screen.getByRole('button', { name: 'Stop control', exact: true }).waitFor();
  assert.equal(fs.existsSync(record), false, 'local approval starts no input on its own');
  await screen.locator('img').click({ position: { x: 100, y: 60 } });
  const inputs = () => fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  await until(() => inputs().some((event) => event.kind === 'click'));
  await screen.getByLabel('Text to type on the Mac', { exact: true }).fill('fixture text'); await screen.getByRole('button', { name: 'Send text', exact: true }).click();
  await until(() => inputs().some((event) => event.kind === 'text' && event.text === 'fixture text'));
  await screen.getByRole('button', { name: 'Switch app', exact: true }).click(); await until(() => inputs().some((event) => event.kind === 'key' && event.key === 'Tab' && event.modifiers.includes('command')));
  assert.equal(await phone.evaluate(() => JSON.stringify(localStorage).includes('fixture text')), false, 'typed control text is never saved');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await admin.getByRole('button', { name: 'Stop and revoke', exact: true }).click(); await screen.getByRole('button', { name: 'Control', exact: true }).waitFor();
  const stopped = inputs().length; await screen.locator('img').click(); await pause(100); assert.equal(inputs().length, stopped, 'host Stop prevents further input and grants are not restored');
  await screen.getByRole('button', { name: 'Control', exact: true }).click(); await admin.getByRole('button', { name: 'Allow and remember', exact: true }).click(); await screen.getByRole('button', { name: 'Stop control', exact: true }).waitFor();
  await admin.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await pause(200); assert.equal((await server.request('GET', '/api/screen/control', { cookie: login.cookie })).data.state, 'active', 'remembered global approval survives hiding Admin');
  await admin.close();
  await screen.getByRole('button', { name: 'Stop control', exact: true }).click();
  const otherLogin = await server.login({ headers: { 'user-agent': 'Another remote connection' } });
  const otherContext = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const [otherName, otherValue] = otherLogin.cookie.split('='); await otherContext.addCookies([{ name: otherName, value: otherValue, url: server.base }]);
  await otherContext.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const otherPhone = await otherContext.newPage(); otherPhone.on('pageerror', (error) => errors.push(String(error)));
  await otherPhone.goto(server.base); await otherPhone.waitForFunction(() => typeof openScreenSheet === 'function'); await otherPhone.evaluate(() => openScreenSheet());
  const otherScreen = otherPhone.locator('.screen-sheet'); await otherScreen.getByRole('button', { name: 'Control', exact: true }).click();
  await otherScreen.getByRole('button', { name: 'Stop control', exact: true }).waitFor();
  const local = await browser.newPage(); local.on('pageerror', (error) => errors.push(String(error))); await local.goto(server.admin + '/#permissions');
  const controlToggle = local.getByRole('switch', { name: 'Screen control', exact: true });
  await controlToggle.uncheck(); await otherScreen.getByRole('button', { name: 'Control', exact: true }).waitFor();
  assert.equal((await server.request('POST', '/api/screen/control', { cookie: otherLogin.cookie, body: { display: 1 } })).status, 403);
  assert.equal((await server.local('GET', '/api/remote-permissions')).data.screenControlApproved, false);
  for (const width of [390, 1280]) {
    await local.setViewportSize({ width, height: 844 });
    await local.locator('#remotePermissions').scrollIntoViewIfNeeded();
    await local.screenshot({ path: `/tmp/pocket-global-permissions-${width}.png` });
    assert.equal(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'global permission controls fit mobile and desktop');
    assert.equal(await local.locator('#remotePermissions [role="switch"]').count(), 4);
  }
  assert.deepEqual(errors, []); console.log('PASS computer-wide one-time approval across new logins, closed Admin, scoped fresh sockets, inert input, and global Admin revocation');
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
