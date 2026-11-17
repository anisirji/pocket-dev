// Real Chrome check of the model dropdown at the top of a chat, at phone size with touch emulation, against a throwaway
// server with stand-in engines. A fourth engine is added to the engine list the page loads, to prove the list follows the
// server instead of a fixed number. Screenshots go to ENGINE_DROPDOWN_SHOTS when set.
// Needs Playwright: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chrome
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, pause } from '../test/helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'helpers', 'fake-agy.mjs');
const shots = process.env.ENGINE_DROPDOWN_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const missingClaude = path.join(os.tmpdir(), 'pocket-dev-no-such-claude');

const cleanups = [];
const s = await startServer({ after: (fn) => cleanups.push(fn) }, { env: { POCKET_DEV_AGY: FAKE, POCKET_DEV_CODEX: FAKE, POCKET_DEV_CLAUDE: missingClaude } });
const A = await s.login();
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); console.log(ok ? 'ok  ' : 'FAIL', what); };
try {
  const chat = await s.request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'antigravity', cwd: s.home } });
  await s.request('POST', `/api/chat/${chat.data.id}/message`, { cookie: A.cookie, body: { text: 'hello' } });
  await pause(1500);
  const browser = await chromium.launch({ executablePath: chrome });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const [name, value] = A.cookie.split('=');
  await ctx.addCookies([{ name, value, url: s.base }]);
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
  await page.mouse.click(89, 62);
  await pause(1000);
  await page.locator('text=hello').first().click();
  await pause(1500);

  const dd = page.locator('.chat-engine-dd');
  check(await dd.count() === 1, 'the dropdown is on the chat screen');
  const box = await dd.boundingBox();
  const strip = await page.locator('#macStatus').boundingBox();
  const title = await page.locator('.chat-head-row').boundingBox();
  check(box.height >= 44, `the dropdown is at least 44 px tall (${box.height})`);
  check(box.width >= 390 - 40, `the dropdown is full width (${box.width})`);
  check(box.y >= strip.y + strip.height - 1, 'it sits under the Mac status strip');
  check(box.y + box.height <= title.y + 1, 'it sits above the title row, not over it');
  check(/Antigravity/.test(await dd.innerText()), 'it names the current engine');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
  if (shots) await page.screenshot({ path: path.join(shots, '1-closed.png') });

  await dd.click();
  await pause(400);
  const items = page.locator('.chat-switch-item');
  check(await items.count() === 4, `the open list shows four engines (${await items.count()})`);
  const notes = await page.locator('.chat-switch-item .chat-switch-note').allInnerTexts();
  check(notes.includes('This chat') && notes.includes('Not installed'), `current and missing engines are marked (${notes.join(' | ')})`);
  check((await items.evaluateAll((n) => n.every((x) => x.getBoundingClientRect().height >= 44))), 'every row is at least 44 px tall');
  check(await page.evaluate(() => [...document.querySelectorAll('.chat-switch-item')].every((b) => !b.disabled)), 'no row is disabled');
  if (shots) await page.screenshot({ path: path.join(shots, '2-open.png') });

  await items.filter({ hasText: 'Not installed' }).click();
  await pause(300);
  const helpText = await page.locator('.chat-engine-menu').innerText();
  check(/not installed on your computer/.test(helpText) && /npm install -g @anthropic-ai\/claude-code/.test(helpText) && /pocket-dev setup/.test(helpText), 'a missing engine shows its install commands');
  if (shots) await page.screenshot({ path: path.join(shots, '3-install-help.png') });
  await page.locator('.chat-switch-back').click();
  await pause(200);
  check(await items.count() === 4, 'back returns to the list');

  await page.keyboard.press('Escape');
  await pause(200);
  check(await page.locator('.chat-engine-menu').count() === 0, 'Escape closes the list');

  await dd.click();
  await page.locator('.chat-switch-item', { hasText: 'codex' }).first().click();
  await pause(1500);
  check(/codex/i.test(await page.locator('.chat-engine-dd').innerText()), 'choosing Codex changes the dropdown');
  check(await page.locator('text=first').count() + await page.locator('text=hello').count() > 0, 'the earlier conversation is still there');
  check((await s.request('GET', `/api/chat/${chat.data.id}`, { cookie: A.cookie })).data.tool === 'codex', 'the server switched the chat to Codex');
  if (shots) await page.screenshot({ path: path.join(shots, '4-switched.png') });
  // With the keyboard open the screen is short: the dropdown shrinks to the badge and sits beside the title.
  await page.setViewportSize({ width: 390, height: 400 });
  await pause(600);
  const small = await page.locator('.chat-engine-dd').boundingBox();
  const heading = await page.locator('.chat-convo-head .chat-title').boundingBox();
  check(small && small.height >= 44 && small.y >= 0, `short screen: the dropdown is still there and 44 px tall (${small?.height})`);
  check(heading.width >= 40, `short screen: the title keeps room (${Math.round(heading.width)} px)`);
  await page.locator('.chat-engine-dd').click();
  await pause(300);
  const list = await page.locator('.chat-engine-menu').boundingBox();
  check(list.x >= 0 && list.x + list.width <= 391, 'short screen: the list opens inside the screen width');
  if (shots) await page.screenshot({ path: path.join(shots, '5-short.png') });
  await page.keyboard.press('Escape');
  check(errors.length === 0, `no page errors ${errors.join(' ')}`);
  await browser.close();
} finally { for (const f of cleanups) await f(); }
if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log('\nPASS: model dropdown');
