// Real Chrome check of the Photos and videos / Files menu on the three paperclips and the Files Upload button, at phone
// size with touch emulation, against a throwaway server. The system picker itself (Android's) cannot be driven here: the
// file chooser event is answered by the script, and the accept list the page set before it is what is checked.
// Needs Playwright: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chrome
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, pause } from '../test/helpers/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'helpers', 'fake-agy.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-picker-'));
const pdf = path.join(tmp, 'report.pdf'); fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
const png = path.join(tmp, 'pixel.png'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
const zip = path.join(tmp, 'bundle.zip'); fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));

const cleanups = [];
const s = await startServer({ after: (fn) => cleanups.push(fn) }, { env: { POCKET_DEV_AGY: FAKE, POCKET_DEV_CODEX: FAKE } });
fs.writeFileSync(path.join(s.root, 'no-processes.json'), JSON.stringify({ processes: [] }));
const A = await s.login();
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); console.log(ok ? 'ok  ' : 'FAIL', what); };
try {
  const chat = await s.request('POST', '/api/chat', { cookie: A.cookie, body: { tool: 'antigravity', cwd: s.home } });
  await s.request('POST', `/api/chat/${chat.data.id}/message`, { cookie: A.cookie, body: { text: 'hello' } });
  await pause(1200);
  const browser = await chromium.launch({ executablePath: chrome });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const [name, value] = A.cookie.split('=');
  await ctx.addCookies([{ name, value, url: s.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(s.base); await pause(1500);
  for (let i = 0; i < 10; i++) { const n = page.getByRole('button', { name: /^(Next|Done|Got it|Finish|Start)/i }); if (await n.count()) { await n.first().click().catch(() => {}); await pause(200); } else break; }

  // Opens the menu on `button`, picks `choice`, answers the file chooser with `file`, and reports the accept list used.
  async function choose(button, input, choice, file, label) {
    await button.click(); await pause(250);
    const items = await page.locator('.fc-menu button').allInnerTexts();
    check(items.join('|') === 'Take photo|Photos and videos|Files', `${label}: the menu offers Take photo, Photos and videos and Files (${items.join(' | ')})`);
    await page.screenshot({ path: path.join(tmp, `menu-${label.replace(/ /g, '-')}.png`) });
    const box = await page.locator('.fc-menu button').first().boundingBox();
    check(box.height >= 44, `${label}: touch targets are at least 44px (${box.height}px)`);
    const menuBox = await page.locator('.fc-menu').boundingBox();
    check(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `${label}: the menu fits in 390px (${Math.round(menuBox.x)}..${Math.round(menuBox.x + menuBox.width)})`);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.fc-menu button', { hasText: choice }).click()]);
    const accept = await input.getAttribute('accept');
    const capture = await input.getAttribute('capture');
    check(choice === 'Files' ? !/image\//.test(accept) && /application\/\*/.test(accept) && /\.pdf/.test(accept) : choice === 'Take photo' ? accept === 'image/*' : /^image\/\*,video\/\*$/.test(accept), `${label}: ${choice} sets accept=${accept.slice(0, 40)}…`);
    check(choice === 'Take photo' ? capture === 'environment' : capture === null, `${label}: ${choice} ${choice === 'Take photo' ? 'opens the camera' : 'does not force the camera'} (capture=${capture})`);
    await chooser.setFiles(file);
    await pause(1500);
  }

  // 1. The chat paperclip.
  await page.locator('#viewSwitch [data-view="chat"]').click(); await pause(800);
  await page.locator('.chat-row:not(.chat-computer-row)').first().click(); await pause(1500);
  await choose(page.locator('.chat-attach'), page.locator('.chat-file-input'), 'Files', pdf, 'chat paperclip');
  check(await page.locator('.chat-files').innerText().then((t) => t.includes('report.pdf')), 'chat paperclip: report.pdf is attached and uploaded');
  await choose(page.locator('.chat-attach'), page.locator('.chat-file-input'), 'Photos and videos', png, 'chat paperclip');
  check(await page.locator('.chat-files').innerText().then((t) => t.includes('pixel.png')), 'chat paperclip: pixel.png is attached and uploaded');
  await choose(page.locator('.chat-attach'), page.locator('.chat-file-input'), 'Take photo', png, 'chat paperclip');
  check(!(await page.locator('.chat-notice').isVisible().catch(() => false)), 'chat paperclip: no error notice');
  await page.screenshot({ path: path.join(tmp, 'chat.png') });

  // 2. The terminal paperclip. The chat covers the top bar, so back out of it first.
  await page.locator('.chat-back').click(); await pause(400);
  await page.locator('.chat-close').click(); await pause(600);
  await page.locator('#viewSwitch [data-view="terminal"]').click(); await pause(800);
  await choose(page.locator('#attach'), page.locator('#file'), 'Files', zip, 'terminal paperclip');
  check(fs.readdirSync(path.join(s.home, '.pocket-dev', 'uploads')).some((f) => f.endsWith('bundle.zip')), 'terminal paperclip: bundle.zip reached the server');

  // 3. The Files Upload button.
  await page.locator('#viewSwitch [data-view="files"]').click(); await pause(1200);
  await choose(page.locator('.fx-fab'), page.locator('input[type=file]').last(), 'Files', pdf, 'Files Upload');
  await pause(1500);
  check(fs.existsSync(path.join(s.home, 'report.pdf')), 'Files Upload: report.pdf is in the folder');
  await page.screenshot({ path: path.join(tmp, 'files.png') });
  check(errors.length === 0, `no page errors ${errors.join(' ')}`);
  await browser.close();
  console.log(`screenshots: ${tmp}`);
} finally { for (const f of cleanups) await f(); }
if (problems.length) { console.log(`\nFAILED: ${problems.length}`); process.exit(1); }
console.log('\nPASS: file picker menu on chat, terminal, Files Upload at 390px');
