// Native-style Settings navigation against isolated real servers. No personal devices or credentials are used.
import assert from 'node:assert/strict';
import { startServer, pause, until } from '../helpers/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
const fake = new URL('../helpers/fake-claude.mjs', import.meta.url).pathname;
let browser;
try {
  const server = await startServer(t, { env: { POCKET_DEV_CLAUDE: fake } });
  const login = await server.login();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [320, 390, 844, 1280]) {
    const height = width === 844 ? 390 : 844;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on('pageerror', (error) => { errors.push(String(error)); console.error(error); });
    page.on('request', (request) => { if (new URL(request.url()).pathname.includes('/api/')) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
    // Deterministic application data exercises detail/back/force-quit without ever quitting a real process.
    await page.route('**/api/apps', (route) => route.fulfill({ json: { apps: Array.from({ length: 28 }, (_, index) => ({ pid: 1000 + index, name: `Fixture App ${index}`, bundleId: `test.fixture.${index}`, cpu: 1, memMB: 32, windows: 1 })) } }));
    await page.route('**/api/apps/10*/windows', (route) => route.fulfill({ json: { windows: [] } }));
    await page.goto(server.base);
    await page.locator('#settingsBtn').click();
    const sheet = page.locator('.st-sheet'), nav = sheet.locator('.st-nav'), title = sheet.locator('.st-head h2');
    const category = (key) => sheet.locator(`[data-category="${key}"]`);
    const back = () => sheet.locator('.st-back').click();
    const choose = async (key) => {
      if (width <= 700 && !await nav.isVisible()) {
        while (await sheet.locator('.st-back').isVisible()) await back();
      }
      await category(key).click();
    };
    const fits = async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no document overflow');
      const overflow = await sheet.evaluate((root) => [...root.querySelectorAll('button, input:not([type=checkbox]), select')].filter((node) => node.getClientRects().length).filter((node) => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map((node) => node.outerHTML));
      assert.deepEqual(overflow, [], 'all essential controls fit horizontally');
      const panelsFit = await sheet.evaluate((root) => {
        const mount = root.querySelector('.st-panel-mount'); if (mount.hidden) return true;
        const bounds = mount.getBoundingClientRect();
        return [...mount.children].filter((panel) => !panel.hidden).every((panel) => { const rect = panel.getBoundingClientRect(); return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1; });
      });
      assert.equal(panelsFit, true, 'hosted panels fit below the common header');
    };
    assert.equal(await nav.locator('[data-category]').count(), 6);
    assert.match(await nav.locator('.st-credit').innerText(), /Written by theani.me/);
    const initial = requests.length; await pause(300);
    assert.equal(requests.slice(initial).filter((request) => /\/api\/(setup|settings|service|apps)/.test(request.path)).length, 0, 'home does not eagerly fetch unrelated categories');
    await fits();
    await choose('security'); await sheet.locator('.st-summary').filter({ hasText: 'logged in' }).waitFor();
    await sheet.locator('[data-act="qr"]').click(); await sheet.locator('.st-qr svg').waitFor();
    await sheet.locator('[data-step="-1"]').click(); await sheet.locator('[data-act="limit"]').click();
    await sheet.locator('[data-for="limit"].st-ok').filter({ hasText: 'Saved' }).waitFor();
    await fits();
    await choose('tools'); await sheet.locator('.sx-provider').first().waitFor();
    assert.equal(await sheet.locator('.sx-provider').count(), 4);
    const setupRequests = requests.filter((request) => /setup\/status/.test(request.path));
    assert.ok(setupRequests.some((request) => request.path === '/api/setup/status'), 'setup uses the front-door computer');
    await sheet.locator('.sx-provider').filter({ hasText: 'Claude' }).click();
    await sheet.getByRole('switch', { name: 'Share Claude', exact: true }).waitFor();
    assert.equal(await sheet.getByRole('switch', { name: 'Share Claude', exact: true }).isEnabled(), true);
    await sheet.getByRole('switch', { name: 'Share Claude', exact: true }).check();
    await until(async () => !await sheet.getByRole('switch', { name: 'Share Claude', exact: true }).isDisabled());
    assert.match(await sheet.locator('.sx-authorized').innerText(), /Authorized computers/);
    await page.goBack(); await sheet.locator('.sx-provider').first().waitFor();
    await sheet.locator('.sx-provider').filter({ hasText: 'Antigravity' }).click();
    assert.equal(await sheet.getByRole('switch', { name: 'Share Antigravity', exact: true }).isDisabled(), true);
    assert.match(await sheet.locator('.sx-sharing').innerText(), /not available yet/);
    await fits();
    if (width > 700) assert.equal(await category('security').isVisible(), true, 'sidebar persists on provider detail');
    await choose('computers'); await sheet.locator('.cc-computer').first().waitFor();
    assert.equal(await sheet.locator('.cc-summary').innerText(), '1 computer · Online', 'the computer already being used is included');
    assert.equal(await category('computers').locator('small').textContent(), '1 computer · Online');
    assert.match(await sheet.locator('.cc-computer').first().innerText(), /This computer · Online/);
    await sheet.locator('.cc-computer').first().click(); await until(async () => (await title.innerText()) !== 'Connected computers');
    assert.match(await sheet.locator('.cc .rs-body').innerText(), /Access type/i);
    await page.goBack(); await sheet.getByRole('button', { name: 'Connect another computer', exact: true }).waitFor();
    await sheet.getByRole('button', { name: 'Connect another computer', exact: true }).click();
    await sheet.getByLabel('My computer', { exact: true }).uncheck();
    await sheet.getByRole('button', { name: 'Scan QR', exact: true }).click();
    await sheet.getByRole('button', { name: 'Choose QR photo', exact: true }).waitFor();
    await fits(); await page.goBack();
    await sheet.getByRole('button', { name: 'Connect another computer', exact: true }).click();
    assert.equal(await sheet.getByLabel('My computer', { exact: true }).isChecked(), false, 'Back preserves connection type');
    await page.goBack(); await sheet.locator('.cc-computer').first().waitFor();
    await choose('controls'); await sheet.locator('.pw').waitFor();
    if (width === 1280) {
      // The power interstitial can still open Apps above Settings when a shutdown needs attention.
      await page.evaluate(() => { const power = document.createElement('div'); power.className = 'pw-screen'; document.body.append(power); window.openAppsSheet(); });
      await page.locator('body > .apps-sheet .apps-card').first().waitFor();
      assert.equal(await page.locator('body > .apps-sheet').getAttribute('role'), 'dialog');
      await page.locator('body > .apps-sheet').getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(() => document.querySelector('.pw-screen').remove());
    }
    await sheet.locator('[data-act="apps"]').click(); await sheet.locator('.apps-card').first().waitFor();
    if (width > 700) assert.equal(await category('connection').isVisible(), true, 'sidebar persists inside app browser');
    await sheet.locator('.apps-scroll').evaluate((node) => { node.scrollTop = 600; });
    const scroll = await sheet.locator('.apps-scroll').evaluate((node) => node.scrollTop);
    const visibleApp = await sheet.locator('.apps-card').evaluateAll((nodes) => {
      const area = document.querySelector('.apps-scroll').getBoundingClientRect();
      return nodes.findIndex((node) => { const rect = node.getBoundingClientRect(); return rect.top >= area.top + 4 && rect.bottom <= area.bottom - 4; });
    });
    assert.ok(visibleApp >= 0); await sheet.locator('.apps-card').nth(visibleApp).click();
    await sheet.getByRole('button', { name: 'Force quit', exact: true }).click();
    const confirm = page.locator('dialog.st-confirm'); await confirm.waitFor();
    assert.match(await confirm.innerText(), /Unsaved work/); await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(requests.some((request) => /force-quit/.test(request.path) && request.method === 'POST'), false, 'cancel never performs destructive action');
    await page.goBack(); await sheet.locator('.apps-card').first().waitFor();
    await until(async () => Math.abs(await sheet.locator('.apps-scroll').evaluate((node) => node.scrollTop) - scroll) < 3);
    await fits(); await back(); await sheet.locator('.st-power .pw').waitFor();
    await sheet.locator('[data-act="health"]').click(); await sheet.locator('.health-group').first().waitFor(); await fits();
    if (width === 1280) await page.screenshot({ path: '/tmp/pocket-dev-settings-health-desktop.png' });
    await back(); await sheet.locator('[data-act="screen"]').click(); await sheet.getByRole('button', { name: /Auto:/ }).waitFor(); await fits();
    await back(); await sheet.locator('[data-act="camera"]').click(); await sheet.locator('.camera-controls').waitFor(); await fits();
    await choose('connection'); await sheet.locator('[data-mount="connection"] .nw-summary').waitFor(); await fits();
    await choose('service'); await sheet.locator('.sv-row').first().waitFor(); await fits();
    await sheet.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.locator('dialog.st-confirm').waitFor();
    const bounds = await page.locator('dialog.st-confirm').boundingBox();
    if (width <= 700) assert.ok(bounds.y + bounds.height >= height - 2, 'phone confirmation is a bottom sheet');
    await page.keyboard.press('Escape'); await page.locator('dialog.st-confirm').waitFor({ state: 'detached' });
    if (width === 1280) {
      await pause(500); const hiddenStart = requests.length; await pause(16000);
      assert.equal(requests.slice(hiddenStart).filter((request) => /\/api\/(apps|health|screen|settings|camera|performance|power\/vitals|setup\/status)$/.test(request.path)).length, 0, 'hidden pages stop polling');
      await choose('tools'); await sheet.locator('.sx-provider').first().waitFor();
      await page.screenshot({ path: '/tmp/pocket-dev-settings-desktop.png' });
    }
    await sheet.locator('.st-close').click(); await sheet.waitFor({ state: 'hidden' });
    if (width === 1280) {
      for (const [open, selector] of [['openHealthSheet', '.health-sheet'], ['openCameraSheet', '.camera-sheet']]) {
        await page.evaluate((name) => window[name](), open);
        const standalone = page.locator(`body > ${selector}`); await standalone.waitFor();
        assert.equal(await standalone.getAttribute('role'), 'dialog', 'standalone panels regain their dialog semantics');
        await standalone.getByRole('button', { name: 'Close', exact: true }).click(); await standalone.waitFor({ state: 'hidden' });
      }
    }
    await page.locator('#settingsBtn').click();
    if (width === 390) await page.screenshot({ path: '/tmp/pocket-dev-settings-mobile.png' });
    const touchTargets = await sheet.evaluate((root) => [...root.querySelectorAll('button,a')].filter((node) => node.getClientRects().length).filter((node) => node.getBoundingClientRect().height < 44).map((node) => node.outerHTML));
    assert.deepEqual(touchTargets, [], '44px navigation touch targets');
    assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS Settings categories, native history, sidebar, scroll, capabilities and cancellation at ${width}×${height}`);
  }
} finally { await browser?.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
