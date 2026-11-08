import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/macstatus.js', import.meta.url), 'utf8');
const settle = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.attrs = {}; this.hidden = false; this.offsetHeight = 40; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attrs[key] = value; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  cls(name) { return this.all().find((c) => c.className.split(' ').includes(name)); }
  button(text) { return this.all().find((c) => c.tag === 'button' && c.textContent === text); }
}
const healthy = () => ({ sampledAt: 1000, cpu: { usedPercent: 12, cores: 8 }, disk: { freeGB: 42.5, totalGB: 256 },
  memory: { freePercent: 40 }, status: 'normal', level: 'ok', alerts: [] });
const vitals = { battery: 80, onAC: true, charging: false, temperature: { batteryC: 30, thermal: 'nominal' }, limits: { batteryPercent: 20, temperatureC: 40 }, alerts: [] };
function fixture({ response = () => healthy(), offline = false } = {}) {
  let clock = 1000, id = 0, healthOpens = 0, appsOpens = 0;
  const timers = new Map(), calls = [], redirects = [], buzzes = [], styles = new Map();
  const document = { title: 'Pocket Dev', hidden: false, body: new Element('body'), listeners: {},
    createElement: (tag) => new Element(tag), addEventListener(type, fn) { this.listeners[type] = fn; },
    documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } } };
  const window = { innerHeight: 800, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    openHealthSheet: () => { healthOpens++; }, openAppsSheet: () => { appsOpens++; } };
  const schedule = (fn, ms, interval = false) => { timers.set(++id, { fn, ms, due: clock + ms, interval }); return id; };
  const runtime = { window, document, navigator: { onLine: !offline, vibrate: (pattern) => buzzes.push(pattern) },
    Date: class extends Date { static now() { return clock; } },
    location: { replace: (url) => redirects.push(url) }, AbortController,
    ResizeObserver: class { observe() {} },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (key) => timers.delete(key),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: (key) => timers.delete(key),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/vitals')) return { ok: true, status: 200, json: async () => vitals };
      const value = await response(calls.filter((c) => c.url === '/api/performance').length);
      if (value?.httpStatus) return { ok: false, status: value.httpStatus };
      return { ok: true, status: 200, json: async () => value?.bodyPromise || value };
    },
  };
  vm.runInNewContext(source, runtime);
  const advance = async (ms) => {
    const end = clock + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [key, timer] = next;
      clock = timer.due;
      if (timer.interval) timer.due += timer.ms; else timers.delete(key);
      timer.fn(); await settle();
    }
    clock = end; await settle();
  };
  return { document, window, runtime, calls, redirects, buzzes, styles, advance,
    root: document.body.children[0], healthOpens: () => healthOpens, appsOpens: () => appsOpens,
    fire(type) { for (const fn of window.listeners[type] || []) fn(); },
    visibility(hidden) { document.hidden = hidden; document.listeners.visibilitychange(); } };
}

test('CPU and available storage stay visible, refresh every five seconds, and open health details', async () => {
  const f = fixture(); await settle();
  assert.equal(f.root.hidden, false);
  assert.equal(f.root.cls('ms-cpu').textContent, 'CPU 12%');
  assert.equal(f.root.cls('ms-storage').textContent, '42.5 GB free');
  assert.equal(f.root.cls('ms-state').textContent, 'Normal');
  f.root.cls('ms-strip').onclick(); assert.equal(f.healthOpens(), 1);
  await f.advance(5000);
  assert.equal(f.calls.filter((c) => c.url === '/api/performance').length, 2);
  assert.equal(f.calls.filter((c) => c.url.includes('/vitals')).length, 1, 'battery and temperature use the slower cadence');
  assert.equal(f.styles.get('--status-h'), '40px');
});

test('heavy load and low storage raise clear alerts with Open apps where useful', async () => {
  const f = fixture({ response: () => ({ ...healthy(), cpu: { usedPercent: 96 }, disk: { freeGB: 2.1, totalGB: 256 },
    status: 'disk', level: 'critical', alerts: [{ key: 'disk', level: 'critical', text: 'Storage low' }, { key: 'cpu', level: 'warning', text: 'CPU busy' }] }) });
  await settle();
  assert.equal(f.root.cls('ms-state').textContent, 'Storage low');
  assert.equal(f.root.cls('ms-banner').hidden, false);
  assert.match(f.root.cls('ms-storage').className, /crit/);
  f.root.button('Open apps').onclick(); assert.equal(f.appsOpens(), 1);
  f.root.button('Dismiss').onclick();
  assert.equal(f.root.cls('ms-banner').hidden, true);
  assert.equal(f.root.cls('ms-state').textContent, 'Storage low', 'dismissing the banner does not hide the status');
});

