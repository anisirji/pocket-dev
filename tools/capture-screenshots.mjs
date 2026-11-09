#!/usr/bin/env node
// Captures the documentation screenshots from the real app: node tools/capture-screenshots.mjs [--only 01,02,...]
// Needs Google Chrome and the repository's node_modules. Everything runs against throwaway servers with demo data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Tab } from './capture-lib.mjs';
import { demoServer, demoRoom, cleanupBag, DEMO_IP } from './capture-stack.mjs';
import { pause, until } from '../test/helpers/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_OUT || path.join(HERE, '..', 'docs', 'screenshots');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
fs.mkdirSync(OUT, { recursive: true });
const out = (name) => path.join(OUT, name);

const bag = cleanupBag();
let chrome;
const stubs = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
  return {
    POCKET_DEV_PMSET: write('pmset', `case "$*" in
"-g batt") printf "Now drawing from 'AC Power'\\n -InternalBattery-0 (id=1)\\t87%%; charging; 0:48 remaining present: true\\n";;
"-g assertions") printf "Assertion status system-wide:\\n   PreventUserIdleSystemSleep    0\\n   PreventSystemSleep             0\\n";;
*) printf "System-wide power settings:\\n SleepDisabled 0\\n";;
esac`),
    POCKET_DEV_IOREG: write('ioreg', `case "$*" in
*AppleClamshellState*) echo '"AppleClamshellState" = No';;
*) printf '"Temperature" = 3012\\n"CycleCount" = 143\\n"DesignCycleCount9C" = 1000\\n"AppleRawMaxCapacity" = 5320\\n"DesignCapacity" = 5800\\n';;
esac`),
    POCKET_DEV_TOP: write('top', `printf 'CPU usage: 4.10%% user, 7.90%% sys, 88.00%% idle\\nPhysMem: 9120M used (2100M wired, 1500M compressor), 3200M unused.\\n'`),
    POCKET_DEV_MEMORY_PRESSURE: write('memory_pressure', `echo "System-wide memory free percentage: 41%"`),
    POCKET_DEV_OSASCRIPT: write('osascript', `case "$*" in *thermalState*) echo 0;; *) echo "[]";; esac`),
    POCKET_DEV_UPDATE_CHECK: write('update-check', 'echo idle'),
  };
};

// What must never appear in a picture, and what replaces it on screen.
function privacy(servers) {
  const user = os.userInfo().username, host = os.hostname(), short = host.split('.')[0];
  const paths = new Set();
  for (const s of servers) for (const p of [s.root, s.home]) { paths.add(p); try { paths.add(fs.realpathSync(p)); } catch { /* gone */ } }
  const demo = [...paths].filter((p) => p.endsWith('/home')).flatMap((h) => [[`${h}/projects/demo-app`, '~/projects/demo-app'], [h, '~']]);
  const rest = [...paths].filter((p) => !p.endsWith('/home')).map((p) => [p, '~/.pocket-dev']);
  const real = [...new Set([host, short, user, os.homedir(), os.tmpdir(), '/var/folders'])].filter((x) => x && x.length > 2);
  const replace = [...demo.sort((a, b) => b[0].length - a[0].length), ...rest, [host, 'home-mac.local'], [short, 'home-mac'], [user, 'demo'], [os.homedir(), '~'], ['/private/var/folders', '/tmp'], ['/var/folders', '/tmp']];
  return { replace: replace.filter(([a]) => a && a.length > 2), regex: true, forbid: [...real, ...(os.networkInterfaces().en0 ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address)], demoIp: DEMO_IP, exact: { fake: 'Sonnet' }, regexes: [['done · [\\d.]+s · \\$[\\d.]+', 'done · 24s · $0.18']] };
}

