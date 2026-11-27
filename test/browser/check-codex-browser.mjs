// Settings and notifications against an isolated server and native-protocol fixture.
// Real browser automation through the installed Codex is tested separately in test/native/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { startServer, until, pause } from '../helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cleanups = [], t = { after: (fn) => cleanups.push(fn) };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-browser-ui-'));
let browser, fixture;
try {
  const socketPath = path.join(root, 'codex.sock'), requests = [];
  fixture = http.createServer();
  const wss = new WebSocketServer({ server: fixture });
  let currentThread, client, sequence = 0, holdClose = false, finishClose;
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const message = JSON.parse(raw); requests.push(message);
    if (!message.method || message.id == null) return;
    const reply = (result) => ws.send(JSON.stringify({ id: message.id, result }));
    if (message.method === 'initialize') return reply({ userAgent: 'isolated browser UI fixture' });
    if (message.method === 'model/list') return reply({ data: [] });
    if (message.method === 'config/read') return reply({ config: {} });
    if (message.method === 'mcpServerStatus/list') return reply({ data: [], nextCursor: null });
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      currentThread = message.params.threadId || `fixture-${++sequence}`; client = ws;
      return reply({ thread: { id: currentThread }, model: 'fixture', sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false } });
    }
    if (message.method === 'turn/start') return reply({ turn: { id: `turn-${sequence}` } });
    if (message.method === 'mcpServer/tool/call' && message.params.tool === 'browser_close' && holdClose) { finishClose = () => reply({}); return; }
    reply({});
  }));
  await new Promise((resolve) => fixture.listen(socketPath, resolve));
  cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => fixture.close(resolve)); });
  const server = await startServer(t, { env: { POCKET_DEV_CODEX: process.execPath, POCKET_DEV_CODEX_SOCKET: socketPath } });
  const login = await server.login();
  const api = (method, endpoint, body) => server.request(method, endpoint, { body, cookie: login.cookie });
  const options = (await api('GET', '/api/chat/options')).data;
  assert.ok(options.tools.codex.settings.find((setting) => setting.key === 'browser').choices.some((choice) => choice.value === 'isolated'), 'installed optional browser tools are available');
  assert.equal((await api('POST', '/api/chat', { tool: 'codex', cwd: server.home, settings: { browser: 'isolated' } })).status, 400, 'browser access needs explicit confirmation');
  const chat = (await api('POST', '/api/chat', { tool: 'codex', cwd: server.home })).data;
  assert.equal(chat.settings.browser, 'off');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = login.cookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  await context.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${server.base}/#chat=${chat.id}`);
  const browserChip = page.locator('.chat-convo-head .chat-chip[data-key="browser"]');
  holdClose = true;
  await browserChip.waitFor(); await browserChip.click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('.chat-pick-opt[data-value="isolated"]').click();
  assert.equal((await api('GET', `/api/chat/${chat.id}`)).data.settings.browser, 'off', 'cancel keeps browser access off');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.chat-pick-opt[data-value="isolated"]').click();
  await until(async () => (await api('GET', `/api/chat/${chat.id}`)).data.settings.browser === 'isolated');
  assert.equal(requests.some((request) => request.method === 'turn/start'), false, 'changing settings never sends a prompt');

  const second = await context.newPage(); second.on('pageerror', (error) => errors.push(String(error)));
  const liveHello = new Promise((resolve) => second.on('websocket', (ws) => { if (ws.url().endsWith('/ws/notifications')) ws.on('framereceived', ({ payload }) => { if (JSON.parse(String(payload)).t === 'hello') resolve(); }); }));
  await second.goto(server.base); await liveHello;
  await api('POST', `/api/chat/${chat.id}/message`, { text: 'Local fixture task' });
  await until(() => requests.some((request) => request.method === 'turn/start'));
  assert.equal((await api('PATCH', `/api/chat/${chat.id}`, { settings: { browser: 'off' } })).status, 409, 'running tasks cannot have browser access changed');
  const started = requests.find((request) => request.method === 'thread/start');
  assert.equal(started.params.config['mcp_servers.pocket_dev_browser'].enabled, true);
  client.send(JSON.stringify({ method: 'turn/completed', params: { threadId: currentThread, turn: { id: 'turn-1', status: 'completed' } } }));
  await until(async () => (await api('GET', `/api/chat/${chat.id}`)).data.activity === 'completed');
  await until(async () => await page.locator('.pd-alert:visible').count() + await second.locator('.pd-alert:visible').count() === 1);
  await pause(200);
  assert.equal(await page.locator('.pd-alert:visible').count() + await second.locator('.pd-alert:visible').count(), 1, 'same task alerts once across tabs');
  await page.reload(); await second.reload(); await pause(300);
  assert.equal(await page.locator('.pd-alert:visible').count() + await second.locator('.pd-alert:visible').count(), 0, 'reconnecting never replays a completed task');

  await browserChip.waitFor(); await browserChip.click();
  const disabledResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/chat/${chat.id}`));
  await page.locator('.chat-pick-opt[data-value="off"]').click();
  await until(() => Boolean(finishClose));
  const blocked = await api('POST', `/api/chat/${chat.id}/message`, { text: 'Must not run while browser access changes' });
  assert.equal(blocked.status, 409); assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1, 'no prompt races with browser shutdown');
  finishClose();
  assert.equal((await disabledResponse).status(), 200);
  await until(async () => (await api('GET', `/api/chat/${chat.id}`)).data.settings.browser === 'off');
  assert.ok(requests.some((request) => request.method === 'mcpServer/tool/call' && request.params.tool === 'browser_close'), 'disabling closes the owned browser');
  await api('POST', `/api/chat/${chat.id}/message`, { text: 'Another local fixture task' });
  await until(() => requests.some((request) => request.method === 'thread/resume'));
  assert.equal(requests.find((request) => request.method === 'thread/resume').params.config['mcp_servers.pocket_dev_browser'].enabled, false);
  assert.ok(requests.some((request) => request.method === 'mcpServerStatus/list'), 'disabled access is checked before sending');
  const fresh = (await api('POST', '/api/chat', { tool: 'codex', cwd: server.home })).data;
  assert.equal(fresh.settings.browser, 'off', 'new chats never inherit browser consent');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone page has no horizontal overflow');
  assert.deepEqual(errors, []);
  console.log('PASS personal browser consent, safe defaults, busy guard, disabling, cross-tab notification deduplication and reconnect at 390×844');
} finally {
  await browser?.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
  fs.rmSync(root, { recursive: true, force: true });
}
