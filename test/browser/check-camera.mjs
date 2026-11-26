// Camera UI checks with simulated images; never opens a physical camera.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const publicDir = new URL('../../public/', import.meta.url);
let picture;
let starts = 0, frames = 0, stops = [], failure = null, proposed = false;
let supportAvailable = true, supportState = 'ready', installRequests = 0, failInstall = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/api/camera')) {
    let body = ''; for await (const chunk of req) body += chunk;
    if (url.pathname === '/api/camera/support') return json({ available: supportAvailable, canInstall: true, state: supportState,
      message: supportState === 'error' ? 'Download interrupted. Try again.' : supportState === 'installing' ? 'Downloading camera support…' : 'Install camera support to use the camera.',
      receivedBytes: 40, totalBytes: 100 });
    if (url.pathname === '/api/camera/install') {
      installRequests++; supportState = 'installing';
      setTimeout(() => { supportState = failInstall ? 'error' : 'ready'; supportAvailable = !failInstall; }, 400);
      return json({ state: 'installing' });
    }
    if (url.pathname === '/api/camera') return json({ cameras: [{ id: '0', name: 'Built-in camera with a long device name' }] });
    if (url.pathname.endsWith('/start')) {
      starts++;
      if (proposed) return json({ message: 'Camera start proposed. After approval, tap Start camera again.' }, 202);
      return json({ id: `viewer-${starts}`, camera: 'Built-in camera' });
    }
    if (url.pathname.endsWith('/stop')) { stops.push(JSON.parse(body).id); return json({ stopped: true }); }
    if (url.pathname.endsWith('/frame')) {
      frames++;
      if (failure) return json({ error: failure }, 503);
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(picture);
    }
  }
  if (url.pathname === '/camera.js' || url.pathname === '/camera.css') {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
    return res.end(fs.readFileSync(new URL(url.pathname.slice(1), publicDir)));
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg:#0b0e14;--panel:#131823;--line:#252d3c;--text:#d7dce5;--muted:#7d8799;--accent:#6aa9ff;--danger:#ff7b72}body{margin:0;font-family:system-ui}</style><link rel="stylesheet" href="/camera.css"></head><body><button id="open">Device camera</button><script>let onClose; window.pocketDev={overlays:{open(n,fn){onClose=fn},close(){onClose?.()}}};document.getElementById('open').onclick=()=>window.openCameraSheet();</script><script src="/camera.js"></script></body></html>`);
});
server.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  picture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#263850'; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#d7dce5'; ctx.font = '28px sans-serif'; ctx.fillText('Simulated camera', 190, 240);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  }), 'base64');
  await page.getByRole('button', { name: 'Device camera', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.camera-controls .start').disabled);
  assert.equal(starts, 0, 'opening the sheet does not activate capture');
  assert.equal(await page.getByRole('button', { name: 'Snapshot', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-status').textContent.includes('Live'));
  assert.equal(await page.locator('.camera-image').evaluate((n) => n.complete && n.naturalWidth > 0), true);
  assert.equal(await page.locator('.camera-sheet').evaluate((n) => n.scrollWidth <= innerWidth), true, 'fits a narrow phone');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Snapshot', exact: true }).click();
  const download = await downloaded;
  assert.match(download.suggestedFilename(), /^pocket-dev-camera-.*\.jpg$/);
  assert.deepEqual(fs.readFileSync(await download.path()), picture, 'snapshot contains the current camera image');
  const beforeSnapshot = frames;
  await page.waitForTimeout(350);
  assert.ok(frames > beforeSnapshot, 'snapshot keeps the live preview running');
  await page.screenshot({ path: '/tmp/pocket-dev-camera-mobile.png' });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-image').hidden);
  assert.equal(await page.getByRole('button', { name: 'Snapshot', exact: true }).isDisabled(), true);
  await page.waitForTimeout(300);
  assert.ok(stops.includes('viewer-1'));
  const stoppedFrames = frames;
  await page.waitForTimeout(350);
  assert.equal(frames, stoppedFrames, 'stopping cancels polling');

  proposed = true;
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'proposed' }).waitFor();
  assert.equal(frames, stoppedFrames, 'a Plan proposal never starts polling');
  proposed = false;
  failure = 'Camera disconnected. Reconnect it and try again.';
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Camera disconnected' }).waitFor();
  await page.waitForTimeout(100);
  assert.ok(stops.includes('viewer-3'), 'a failed preview releases its lease');

  failure = null;
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-status').textContent.includes('Live'));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);
  assert.ok(stops.includes('viewer-4'), 'backgrounding releases its lease');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-status').textContent.includes('Live'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.camera-sheet').hidden);
  await page.waitForTimeout(100);
  assert.ok(stops.includes('viewer-5'), 'closing releases its lease');
  assert.equal(await page.locator('#open').evaluate((n) => n === document.activeElement), true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#open').click();
  await page.waitForFunction(() => !document.querySelector('.camera-controls .start').disabled);
  assert.equal(await page.locator('.camera-sheet').evaluate((n) => n.scrollWidth <= innerWidth), true);
  assert.equal(installRequests, 0, 'installed camera support is reused automatically');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  supportAvailable = false; supportState = 'missing'; failInstall = true;
  await page.locator('#open').click();
  await page.getByRole('button', { name: 'Install camera support', exact: true }).waitFor();
  assert.equal(installRequests, 0, 'missing support only shows a button; it never installs automatically');
  assert.equal(await page.getByRole('button', { name: 'Start camera', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({ path: '/tmp/pocket-dev-camera-install.png' });
  await page.getByRole('button', { name: 'Install camera support', exact: true }).click();
  await page.getByRole('button', { name: 'Installing…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Installing…', exact: true }).isDisabled(), true);
  await page.getByRole('progressbar').waitFor();
  await page.getByRole('button', { name: 'Retry installation', exact: true }).waitFor();
  assert.equal(await page.locator('.camera-setup').evaluate((n) => n.textContent.includes('Download interrupted')), true);
  failInstall = false;
  await page.getByRole('button', { name: 'Retry installation', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.camera-controls .start').disabled);
  assert.equal(installRequests, 2);
  assert.equal(starts, 5, 'installing never activates the camera');
  assert.equal(await page.locator('.camera-setup').isHidden(), true);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-status').textContent.includes('Live'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#open').click();
  await page.waitForFunction(() => !document.querySelector('.camera-controls .start').disabled);
  assert.equal(installRequests, 2, 'reopening after installation does not reinstall');
  assert.deepEqual(errors, []);
  console.log('Camera browser checks passed: preview, snapshots, lifecycle, permissions, existing support, install button, progress, failed download, retry, automatic camera list refresh, no reinstall.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
