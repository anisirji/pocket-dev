// Model-free browser checks. Install Playwright locally, or set PLAYWRIGHT_MODULE
// to an existing installation's index.mjs. CHROME_PATH can select a local browser.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const session = { id: 'aaaaaaaaaaaa', title: 'Responsive fixture', cwd: '/tmp', startedAt: Date.now(), activeAt: Date.now() };
const folders = Array.from({ length: 16 }, (_, i) => ({ name: `Project ${i}`, path: `/tmp/project-${i}` }));
const choices = Array.from({ length: 18 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}`, description: 'A longer option description that should wrap on narrow screens.' }));
const chat = { id: 'fixture-chat', tool: 'codex', title: 'Question fixture', cwd: '/tmp', updatedAt: Date.now(), settings: { model: 'model-0' }, status: 'waiting-answer', pending: true, pendingId: 'question-1' };
const question = { id: 'event-1', seq: 1, type: 'question', requestId: 'question-1', questions: [{ id: 'q1', question: 'Which option should we use?', options: choices.map((c) => ({ label: c.label, description: c.description })) }] };
const chatEvents = [{ id: 'plan-link', seq: 0, type: 'assistant-text', text: '[Fixture plan](/tmp/ROLE_ACCESS_PLAN.md)' }, question];
const claudeChat = { ...chat, id: 'claude-fixture', tool: 'claude', title: 'Claude fixture', status: 'idle', pending: false, pendingId: null };
const historyItem = { tool: 'codex', id: '00000000-0000-4000-8000-000000000001', cwd: '/tmp', title: 'Resume fixture', project: 'Fixture', lastActive: new Date().toISOString(), messageCount: 1, live: false };
let messagePosts = 0, terminalInputs = 0, terminalCreates = 0;
const chatCreates = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/files/download') {
    if (url.searchParams.get('path') !== '/tmp/ROLE_ACCESS_PLAN.md') { res.writeHead(403); return res.end(); }
    const content = '# Role access plan\n\nScoped repository access.\n';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(content), 'last-modified': new Date().toUTCString() });
    return res.end(req.method === 'HEAD' ? undefined : content);
  }
  const routes = {
    '/api/sessions': [session], '/api/forwards': [], '/api/info': { forwards: [] },
    '/api/folders': { home: '/tmp', pinned: folders, recent: [], projects: [] },
    '/api/chat': [chat, claudeChat], '/api/history': [historyItem], '/api/apps': { apps: [] },
    [`/api/history/codex/${historyItem.id}`]: { ...historyItem, messages: [{ role: 'user', text: 'A previous message' }] },
    '/api/chat/fixture-chat': chat,
    '/api/settings': { devices: [], maxDevices: 2 },
    '/api/power': { awake: 'off', temperature: {}, shutdown: {}, lidClosed: false, lidSleepDisabled: false },
    '/api/power/vitals': { battery: 59, onAC: true, temperature: { batteryC: 30.7 }, limits: { batteryPercent: 20, temperatureC: 45 }, alerts: [] },
    '/api/chat/options': { home: '/tmp', defaultTool: 'codex', tools: { codex: { label: 'Codex', defaults: { model: 'model-0' }, settings: [{ key: 'model', label: 'Model', default: 'model-0', choices }] } } },
    '/api/files/places': { home: '/tmp', roots: ['/tmp'], pinned: [] },
    '/api/files/list': { path: '/tmp', parent: '/', breadcrumbs: [{ name: 'tmp', path: '/tmp' }], entries: [], total: 0 },
  };
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body = ''; for await (const chunk of req) body += chunk;
      chatCreates.push(JSON.parse(body));
      return json(chat);
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') terminalCreates++;
    if (req.method === 'POST' && url.pathname.endsWith('/message')) messagePosts++;
    return json(routes[url.pathname] ?? {});
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
    if (msg.t === 'in') terminalInputs++;
  });
  const isClaude = req.url.endsWith('/claude-fixture');
  ws.send(JSON.stringify(req.url.startsWith('/ws/chat/') ? { t: 'hello', chat: isClaude ? claudeChat : chat, events: isClaude ? [] : chatEvents } : { t: 'out', d: '\x1b[2J\x1b[HQuestion\r\n\r\nChoose an option\r\n\r\n> 1. First option\r\n  2. Second option\r\n  3. Last option\r\n\r\nUp / Down to choose, Enter to confirm\r\n' }));
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  // Emulate the keyboard changing only the visual viewport, plus Safari panning
  // the page. A normal setViewportSize alone misses both of these failure modes.
  await context.addInitScript(() => {
    const viewport = new EventTarget();
    let state = {};
    for (const [key, fallback] of Object.entries({ height: () => innerHeight, width: () => innerWidth, offsetTop: () => 0, offsetLeft: () => 0, scale: () => 1 })) {
      Object.defineProperty(viewport, key, { get: () => state[key] ?? fallback() });
    }
    Object.defineProperty(window, 'visualViewport', { value: viewport });
    window.setTestViewport = (next) => { state = next; viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => active()?.online && document.querySelector('.st-sheet'));
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function inViewport(selector, { aboveStatus = false } = {}) {
    const box = await page.locator(selector).boundingBox();
    const bounds = await page.evaluate((above) => ({ top: visualViewport.offsetTop + (above ? 0 : document.getElementById('macStatus').offsetHeight), bottom: visualViewport.offsetTop + visualViewport.height, width: innerWidth }), aboveStatus);
    assert.ok(box && box.height > 0, `${selector} has no visible area`);
    assert.ok(box.x >= -1 && box.x + box.width <= bounds.width + 1 && box.y >= bounds.top - 1 && box.y + box.height <= bounds.bottom + 1,
      `${selector} is clipped: ${JSON.stringify({ box, bounds })}`);
  }
  const sizes = [[320, 568], [360, 640], [375, 667], [390, 844], [393, 852], [412, 915], [430, 932], [568, 320], [844, 390], [768, 1024], [1024, 768], [1280, 720], [1440, 900], [1920, 1080]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => setTestViewport({}));
    await settle();
    for (const selector of ['#app', '#inputBar', '#keyNav', '#terms']) await inViewport(selector);
    await page.locator('#keyMore').click();
    await inViewport('#keyTools');
    await page.locator('#keyTools .key').last().scrollIntoViewIfNeeded();
    await inViewport('#keyTools .key:last-child');
    await page.locator('#keyMore').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}x${height}: horizontal overflow`);
  }
  await page.setViewportSize({ width: 393, height: 852 });
  await page.locator('#cmd').focus();
  for (const geometry of [{ height: 420, offsetTop: 0 }, { height: 300, offsetTop: 180 }, { height: 240, offsetTop: 220 }]) {
    await page.evaluate((g) => setTestViewport(g), geometry);
    await settle();
    for (const selector of ['#app', '#terms', '#inputBar', '#keyNav']) await inViewport(selector);
    await page.locator('#keyMore').click();
    await inViewport('#keyTools');
    await page.locator('#keyTools .key').last().scrollIntoViewIfNeeded();
    await inViewport('#keyTools .key:last-child');
    await page.locator('#keyMore').click();
  }
  await page.evaluate(() => setTestViewport({}));
  await page.locator('#cmd').evaluate((node) => node.blur());
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => setTestViewport({ height: 320, offsetTop: 160 }));
  await settle();
  await inViewport('.st-sheet');
  const logout = page.locator('[data-act="logout"]');
  await logout.scrollIntoViewIfNeeded();
  await inViewport('[data-act="logout"]');
  await page.locator('.st-close').click();
  await page.evaluate(() => setTestViewport({}));
  await page.locator('[data-view="files"]').click();
  await page.waitForSelector('.fx-root:not([hidden])');
  await page.evaluate(() => setTestViewport({ height: 320, offsetTop: 160 }));
  await settle();
  await inViewport('.fx-root');
  await page.evaluate(() => window.pocketDev.overlays.closeAll());
  await page.evaluate(() => setTestViewport({}));
  await page.locator('[data-view="chat"]').click();
  await page.locator('.chat-new-btn').click();
  await page.waitForSelector('.chat-start');
  await page.evaluate(() => setTestViewport({ height: 320, offsetTop: 160 }));
  await settle();
  await inViewport('.chat');
  await inViewport('.chat-start');
  await page.locator('.chat-chip[data-key="model"]').click();
  await page.locator('.chat-pick-opt').last().scrollIntoViewIfNeeded();
  await inViewport('.chat-pick-opt:last-child');
  await page.locator('.chat-pick-opt').last().click();
  await inViewport('.chat-start');
  assert.match(await page.locator('.chat-chip[data-key="model"]').textContent(), /Model 17/);
  await page.evaluate(() => window.pocketDev.overlays.closeAll());
  await page.evaluate(() => setTestViewport({}));
  await page.evaluate(() => window.pocketDevChat.open('fixture-chat'));
  await page.waitForSelector('.chat-submit');
  for (const height of [420, 320]) {
    await page.evaluate((h) => setTestViewport({ height: h, offsetTop: 100 }), height);
    await settle();
    await inViewport('.chat-composer');
    await inViewport('.chat-submit');
    await page.locator('.chat-q-opt').last().scrollIntoViewIfNeeded();
    await inViewport('.chat-q-opt:last-child');
    await page.locator('.chat-q-opt').last().click();
    assert.equal(await page.locator('.chat-submit').isEnabled(), true);
  }
  await page.evaluate(() => setTestViewport({}));
  await page.getByRole('link', { name: 'Fixture plan', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.fx-pbody pre')?.textContent.includes('Scoped repository access'));
  assert.equal(await page.locator('.fx-ptitle').textContent(), 'ROLE_ACCESS_PLAN.md');
  assert.equal(await page.locator('.fx-root').evaluate((node) => getComputedStyle(node).zIndex), '60', 'the file viewer must open above Chat');
  await inViewport('.fx-root');
  await page.evaluate(() => window.pocketDev.overlays.close('files'));
  await page.waitForSelector('.fx-root[hidden]', { state: 'attached' });
  assert.equal(await page.locator('.chat').isVisible(), true, 'closing the file returns to the conversation');
  await page.evaluate(() => setTestViewport({ height: 320, offsetTop: 100 }));
  if (process.env.RESPONSIVE_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.RESPONSIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.RESPONSIVE_SCREENSHOT_DIR, 'chat-short-screen.png') });
    await page.evaluate(() => window.pocketDev.overlays.closeAll());
    await page.evaluate(() => setTestViewport({ height: 300, offsetTop: 180 }));
    await settle();
    await page.screenshot({ path: path.join(process.env.RESPONSIVE_SCREENSHOT_DIR, 'terminal-short-screen.png') });
  }
  await page.evaluate(() => setTestViewport({}));
  await page.evaluate(() => window.pocketDevChat.open('fixture-chat'));
  await page.waitForSelector('.chat-submit');
  await page.locator('.chat-input').fill('Keep my Codex draft');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('.chat-send').isDisabled(), true);
  assert.equal(await page.locator('.chat-card').isVisible(), false);
  // The question finishes and a queued message arrives while the phone sleeps.
  Object.assign(chat, { status: 'running', runningSince: Date.now(), pending: false, pendingId: null, queued: 1 });
  question.resolution = { cancelled: true };
  chatEvents.push({ id: 'queued-1', seq: 2, type: 'user-text', text: 'Already queued on the Mac, with a long follow-up that stays shortened beside the composer until the agent picks it up. '.repeat(8), queued: true });
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.chat-conn').hidden);
  assert.equal(await page.locator('.chat-card').isVisible(), false, 'completed question must not reappear after wake');
  assert.equal(await page.locator('.chat-input').inputValue(), 'Keep my Codex draft');
  assert.match(await page.locator('.chat-queue').getAttribute('aria-label'), /Codex queued messages/);
  assert.equal(await page.locator('.chat-log .chat-user-queued').count(), 0);
  await page.evaluate(() => setTestViewport({ height: 320, offsetTop: 100 }));
  await settle();
  await inViewport('.chat-queue');
  await inViewport('.chat-composer');
  const queueTop = (await page.locator('.chat-queue').boundingBox()).y;
  await page.locator('.chat-log-scroll').evaluate((node) => { node.scrollTop = 0; });
  await settle();
  assert.equal((await page.locator('.chat-queue').boundingBox()).y, queueTop, 'queued messages stay pinned while the conversation scrolls');
  assert.ok(await page.locator('.chat-queue-preview').evaluate((node) => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'), 'long previews are visually truncated');
  await page.evaluate(() => setTestViewport({}));
  await context.setOffline(true);
  await page.waitForFunction(() => !document.querySelector('.chat-conn').hidden);
  assert.equal(await page.locator('.chat-send').isDisabled(), true);
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector('.chat-conn').hidden);
  assert.equal(await page.locator('.chat-input').inputValue(), 'Keep my Codex draft');
  await page.evaluate(() => window.pocketDevChat.open('claude-fixture'));
  await page.waitForFunction(() => document.querySelector('.chat-title').textContent === 'Claude fixture' && document.querySelector('.chat-conn').hidden);
  assert.equal(await page.locator('.chat-card').isVisible(), false);
  await page.locator('.chat-input').fill('Keep my Claude draft');
  await page.evaluate(() => window.pocketDevChat.open('fixture-chat'));
  await page.waitForFunction(() => document.querySelector('.chat-conn').hidden);
  assert.equal(await page.locator('.chat-input').inputValue(), 'Keep my Codex draft');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.chat-input')?.value === 'Keep my Codex draft' && document.querySelector('.chat-conn').hidden);
  assert.match(await page.locator('.chat-queue').getAttribute('aria-label'), /Codex queued messages/);
  assert.equal(messagePosts, 0, 'reconnect and reload must never submit drafts or replay queued messages');
  await page.evaluate(() => window.pocketDev.overlays.closeAll());
  await page.waitForSelector('.chat[hidden]', { state: 'attached' });
  await page.locator('#cmd').fill('keep this terminal draft');
  await page.reload();
  await page.waitForFunction(() => active()?.online);
  assert.equal(await page.locator('#cmd').inputValue(), 'keep this terminal draft');
  assert.equal(terminalInputs, 0, 'draft restoration must not execute a terminal command');
  // Cover the actual History -> Continue in chat path, not just opening a chat.
  async function resumeHistory() {
    await page.locator('#resumeBtn').click();
    await page.locator('.hist-card').click();
    await page.waitForSelector('.hist-detail-title');
    await page.locator('.hist-in-chat').click();
  }
  await resumeHistory();
  await page.waitForFunction(() => document.querySelector('.chat-title')?.textContent === 'Question fixture' && document.querySelector('.chat-conn').hidden);
  assert.equal(chatCreates.length, 1);
  assert.deepEqual(chatCreates[0].resume, { sessionId: historyItem.id });
  await page.evaluate(() => window.pocketDev.overlays.closeAll());

  // Reproduce an old live server serving new HTML without the new asset route.
  await page.route('**/connection.js', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
  await page.reload();
  await page.waitForSelector('#clientError:not([hidden])');
  assert.match(await page.locator('#clientErrorText').textContent(), /Restart Pocket Dev/);
  await page.locator('[data-view="chat"]').click();
  assert.match(await page.locator('#clientErrorText').textContent(), /connection code/);
  await resumeHistory();
  await page.waitForSelector('.hist-toast');
  assert.match(await page.locator('.hist-toast').textContent(), /Restart Pocket Dev/);
  assert.equal(chatCreates.length, 1, 'missing dependencies must not create a resumed chat');
  assert.equal(terminalCreates, 0, 'missing dependencies must not create extra terminal sessions');
  await page.unroute('**/connection.js');
  await page.reload();
  await page.waitForFunction(() => active()?.online && typeof window.pocketDevChat?.startFromSession === 'function');
  assert.equal(await page.locator('#clientError').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${sizes.length} phone, landscape, tablet and desktop sizes; keyboard resize/pan; controls and long option lists; wake and Wi-Fi recovery; completed questions cleared; separate Claude/Codex drafts; chat and terminal draft restoration after reload; history-to-chat resume; missing-asset recovery; no replayed input. No page errors.`);
} finally {
  await browser?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
