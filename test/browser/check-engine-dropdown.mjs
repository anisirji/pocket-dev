// Real Chrome check of the Provider and Model pills in a chat's settings row, at phone size with touch emulation, against a
// throwaway server with stand-in engines. A fourth engine is added to the engine list the page loads, to prove the list
// follows the server instead of a fixed number. Screenshots go to ENGINE_DROPDOWN_SHOTS when set.
// Needs Playwright: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chrome
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, pause } from '../helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'helpers', 'fake-agy.mjs');
const shots = process.env.ENGINE_DROPDOWN_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const missingClaude = path.join(os.tmpdir(), 'pocket-dev-no-such-claude');

const cleanups = [];
const s = await startServer({ after: (fn) => cleanups.push(fn) }, { env: { POCKET_DEV_AGY: FAKE, POCKET_DEV_CODEX: FAKE, POCKET_DEV_CLAUDE: missingClaude } });
// Opening a chat looks for programs on the computer that hold its conversation; this run has none.
fs.writeFileSync(path.join(s.root, 'no-processes.json'), JSON.stringify({ processes: [] }));
const A = await s.login();
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); console.log(ok ? 'ok  ' : 'FAIL', what); };
const api = (method, url, body) => s.request(method, url, { cookie: A.cookie, body });
try {
  const chat = await api('POST', '/api/chat', { tool: 'antigravity', cwd: s.home });
  const id = chat.data.id;
  await api('POST', `/api/chat/${id}/message`, { text: 'hello' });
  await pause(1500);
  const browser = await chromium.launch({ executablePath: chrome });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const [name, value] = A.cookie.split('=');
  await ctx.addCookies([{ name, value, url: s.base }]);
  await ctx.addInitScript(() => localStorage.setItem('pd-welcome-shown', '1'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/chat/options', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    data.tools.copilot = { label: 'GitHub Copilot', installed: true, settings: [], defaults: {}, help: { install: [], login: null } };
    await route.fulfill({ response: res, json: data });
  });
  await page.goto(s.base);
  await pause(1500);
  for (let i = 0; i < 10; i++) {
    const next = page.getByRole('button', { name: /^(Next|Done|Got it|Finish|Start)/i });
    if (await next.count()) { await next.first().click().catch(() => {}); await pause(200); } else break;
  }
  await page.locator('[data-view="chat"]').click();
  await pause(1000);
  await page.locator('text=hello').first().click();
  await pause(1500);

  // The pills row: Provider first, then Model, in the existing settings row. No separate control.
  const chips = page.locator('.chat-convo-head .chat-chips');
  const keys = await chips.locator('.chat-chip').evaluateAll((n) => n.map((x) => x.dataset.key));
  check(keys[0] === 'provider' && keys[1] === 'model', `the row starts with Provider then Model (${keys.join(', ')})`);
  check(await page.locator('.chat-engine-row, .chat-model-chip, .chat-engine-dd').count() === 0, 'no separate engine control or row');
  const provider = page.locator('.chat-provider-chip');
  const pbox = await provider.boundingBox();
  check(pbox.x >= 0 && pbox.x + pbox.width <= 390 && await chips.evaluate((n) => n.scrollLeft === 0), `the Provider pill is visible without scrolling (x ${Math.round(pbox.x)}, width ${Math.round(pbox.width)})`);
  check(pbox.height >= 40, `the Provider pill is a normal pill height (${pbox.height})`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
  if (shots) await page.screenshot({ path: path.join(shots, '1-pills.png') });

  // Busy: the reply runs, the Provider pill locks, the Model pill keeps working and says the change waits for the next reply.
  await api('POST', `/api/chat/${id}/message`, { text: 'slow' });
  for (let i = 0; i < 50 && (await api('GET', `/api/chat/${id}`)).data.status !== 'running'; i++) await pause(60);
  await pause(600);
  check(await provider.getAttribute('aria-disabled') === 'true', 'while a reply runs the Provider pill is aria-disabled');
  check(await provider.evaluate((n) => Number(getComputedStyle(n).opacity) < 0.7), 'and visibly dimmed');
  await provider.click({ force: true });
  await pause(300);
  check(await page.locator('.chat-engine-menu').count() === 0, 'tapping it opens no list');
  check(/Stop the reply first/.test(await page.locator('.chat-toast').innerText()), 'it says "Stop the reply first"');
  const modelPill = page.locator('.chat-chip[data-key="model"]');
  check(await modelPill.getAttribute('aria-disabled') === null, 'the Model pill is not disabled while the reply runs');
  await modelPill.click();
  await pause(500);
  check(/Applies to the next reply/.test(await page.locator('.chat-pick-sheet').innerText()), 'the model sheet says "Applies to the next reply"');
  if (shots) await page.screenshot({ path: path.join(shots, '2-model-while-busy.png') });
  await page.locator('.chat-pick-custom input').fill('my-model');
  await page.locator('.chat-pick-custom button').click();
  await pause(800);
  const midRun = (await api('GET', `/api/chat/${id}`)).data;
  check(midRun.settings.model === 'my-model' && midRun.status === 'running', 'the new model is saved and the running reply carries on');
  await api('POST', `/api/chat/${id}/interrupt`);
  for (let i = 0; i < 50 && (await api('GET', `/api/chat/${id}`)).data.status !== 'idle'; i++) await pause(60);
  await pause(700);
  check(await provider.getAttribute('aria-disabled') === null, 'the Provider pill works again once the chat is idle');

  // Idle: step one, the provider list.
  await provider.click();
  await pause(400);
  const rows = page.locator('.chat-switch-item');
  check(await rows.count() === 4, `the provider list shows four engines (${await rows.count()})`);
  const notes = await page.locator('.chat-switch-item .chat-switch-note').allInnerTexts();
  check(notes.some((n) => /This chat/.test(n)) && notes.includes('Not installed'), `current and missing engines are marked (${notes.join(' | ')})`);
  check(await rows.evaluateAll((n) => n.every((x) => x.getBoundingClientRect().height >= 44 && !x.disabled)), 'every row is at least 44 px and none is disabled');
  const menu = await page.locator('.chat-engine-menu').boundingBox();
  check(menu.x >= 0 && menu.x + menu.width <= 391, 'the list opens inside the screen width');
  if (shots) await page.screenshot({ path: path.join(shots, '3-provider-list.png') });
  await rows.filter({ hasText: 'Not installed' }).click();
  await pause(300);
  const helpText = await page.locator('.chat-engine-menu').innerText();
  check(/not installed on your computer/.test(helpText) && /npm install -g @anthropic-ai\/claude-code/.test(helpText) && /pocket-dev setup/.test(helpText), 'a missing engine shows its install commands');
  if (shots) await page.screenshot({ path: path.join(shots, '4-install-help.png') });
  await page.locator('.chat-switch-back').click();
  await page.keyboard.press('Escape');
  await pause(200);
  check(await page.locator('.chat-engine-menu').count() === 0, 'Escape closes the list');

  // Step two: choosing a provider switches and offers its models at once.
  await provider.click();
  await page.locator('.chat-switch-item', { hasText: 'codex' }).first().click();
  await pause(1500);
  check((await api('GET', `/api/chat/${id}`)).data.tool === 'codex', 'the server switched the chat to Codex');
  check(/Model/.test(await page.locator('.chat-pick-sheet').innerText()) && await page.locator('.chat-pick-sheet').isVisible(), 'the model list opens straight away for the new provider');
  if (shots) await page.screenshot({ path: path.join(shots, '5-model-list.png') });
  await page.keyboard.press('Escape');
  await page.locator('.chat-pick-wrap .chat-backdrop').click({ position: { x: 10, y: 10 } }).catch(() => {});
  await pause(500);
  check(/codex/i.test(await page.locator('.chat-provider-chip').innerText()), 'the Provider pill now shows Codex');
  check(await page.locator('text=hello').count() > 0, 'the earlier conversation is still there');
  const restored = (await api('GET', `/api/chat/${id}`)).data;
  check(typeof restored.settings === 'object', 'the new provider has its own settings');

  // Switching back restores the model this provider last used.
  await page.locator('.chat-provider-chip').click();
  await page.locator('.chat-switch-item', { hasText: 'antigravity' }).first().click();
  await pause(1500);
  check((await api('GET', `/api/chat/${id}`)).data.settings.model === 'my-model', 'switching back to Antigravity restores its last model');
  if (shots) await page.screenshot({ path: path.join(shots, '6-back.png') });
  check(errors.length === 0, `no page errors ${errors.join(' ')}`);
  await browser.close();
} finally { for (const f of cleanups) await f(); }
if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log('\nPASS: provider and model pills');