test('a stalled JSON body times out, marks values old and recovers on the next check', async () => {
  let release;
  const f = fixture({ response: (n) => n === 2 ? { bodyPromise: new Promise((resolve) => { release = resolve; }) } : healthy() });
  await settle(); await f.advance(13000);
  assert.equal(f.root.cls('ms-state').textContent, 'Mac not responding');
  assert.equal(f.root.className, 'ms-stale');
  assert.match(f.root.cls('ms-age').textContent, /Last reading/);
  assert.equal(f.root.cls('ms-cpu').textContent, 'CPU 12%', 'last values are retained visibly as old');
  assert.match(f.root.cls('ms-text').textContent, /asleep, or disconnected/);
  f.root.button('Check again').onclick(); await settle();
  assert.equal(f.root.cls('ms-state').textContent, 'Normal');
  release({ ...healthy(), cpu: { usedPercent: 99 } }); await settle();
  assert.equal(f.root.cls('ms-cpu').textContent, 'CPU 12%', 'the late response cannot overwrite recovery');
});

test('phone offline is distinguished from a hung Mac and does not poll until online', async () => {
  const f = fixture(); await settle();
  f.runtime.navigator.onLine = false; f.fire('offline');
  assert.equal(f.root.cls('ms-state').textContent, 'Phone offline');
  const before = f.calls.length;
  await f.advance(60000); assert.equal(f.calls.length, before);
  assert.equal(f.root.button('Check again').disabled, true);
  f.runtime.navigator.onLine = true; f.fire('online'); await settle();
  assert.equal(f.root.cls('ms-state').textContent, 'Normal');
});

test('background sleep cancels requests and wake checks immediately without a false frozen state', async () => {
  const f = fixture(); await settle();
  f.visibility(true); const before = f.calls.length;
  await f.advance(120000); assert.equal(f.calls.length, before);
  f.visibility(false);
  assert.equal(f.root.cls('ms-state').textContent, 'Checking Mac…');
  await settle(); assert.equal(f.root.cls('ms-state').textContent, 'Normal');
});

test('missing readings and an older server never appear as zero usage or a frozen Mac', async () => {
  const f = fixture({ response: () => ({ ...healthy(), status: 'unknown', level: 'unknown', cpu: { usedPercent: null }, disk: { freeGB: null } }) });
  await settle();
  assert.equal(f.root.cls('ms-cpu').textContent, 'CPU —');
  assert.equal(f.root.cls('ms-storage').textContent, 'Free —');
  assert.equal(f.root.cls('ms-state').textContent, 'Partial readings');
  const older = fixture({ response: () => ({ httpStatus: 404 }) }); await settle();
  await older.advance(60000);
  assert.equal(older.root.cls('ms-state').textContent, 'Monitoring needs update');
  assert.equal(older.root.cls('ms-banner').hidden, true);
});

test('initial offline and revoked access are reported without claiming the Mac is frozen', async () => {
  const offline = fixture({ offline: true }); await settle();
  assert.equal(offline.calls.length, 0);
  assert.equal(offline.root.cls('ms-state').textContent, 'Phone offline');
  const expired = fixture({ response: () => ({ httpStatus: 403 }) }); await settle();
  assert.deepEqual(expired.redirects, ['/login.html']);
  const before = expired.calls.length;
  await expired.advance(30000); assert.equal(expired.calls.length, before);
});

test('health details do not label missing readings healthy or hide known memory pressure', async () => {
  const code = fs.readFileSync(new URL('../public/health.js', import.meta.url), 'utf8');
  const data = { status: 'good', issues: [], battery: { percent: null, condition: null }, temperature: { batteryC: null, thermal: null },
    limits: { temperatureC: 40, batteryPercent: 20 }, cpu: { usedPercent: null }, disk: { freeGB: null }, memory: null,
    memoryFreePercent: 4, power: { awake: 'off' }, mac: { name: 'Mac', uptimeSec: 100 }, network: [], pocketDev: { version: '1.0.0', uptimeSec: 100, node: 'v22' } };
  const body = new Element('body'); body.appendChild = (node) => body.append(node);
  const runtime = { document: { createElement: (tag) => new Element(tag), body, hidden: false }, window: { pocketDev: { overlays: { open() {} } } },
    fetch: async () => ({ ok: true, status: 200, json: async () => data }), setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(code, runtime);
  runtime.window.openHealthSheet(); await settle();
  assert.equal(body.cls('health-verdict').children[0].textContent, 'Some readings unavailable');
  const memory = body.all().find((row) => row.className === 'health-row' && row.children[0].textContent === 'Memory free');
  assert.equal(memory.children[1].textContent, '4%');
  assert.match(memory.children[1].className, /warn/);
});

test('a server error means readings are unavailable, rather than proof that the Mac stopped responding', async () => {
  const f = fixture({ response: () => ({ httpStatus: 503 }) }); await settle();
  assert.equal(f.root.cls('ms-state').textContent, 'Readings unavailable');
  assert.match(f.root.cls('ms-text').textContent, /Mac replied/);
  const malformed = fixture({ response: () => ({}) }); await settle();
  assert.equal(malformed.root.cls('ms-state').textContent, 'Readings unavailable');
});
