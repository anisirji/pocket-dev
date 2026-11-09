// Shared pieces for tools/capture-screenshots.mjs: a tiny Chrome DevTools client and the privacy sanitiser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { freePort, pause } from '../test/helpers/server.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } }); }).on('error', reject);
});

export async function launchChrome() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shots-chrome-'));
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await pause(100); }
  }
  const close = async () => { proc.kill('SIGKILL'); await pause(500); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  return { port, proc, close };
}

// One browser tab. `sanitise` is the config for the in-page cleaner (see sanitiserSource).
export class Tab {
  static async open(chrome, { width = 390, height = 844, mobile = true } = {}) {
    const target = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(JSON.parse(t))); });
      req.on('error', reject); req.end();
    });
    const tab = new Tab(target, chrome);
    await tab.ready();
    await tab.resize(width, height, mobile);
    return tab;
  }
  constructor(target, chrome) { this.target = target; this.chrome = chrome; this.id = 0; this.waiting = new Map(); this.inflight = new Set(); this.lastNet = Date.now(); this.sanitiser = null; }
  async ready() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => { this.ws.on('open', resolve); this.ws.on('error', reject); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.waiting.has(m.id)) { const { resolve, reject } = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? reject(new Error(`${m.error.message}`)) : resolve(m.result); return; }
      if (m.method === 'Network.requestWillBeSent' && ['Fetch', 'XHR', 'Document', 'Script', 'Stylesheet', 'Image'].includes(m.params.type)) { this.inflight.add(m.params.requestId); this.lastNet = Date.now(); this.startedAt ??= new Map(); this.startedAt.set(m.params.requestId, Date.now()); }
      if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { this.inflight.delete(m.params.requestId); this.lastNet = Date.now(); }
    });
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Network.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async resize(width, height, mobile = true) {
    this.size = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text} in ${expression.slice(0, 120)}`);
    return r.result.value;
  }
  async cookie(pair, url) {
    const [name, ...v] = pair.split('=');
    await this.send('Network.setCookies', { cookies: [{ name, value: v.join('='), url }] });
  }
  async clearCookies() { await this.send('Network.clearBrowserCookies'); }
  // Installs the sanitiser so it runs on every document this tab loads, before any app script.
  async install(config) {
    this.config = config;
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: sanitiserSource(config) });
    this.scriptId = identifier;
  }
  async uninstall() { if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }); this.scriptId = null; }
  async goto(url) { await this.send('Page.navigate', { url }); await pause(300); await this.settle(); }
  async settle(quiet = 600, max = 8000) {
    const end = Date.now() + max;
    while (Date.now() < end) {
      // A request open for more than 2 s is a stream (events, sockets), not something to wait for.
      for (const id of [...this.inflight]) if (Date.now() - (this.startedAt?.get(id) ?? 0) > 2000) this.inflight.delete(id);
      if (!this.inflight.size && Date.now() - this.lastNet > quiet) break;
      await pause(100);
    }
    await this.eval('document.fonts.ready.then(() => true)');
    await pause(250);
  }
  async click(selector) {
    const ok = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
    if (!ok) throw new Error(`nothing to click: ${selector}`);
    await pause(200);
  }
  async clickText(text, scope = 'button, a, [role=button], summary, label') {
    const ok = await this.eval(`(() => { const want = ${JSON.stringify(text)}; const list = [...document.querySelectorAll(${JSON.stringify(scope)})].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
      const e = list.find((x) => (x.innerText ?? x.textContent ?? '').trim() === want) || list.find((x) => (x.innerText ?? x.textContent ?? '').trim().startsWith(want)) || list.find((x) => (x.innerText ?? x.textContent ?? '').includes(want)); if (!e) return false; e.click(); return true; })()`);
    if (!ok) throw new Error(`no button with text: ${text}`);
    await pause(250);
  }
  async type(selector, value) {
    await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  // Draws a picture with canvas code (a function body that gets ctx, w, h) and returns PNG bytes.
  async draw(w, h, body) {
    const url = await this.eval(`(() => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const ctx = c.getContext('2d'); (function (ctx, w, h) { ${body} })(ctx, ${w}, ${h}); return c.toDataURL('image/png'); })()`);
    return Buffer.from(url.split(',')[1], 'base64');
  }
  text() { return this.eval('document.body.innerText'); }
  // Scrub, check nothing private is left, then write the PNG.
  async shot(file) {
    await this.settle();
    await this.eval('window.__pdClean && window.__pdClean()');
    await pause(150);
    await this.eval('document.activeElement && document.activeElement.blur && document.activeElement.tagName === "INPUT" && 0');
    const found = await this.eval(`(() => {
      const c = ${JSON.stringify(this.config.forbid)};
      const hay = [document.body.innerText, ...[...document.querySelectorAll('input,textarea')].map((e) => e.value + ' ' + (e.placeholder || '')), ...[...document.querySelectorAll('[title],[aria-label],img[src],a[href]')].map((e) => (e.title || '') + (e.getAttribute('aria-label') || '') + (e.tagName === 'A' ? e.getAttribute('href') : ''))].join('\\n').toLowerCase();
      return c.filter((x) => hay.includes(x.toLowerCase()));
    })()`);
    if (found.length) throw new Error(`PRIVACY: ${path.basename(file)} still shows ${JSON.stringify(found)}`);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

// The in-page cleaner. config: { replace: [[real, generic]...], pathPrefixes, fixed: true } -- a MutationObserver keeps it applied
// while the app repaints, and the volatile Mac status numbers are pinned to fixed text.
function sanitiserSource(config) {
  return `(() => {
  const C = ${JSON.stringify(config)};
  const esc = (s) => s.replace(/[.*+?^$()|[\\]{}\\\\]/g, '\\\\$&');
  const rules = [...C.replace.map(([from, to]) => [new RegExp(esc(from), 'gi'), to]), [/\\b(?:10\\.\\d+|192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+\\b/g, C.demoIp], [/\\b(?:127\\.0\\.0\\.1|localhost):\\d+/g, C.demoIp + ':7681'], ...(C.regexes || []).map(([re, to]) => [new RegExp(re, 'g'), to])];
  const scrub = (s) => { let out = s; for (const [re, to] of rules) out = out.replace(re, to); return out; };
  const walk = (root) => {
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const v = C.exact && C.exact[n.nodeValue.trim()] ? C.exact[n.nodeValue.trim()] : scrub(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
    for (const e of (root.querySelectorAll ? root.querySelectorAll('input,textarea,[title],[aria-label],[placeholder]') : [])) {
      if ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && typeof e.value === 'string') { const v = scrub(e.value); if (v !== e.value) e.value = v; }
      for (const a of ['title', 'aria-label', 'placeholder']) { const x = e.getAttribute(a); if (x) { const v = scrub(x); if (v !== x) e.setAttribute(a, v); } }
    }
  };
  const pin = () => {
    const set = (sel, text) => { const e = document.querySelector(sel); if (e && e.textContent !== text) e.textContent = text; };
    set('#macStatus .ms-cpu', 'CPU 12%'); set('#macStatus .ms-storage', '18.4 GB free'); set('#macStatus .ms-age', 'Updated 2s ago');
    const fixedRows = { 'Processor': '12% in use of 8 cores', 'Disk free': '18.4 GB of 245 GB', 'Pocket Dev delay': '8 ms', 'Name': 'Home Mac' };
    for (const r of document.querySelectorAll('.health-row')) { const l = r.querySelector('.health-label')?.textContent; const v = r.querySelector('.health-value'); if (fixedRows[l] && v && v.textContent !== fixedRows[l]) v.textContent = fixedRows[l]; }
    const st = document.querySelector('#macStatus .ms-state'); if (st && !/Normal|Busy/.test(st.textContent)) st.textContent = 'Normal';
    if (st) st.className = 'ms-state ok';
    for (const e of document.querySelectorAll('#macStatus .ms-item:not(.ms-cpu):not(.ms-storage)')) e.hidden = true;
  };
  let busy = false;
  const clean = () => { if (busy) return; busy = true; try { walk(document.body); pin(); } finally { busy = false; } };
  window.__pdClean = clean;
  const start = () => {
    new MutationObserver(() => { if (!busy) queueMicrotask(clean); }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.append(style);
    clean();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
}
