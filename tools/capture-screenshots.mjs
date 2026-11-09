#!/usr/bin/env node
// Captures the documentation screenshots from the real app: node tools/capture-screenshots.mjs [--only 01,02,...]
// Needs Google Chrome and the repository's node_modules. Everything runs against throwaway servers with demo data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Tab } from './capture-lib.mjs';
import { demoServer, cleanupBag, DEMO_IP } from './capture-stack.mjs';
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
  return { replace: replace.filter(([a]) => a && a.length > 2), regex: true, forbid: [...real, ...(os.networkInterfaces().en0 ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address)], demoIp: DEMO_IP };
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
  if (want('10') || want('11') || want('12')) {
    await open(); await tab.click('#settingsBtn'); await tab.settle();
    if (want('10')) await tab.shot(out('10-settings.png'));
    if (want('12')) { await tab.eval(`[...document.querySelectorAll('h2,h3,.sec-title,div')].find((e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === 'POWER')?.scrollIntoView({ block: 'start' })`); await pause(300); await tab.shot(out('12-power.png')); }
    if (want('11')) { await tab.clickText('Device health'); await tab.settle(); await pause(800); await tab.shot(out('11-health.png')); }
  }
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
finally { await chrome?.close(); await bag.run(); process.exit(process.exitCode ?? 0); }