async function main() {
  chrome = await launchChrome();
  const tab = await Tab.open(chrome);
  const logo = await tab.draw(640, 400, `const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#3b82f6'); g.addColorStop(1, '#8b5cf6'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(500, 90, 150, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(110, 380, 120, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 76px -apple-system, Helvetica, Arial'; ctx.textAlign = 'center'; ctx.fillText('Demo App', w / 2, h / 2 + 10);
    ctx.font = '30px -apple-system, Helvetica, Arial'; ctx.fillText('built from a phone', w / 2, h / 2 + 60);`);
  const home = await demoServer(bag, { name: 'Home Mac', repo: true, logo, env: stubs(path.join(os.tmpdir(), `pd-stubs-${process.pid}`)) });
  const config = privacy([home]);
  await tab.install(config);
  const base = home.base;
  const open = async (view) => { await tab.goto(`${base}/`); if (view) await tab.click(`#viewSwitch [data-view=${view}]`); await tab.settle(); };

  if (want('01')) {
    await tab.clearCookies();
    await tab.goto(`${base}/login.html`);
    await tab.shot(out('01-login.png'));
  }
  await tab.cookie(home.cookie, base);
  if (want('02')) {
    for (const s of (await home.call('GET', '/api/sessions')).data) await home.call('DELETE', `/api/sessions/${s.id}`);
    await home.call('POST', '/api/sessions', { cwd: home.demo });
    await open('terminal');
    for (const c of ['clear', 'ls', 'git status -sb', 'npm test']) {
      await tab.type('#cmd', c); await tab.click('#send'); await pause(900);
    }
    await tab.shot(out('02-terminal.png'));
  }
  if (want('03')) {
    await open(); await tab.click('#viewSwitch [data-view=files]'); await tab.eval(`window.openFiles(${JSON.stringify(home.demo)})`); await tab.settle();
    await tab.shot(out('03-files.png'));
  }
  if (want('04')) {
    await open(); await tab.eval(`window.openFile(${JSON.stringify(path.join(home.demo, 'assets', 'logo.png'))})`); await tab.settle(); await pause(800);
    await tab.shot(out('04-files-preview.png'));
  }
  if (want('05') || want('06')) {
    await open('git'); await tab.settle();
    if (want('06')) await tab.shot(out('06-git-history.png'));
    if (want('05')) { await tab.clickText('Changes'); await tab.settle(); await tab.shot(out('05-git-changes.png')); }
  }
  if (want('11') || want('12') || want('13') || want('15')) {
    await open(); await tab.click('#settingsBtn'); await tab.settle();
    if (want('12')) { await tab.eval(`[...document.querySelectorAll('h2,h3,.sec-title,div')].find((e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === 'POWER')?.scrollIntoView({ block: 'start' })`); await pause(300); await tab.shot(out('12-power.png')); }
    if (want('11')) { await tab.clickText('Device health'); await tab.settle(); await pause(800); await tab.shot(out('11-health.png')); }
  }
  if (want('13') || want('15')) {
    await open();
    await tab.eval(`import('/room-screen.js').then((m) => m.openRoom())`); await tab.settle();
    if (want('13')) await tab.shot(out('13-room-start.png'));
    if (want('15')) {
      await tab.clickText('Join a room'); await tab.settle();
      await tab.type('.rs-sheet textarea', '192.168.1.20:7681  K7QM-2XWD'); await pause(400);
      await tab.shot(out('15-room-join.png'));
    }
  }

  await roomShots({ tab, logo, picture: null });
}

