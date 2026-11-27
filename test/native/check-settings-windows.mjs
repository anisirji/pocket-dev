// Real Windows/Edge smoke check. Run against an installed package in a temporary directory:
// node test/native/check-settings-windows.mjs <package-root> <result.json>
// Uses a separate HOME, config, ports, browser profile and login. Never changes the installed service or runs power actions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isolatedEnv } from '../isolated-env.mjs';
assert.equal(process.platform, 'win32', 'Run this check on a real Windows computer.');
const [packageRoot, resultFile] = process.argv.slice(2);
assert.ok(packageRoot && resultFile, 'Pass the installed package root and a result file.');
const require = createRequire(path.join(packageRoot, 'package.json')), WebSocket = require('ws');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-settings-native-'));
const home = path.join(work, 'home'); fs.mkdirSync(home);
const stateDir = path.join(work, 'state'); fs.mkdirSync(stateDir);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) {
  fs.writeFileSync(path.join(path.dirname(resultFile), 'browser-progress.json'), JSON.stringify({ phase: label }));
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise((resolve) => server.close(resolve)); return port;
}
const report = { platform: process.platform, node: process.version, checks: [], screens: [], error: null };
let server, edge, cdp, browserProfile, cookie = '', origin;
const serverLog = fs.openSync(path.join(work, 'server.log'), 'a');
try {
  const configFile = path.join(work, 'config.json');
  const testPassword = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(configFile, JSON.stringify({ password: testPassword, awake: 'off', fileRoots: [home], maxDevices: 20, network: { wifi: false, internet: { kind: 'off' } } }));
  const port = await freePort(), adminPort = await freePort(); origin = `http://127.0.0.1:${port}`;
  const env = isolatedEnv(home, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    PORT: String(port), POCKET_DEV_ADMIN_PORT: String(adminPort), POCKET_DEV_CONFIG: configFile, POCKET_DEV_STATE_DIR: stateDir, POCKET_DEV_NO_OPEN: '1' });
  server = spawn(process.execPath, [path.join(packageRoot, 'server.js')], { cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
  await until(async () => { assert.equal(server.exitCode, null, 'test server stayed running'); try { return (await fetch(origin + '/api/status')).ok; } catch { return false; } }, 'isolated Windows server');
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pocket-dev': '1' }, body: JSON.stringify({ password: testPassword }) });
  cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.equal(login.ok, true, 'test login succeeded');
  const loginStatus = await fetch(origin + '/api/status', { headers: { cookie } });
  assert.equal((await loginStatus.json()).status, 'active', 'test login is active');
  const api = async (url) => { const response = await fetch(origin + url, { headers: { cookie, 'x-pocket-dev': '1' } }); assert.ok(response.ok, `${url}: HTTP ${response.status}`); return response.json(); };
  const power = await api('/api/power'), health = await api('/api/health'), apps = await api('/api/apps');
  assert.ok(Array.isArray(apps.apps), 'actual Windows applications API returned a list');
  report.applications = { count: apps.apps.length, unsupported: apps.unsupported || null };
  report.capabilities = { unsupportedPower: power.unsupported, healthStatus: health.status, hasDiskReading: health.disk.freeGB !== null, hasCpuReading: health.cpu.usedPercent !== null };
  const executable = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((file) => fs.existsSync(file));
  assert.ok(executable, 'Microsoft Edge is installed');
  browserProfile = path.join(work, 'edge-profile');
  edge = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const activePort = path.join(browserProfile, 'DevToolsActivePort');
  await until(() => fs.existsSync(activePort), 'headless Windows Edge');
  const debugPort = fs.readFileSync(activePort, 'utf8').split('\n')[0], debug = `http://127.0.0.1:${debugPort}`;
  const target = await (await fetch(debug + '/json/new?about:blank', { method: 'PUT' })).json();
  cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
  let next = 0; const pending = new Map(), exceptions = [], requests = [];
  cdp.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id) { const wait = pending.get(message.id); if (!wait) return; pending.delete(message.id); clearTimeout(wait.timer); message.error ? wait.reject(new Error(message.error.message)) : wait.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    else if (message.method === 'Network.requestWillBeSent') requests.push(new URL(message.params.request.url).pathname);
    // Exercise screen UI without capturing the owner's desktop.
    else if (message.method === 'Fetch.requestPaused') send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'Desktop capture intentionally omitted during validation.' })).toString('base64') }).catch(() => {});
  });
  function send(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000); pending.set(id, { resolve, reject, timer }); cdp.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) { const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; }
  const exists = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const wait = (selector) => until(() => exists(selector), selector);
  async function click(selector) { await wait(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'}); document.querySelector(${JSON.stringify(selector)}).click()`); }
  const back = async () => { await click('.st-back'); await pause(150); };
  const homePage = async () => { while (await exists('.st-back')) await back(); };
  const choose = async (key, width) => { if (width <= 700) await homePage(); await click(`[data-category="${key}"]`); };
  const reload = async () => {
    await evaluate('window.pocketDev.overlays.settled()');
    await evaluate('window.__nativeReloadPending = true');
    await send('Page.reload');
    await until(async () => {
      try { return await evaluate("document.readyState === 'complete' && !window.__nativeReloadPending && !!window.pocketDev?.navigation?.ready"); }
      catch (error) { if (/context|navigat/i.test(error.message)) return false; throw error; }
    }, 'navigation scripts after reload');
    await evaluate('window.pocketDev.navigation.ready');
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/screen*', requestStage: 'Request' }] });
  await send('Network.setCookie', { name: cookie.slice(0, cookie.indexOf('=')), value: cookie.slice(cookie.indexOf('=') + 1), url: origin, httpOnly: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('pd-welcome-shown','1')" });
  for (const [width, height] of [[390, 844], [1280, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 700 });
    await send('Page.navigate', { url: origin });
    await until(() => evaluate("document.readyState === 'complete' && !!window.pocketDevSettings?.open"), 'Settings scripts ready');
    await wait('#settingsBtn');
    report.browser = await evaluate('navigator.userAgent');
    await click('#settingsBtn');
    assert.equal(await evaluate("document.querySelectorAll('.st-category').length"), 6);
    assert.equal(await evaluate("document.querySelector('.st-credit').textContent"), 'Written by theani.me');
    await choose('computers', width); await wait('.cc-computer');
    assert.equal(await evaluate("document.querySelector('.cc-summary').textContent"), '1 computer · Online');
    assert.equal(await evaluate("document.querySelector('[data-category=computers] small').textContent"), '1 computer · Online');
    assert.match(await evaluate("document.querySelector('.cc-computer').textContent"), /This computer · Online/);
    await click('.cc-computer'); await wait('.cc-label');
    const computerTitle = await evaluate("document.querySelector('.st-head h2').textContent");
    const historyLength = await evaluate('history.length');
    for (let repeat = 0; repeat < 2; repeat++) {
      await reload(); await wait('.cc-label');
      assert.equal(await evaluate("document.querySelector('.st-head h2').textContent"), computerTitle);
      assert.equal(await evaluate('history.length'), historyLength, 'reload preserves the page without duplicate Back entries');
    }
    await evaluate('history.back()'); await wait('.cc-computer');
    await click('.cc .st-primary'); await wait('.cc-choices');
    await click('.cc-choice:has(input[value=external])'); await click('.cc .st-primary'); await wait('.cc-field input');
    await evaluate('history.back()'); await wait('.cc-choices');
    assert.equal(await evaluate("document.querySelector('input[value=external]').checked"), true);
    await choose('connection', width); await wait('.nw-summary');
    await reload(); await wait('.nw-summary');
    assert.equal(await evaluate("document.querySelector('.st-sheet').dataset.page"), 'connection');
    await choose('tools', width); await wait('.sx-provider');
    assert.equal(await evaluate("document.querySelectorAll('.sx-provider').length"), 4);
    await click('.sx-provider:nth-child(3)'); await wait('.sx-sharing input');
    assert.equal(await evaluate("document.querySelector('.sx-sharing input').disabled"), true, 'unsupported sharing remains disabled');
    if (width > 700) assert.equal(await exists('.st-nav'), true);
    await choose('controls', width); await wait('.st-power .pw');
    await click('[data-act=apps]'); await wait('.apps-scroll');
    if (apps.apps.length) await wait('.apps-card');
    else await until(() => evaluate("[...document.querySelectorAll('.apps-scroll .apps-note')].some(node => !/loading/i.test(node.textContent))"), 'actual Windows app list');
    report.appListHasEntries = await evaluate("document.querySelectorAll('.apps-card').length > 0");
    if (await exists('.apps-card')) { await click('.apps-card'); await wait('.apps-head'); await evaluate('history.back()'); await wait('.apps-tabs'); }
    await back(); await click('[data-act=health]'); await wait('.health-group'); await back();
    await click('[data-act=screen]'); await wait('.screen-error'); await back();
    await click('[data-act=camera]'); await wait('.camera-controls'); await back();
    await choose('security', width); await wait('.st-device');
    await click('[data-act=qr]'); await wait('.st-qr svg');
    await choose('service', width); await wait('.sv-row');
    await click('.sv-row .st-danger'); await wait('dialog.st-confirm'); await click('dialog.st-confirm .st-btn');
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    const badPanels = await evaluate("[...document.querySelectorAll('.st-panel-mount > [data-settings-panel]')].filter(n=>!n.hidden).some(n=>n.getBoundingClientRect().bottom>document.querySelector('.st-panel-mount').getBoundingClientRect().bottom+1)");
    assert.equal(badPanels, false);
    if (width > 700) { const count = requests.length; await pause(16000); assert.deepEqual(requests.slice(count).filter((url) => /^\/api\/(apps|health|screen|settings|camera|performance|power\/vitals)$/.test(url)), [], 'hidden pages do not poll'); }
    await homePage();
    const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(path.dirname(resultFile), `settings-windows-${width}.png`), Buffer.from(image.data, 'base64'));
    await click('.st-close');
    report.screens.push({ width, height, passed: true });
  }
  assert.deepEqual(exceptions, [], 'no browser JavaScript exceptions');
  report.checks.push('six categories and footer', 'native Edge desktop and phone layout', 'computer count includes this computer', 'refresh preserves categories and computer detail without duplicate history', 'Back and external connection choice', 'actual Windows app, health and power APIs', 'unsupported AI sharing', 'login QR', 'confirmation cancellation', 'preview cleanup', 'hidden-page polling');
  report.omitted = ['No power commands, service changes, password changes or model calls.', 'Camera hardware was not started; desktop capture was intercepted.'];
} catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  cdp?.close();
  // Edge can hand startup to another process, so the launcher PID alone is insufficient.
  if (browserProfile) {
    const profile = browserProfile.replaceAll("'", "''");
    const script = `$pdProfile = '${profile}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($pdProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
    try { execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout:15000, stdio: 'ignore' }); } catch {}
  }
  if (edge?.pid) try { execFileSync('taskkill.exe', ['/PID', String(edge.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  if (origin && cookie) try { const response = await fetch(origin + '/api/sessions', { headers: { cookie } }); for (const session of await response.json()) await fetch(origin + `/api/sessions/${session.id}`, { method: 'DELETE', headers: { cookie, 'x-pocket-dev': '1' } }); } catch {}
  if (server?.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    await pause(1000);
  }
  fs.closeSync(serverLog);
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); report.cleanupComplete = true; }
  catch (error) { report.cleanupComplete = false; report.error ||= `Cleanup failed: ${error.message}`; process.exitCode = 1; }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
}