async function roomShots({ tab, logo }) {
  if (!['07','08','09','10','14','16','17','18','19','20','21','22','23','24','25'].some(want)) return;
  const picture = await tab.draw(960, 640, `const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1e3a8a'); g.addColorStop(0.55, '#f97316'); g.addColorStop(1, '#fde68a'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff7ed'; ctx.beginPath(); ctx.arc(w * 0.68, h * 0.5, 70, 0, 7); ctx.fill();
    ctx.fillStyle = '#1f2937'; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, h * 0.78); ctx.lineTo(w * 0.22, h * 0.58); ctx.lineTo(w * 0.4, h * 0.74); ctx.lineTo(w * 0.62, h * 0.52); ctx.lineTo(w * 0.85, h * 0.72); ctx.lineTo(w, h * 0.62); ctx.lineTo(w, h); ctx.fill();`);
  const room = await demoRoom(bag, { logo, env: { POCKET_DEV_APPROVAL_MS: '3600000', ...stubs(path.join(os.tmpdir(), `pd-stubs-${process.pid}`)) } });
  const { home, studio, linux } = room;
  const config = privacy(room.all);
  await tab.uninstall(); await tab.install(config);
  await tab.clearCookies();
  const base = home.base;
  await tab.cookie(home.cookie, base);
  const open = async (view) => {
    await tab.goto(`${base}/login.html`); await tab.eval('localStorage.clear(); sessionStorage.clear()');
    await tab.goto(`${base}/`); if (view) await tab.click(`#viewSwitch [data-view=${view}]`); await tab.settle();
  };
  const openRoom = async () => { await tab.eval(`import('/room-screen.js').then((m) => m.openRoom())`); await tab.settle(); };
  const chatRow = async (text) => { const ok = await tab.eval(`(() => { const r = [...document.querySelectorAll('.chat-row')].find((x) => x.innerText.includes(${JSON.stringify(text)})); if (r) r.click(); return !!r; })()`); if (!ok) throw new Error(`no chat row ${text}`); };
  const toLabel = async (name) => { await tab.click('#macStatus .ms-label'); await tab.settle(); await tab.clickText(name, '.mc-row'); await tab.settle(); await pause(600); };
  const send = async (s, chat, text) => (await s.call('POST', `/api/chat/${chat}/message`, { text })).status;
  const waitFor = async (fn, ms = 15000) => until(fn, ms);

  if (want('10')) { await open(); await tab.click('#settingsBtn'); await tab.settle(); await tab.shot(out('10-settings.png')); }
  if (want('14') || want('16')) {
    await open(); await openRoom();
    if (want('16')) await tab.shot(out('16-room-members.png'));
    if (want('14')) { await tab.clickText('Add a device'); await tab.settle(); await pause(500); await tab.shot(out('14-room-add-device.png')); }
  }
  if (want('17')) {
    for (const x of (await home.call('GET', '/api/sessions')).data) await home.call('DELETE', `/api/sessions/${x.id}`);
    await home.call('POST', '/api/sessions', { cwd: home.demo });
    await open(); for (const c of ['clear', 'ls', 'git status -sb']) { await tab.type('#cmd', c); await tab.click('#send'); await pause(700); }
 await tab.click('#macStatus .ms-label'); await tab.settle(); await pause(500); await tab.shot(out('17-switcher.png'));
  }
  if (want('18')) {
    await open(); await toLabel('Studio PC');
    await tab.click('#viewSwitch [data-view=files]'); await tab.eval(`window.openFiles(${JSON.stringify(path.join(studio.home, 'Projects'))})`); await tab.settle(); await pause(600);
    await tab.shot(out('18-remote-files.png'));
  }
  if (want('19')) {
    const t = (s, body) => s.request('POST', '/api/room/tasks', { cookie: s.cookie, body });
    const mk = async (s, title, status, assignee, description) => { const r = await t(s, { title, status, assignee: assignee?.id, description }); if (r.status !== 200) throw new Error(JSON.stringify(r.data)); };
    await mk(home, 'Ship the dark mode toggle', 'doing', home, 'Toggle in the header, remember the choice.');
    await mk(home, 'Write the release notes', 'done', null);
    await mk(studio, 'Render the spring campaign video', 'doing', studio, 'Export at 4K, 30 fps.');
    await mk(linux, 'Fix the staging certificate', 'todo', linux, 'The cert for staging expires on Friday.');
    await mk(home, 'Set up CI for the demo app', 'done', home);
    await until(async () => (await studio.request('GET', '/api/room/tasks', { cookie: studio.cookie })).data.tasks?.length >= 5 || (await studio.request('GET', '/api/room/tasks', { cookie: studio.cookie })).data.length >= 5, 15000);
    await open(); await openRoom(); await tab.clickText('Tasks'); await tab.settle(); await pause(800);
    await tab.shot(out('19-tasks.png'));
  }
  if (want('07')) {
    const id = (await home.call('POST', '/api/chat', { tool: 'claude', cwd: home.demo })).data.id;
    await send(home, id, 'Add a dark mode toggle to the app');
    await waitFor(async () => (await home.call('GET', `/api/chat/${id}`)).data.events.some((e) => /all 12 tests/.test(JSON.stringify(e))));
    await open('chat'); await chatRow('dark mode toggle'); await tab.settle(); await pause(800);
    await tab.click('.chat-edit .chat-fold-head'); await pause(400);
    await tab.shot(out('07-chat.png'));
  }
  if (want('08')) {
    const id = (await home.call('POST', '/api/chat', { tool: 'claude', cwd: home.demo })).data.id;
    await send(home, id, 'Use helpers to write the tests for the settings page in parallel');
    await waitFor(async () => { const e = (await home.call('GET', `/api/chat/${id}`)).data.events; return e.some((x) => x.id === 'toolu_h2' && x.steps >= 1); });
    await open('chat'); await chatRow('Use helpers'); await tab.settle(); await pause(800);
    await tab.click('.chat-work-head'); await pause(500);
    await tab.shot(out('08-chat-agents.png'));
  }
  if (want('09')) {
    const upload = async (s, name, bytes) => {
      const r = await fetch(`${s.base}/api/messages/files`, { method: 'POST', headers: { cookie: s.cookie, 'x-pocket-dev': '1', 'x-filename': name, 'content-type': 'image/png' }, body: bytes });
      if (r.status !== 201) throw new Error(`upload ${r.status}`);
      return (await r.json()).id;
    };
    const say = async (s, text, files = []) => { const r = await s.call('POST', '/api/messages', { text, files }); if (r.status !== 201) throw new Error(JSON.stringify(r.data)); await pause(400); };
    await say(studio, 'Location scout from this morning, golden hour looks perfect', [await upload(studio, 'golden-hour.png', picture)]);
    await say(home, 'Love it. Can you send the 4K export when it is ready?');
    await say(studio, 'Rendering now, about ten minutes.');
    await until(async () => JSON.stringify((await home.call('GET', '/api/messages')).data).includes('golden-hour'), 15000);
    await open('messages'); await tab.click('.mx-row'); await tab.settle(); await pause(900);
    await tab.shot(out('09-messages.png'));
  }
  if (want('20')) {
    const id = (await studio.call('POST', '/api/chat', { tool: 'claude', cwd: path.join(studio.home, 'Projects', 'campaign-site') })).data.id;
    await send(studio, id, 'Add a dark mode toggle to the landing page');
    await waitFor(async () => (await studio.call('GET', `/api/chat/${id}`)).data.events.some((e) => /all 12 tests/.test(JSON.stringify(e))));
    await waitFor(async () => JSON.stringify((await home.request('GET', '/api/room/chats', { cookie: home.cookie })).data).includes('dark mode'), 20000);
    await open(); await openRoom(); await tab.clickText('Room chats'); await tab.settle(); await pause(600);
    await tab.click('.rp-chat'); await tab.settle(); await pause(900);
    await tab.click('.chat-edit .chat-fold-head').catch(() => {}); await pause(300);
    await tab.shot(out('20-room-chats.png'));
  }
  if (want('21') || want('22') || want('23')) {
    fs.mkdirSync(path.join(home.home, 'Downloads', 'old_videos'), { recursive: true });
    fs.writeFileSync(path.join(home.home, 'Downloads', 'old_videos', 'clip-01.mov'), 'x');
    await home.api('PUT', `/modes/${studio.id}`, { mode: 'ask' });
    await home.api('PUT', `/modes/${linux.id}`, { mode: 'read-only' });
    studio.to(home, 'POST', '/api/files/trash', { paths: [path.join(home.home, 'Downloads', 'old_videos')] }).catch(() => {});
    await until(async () => (await home.api('GET', '/approvals')).data.pending.length >= 1, 15000);
  }
  if (want('21')) {
    await open(); await openRoom(); await tab.clickText('Approvals'); await tab.settle(); await pause(600);
    await tab.shot(out('21-approvals.png'));
  }
  if (want('22')) {
    await open(); await openRoom(); await tab.click('.rs-perm summary'); await tab.settle(); await pause(600);
    await tab.clickText('Change'); await tab.settle(); await pause(400);
    await tab.shot(out('22-permissions.png'));
  }
  if (want('23')) {
    const r = await home.api('PUT', `/modes/${linux.id}`, { mode: 'bypass', bypassHours: 2 });
    if (r.status !== 200) throw new Error(`bypass: ${JSON.stringify(r.data)}`);
    for (const x of (await home.call('GET', '/api/sessions')).data) await home.call('DELETE', `/api/sessions/${x.id}`);
    await home.call('POST', '/api/sessions', { cwd: home.demo });
    await open(); for (const c of ['clear', 'ls', 'git status -sb']) { await tab.type('#cmd', c); await tab.click('#send'); await pause(700); }
    await pause(1500);
    await tab.shot(out('23-bypass-banner.png'));
    await home.api('PUT', `/modes/${linux.id}`, { mode: 'ask' });
  }
  if (want('24')) {
    const mine = (await home.call('GET', '/api/settings')).data.currentDeviceId;
    await home.local('POST', '/api/collaborators/enable', { adminDeviceIds: [mine] });
    await open(); await tab.click('#settingsBtn'); await tab.settle();
    await tab.clickText('Invite someone'); await tab.settle(); await pause(600);
    await tab.eval(`[...document.querySelectorAll('h2,h3,.sec-title,div')].find((e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === 'COLLABORATORS')?.scrollIntoView({ block: 'start' })`); await pause(400);
    await tab.shot(out('24-collaborators.png'));
  }
  if (want('25')) {
    const admin = await Tab.open(chrome, { width: 1100, height: 900, mobile: false });
    await admin.install(config);
    await admin.goto(home.admin + '/'); await pause(1500); await admin.settle();
    await admin.clickText('Skip for now').catch(() => {}); await pause(600);
    await admin.shot(out('25-admin.png'));
    admin.close();
  }
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
finally { await chrome?.close(); await bag.run(); process.exit(process.exitCode ?? 0); }
