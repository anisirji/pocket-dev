import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/network.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.attrs = {}; this.dataset = {}; this.hidden = false; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  after(node) { this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); node.parent = this.parent; }
  setAttribute(k, v) { this.attrs[k] = v; }
  all(tag) { return this.children.flatMap((n) => [...(n.tag === tag ? [n] : []), ...n.all(tag)]); }
  button(label) { return this.all('button').find((b) => b.textContent === label); }
}

// `responses` maps a URL to a status and body for fetch; `timers` run when the test advances them.
function fixture({ responses, storage = new Map(), protocol = 'http:', chat = null, terminal = 'abc123', search = '', hash = '' } = {}) {
  const head = new Element('head'), app = new Element('div'), clientError = new Element('aside'), portsBtn = new Element('button');
  app.append(clientError);
  const byId = { clientError, portsBtn };
  const fetched = [], posted = [], timers = [], assigned = [], replaced = [], history = [];
  const runtime = {
    document: {
      hidden: false, head, createElement: (tag) => new Element(tag), getElementById: (id) => byId[id],
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    location: { protocol, search, hash, pathname: '/', assign: (url) => assigned.push(url), replace: (url) => replaced.push(url) },
    history: { state: null, replaceState: (state, title, url) => history.push(url) },
    URL, URLSearchParams,
    navigator: { onLine: true },
    confirm: () => true,
    fetch: async (url) => {
      fetched.push(url);
      const r = typeof responses[url] === 'function' ? responses[url]() : responses[url];
      return { status: r.status, ok: r.status < 300, json: async () => r.body };
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    window: {
      api: async (method, url, body) => { posted.push({ method, url, body }); return { url: 'http://192.168.1.20:7777/?h=' + 'a'.repeat(64) }; },
      pocketDevChat: { current: () => chat },
      pocketDev: { activeSession: () => terminal },
    },
  };
  vm.createContext(runtime);
  vm.runInContext(source, runtime);
  const banner = app.children[1];
  const runTimers = async () => { const due = timers.splice(0); for (const t of due) t.fn?.(); await settle(); };
  return { runtime, banner, portsBtn, storage, fetched, posted, assigned, replaced, history, timers, runTimers, net: runtime.window.pocketDevNetwork };
}

const connection = (over) => ({ status: 200, body: { route: 'remote', sameNetwork: true, networkKey: 'k1', linked: true, lanUrl: 'http://192.168.1.20:7777', remoteUrl: 'https://pocket.example.com', wifi: true, internet: 'domain', ...over } });

test('with internet access off nothing is offered, and Ports stays', async () => {
  const f = fixture({ responses: { '/api/connection': { status: 404, body: { error: 'Not found' } } } });
  await settle();
  assert.equal(f.banner.hidden, true);
  assert.equal(f.portsBtn.hidden, false);
  const section = new Element('section');
  f.net.mount(section);
  await settle();
  assert.equal(section.hidden, true);
  assert.equal(section.children.length, 0);
});

test('on the internet link next to the Mac: the prompt, Not now per network, and Switch minting the handoff at tap time', async () => {
  let current = connection();
  const f = fixture({ responses: { '/api/connection': () => current }, chat: 'chat42' });
  await settle();
  assert.equal(f.banner.hidden, false);
  assert.match(f.banner.children[0].textContent, /same Wi-Fi as your Mac/);
  assert.equal(f.posted.length, 0, 'no handoff token until the tap');
  f.banner.button('Not now').onclick();
  assert.equal(f.banner.hidden, true);
  assert.equal(f.storage.get('pd.net.notNow.k1'), '1');
  await f.net.check();
  assert.equal(f.banner.hidden, true, 'dismissed for this network');
  current = connection({ networkKey: 'k2' });
  await f.net.check();
  assert.equal(f.banner.hidden, false, 'another network asks again');
  f.banner.button('Switch').onclick();
  await settle();
  assert.equal(JSON.stringify(f.posted), JSON.stringify([{ method: 'POST', url: '/api/handoff', body: { direction: 'to-lan' } }]));
  assert.deepEqual(f.assigned, ['http://192.168.1.20:7777/?h=' + 'a'.repeat(64) + '#chat=chat42']);
  current = connection({ sameNetwork: null, networkKey: 'k3' });
  await f.net.check();
  assert.equal(f.banner.hidden, true, 'an unknown hint offers nothing');
  current = connection({ sameNetwork: false, networkKey: 'k4' });
  await f.net.check();
  assert.equal(f.banner.hidden, true);
});

test('Settings shows both addresses; only the other route has a working Switch button', async () => {
  const f = fixture({ responses: { '/api/connection': connection({ sameNetwork: false }) } });
  const section = new Element('section');
  f.net.mount(section);
  await settle();
  assert.equal(section.hidden, false);
  assert.equal(section.children[1].textContent, 'Connected over the internet');
  assert.equal(section.button('Switch to local').disabled, false);
  assert.equal(section.button('Switch to remote').disabled, true);
  assert.equal(section.button('Link this phone').disabled, true, 'a phone on the internet address already has its cookie');
  await section.button('Switch to local').onclick();
  await settle();
  assert.equal(f.assigned[0], 'http://192.168.1.20:7777/?h=' + 'a'.repeat(64) + '#terminal=abc123');
  f.posted.length = 0;
  await section.button('Turn off internet access').onclick();
  assert.equal(JSON.stringify(f.posted), JSON.stringify([{ method: 'POST', url: '/api/handoff', body: { direction: 'to-lan' } }, { method: 'PUT', url: '/api/network', body: { internet: { kind: 'off' } } }]), 'the switch link is minted before the link closes');
  assert.equal(f.assigned[1], 'http://192.168.1.20:7777/?h=' + 'a'.repeat(64) + '#terminal=abc123', 'the internet link is closing, so the phone moves to Wi-Fi with its login');
});

test('on Wi-Fi the internet link is remembered, and a Mac out of reach for five seconds offers it', async () => {
  const f = fixture({ responses: { '/api/connection': connection({ route: 'local', sameNetwork: null, networkKey: null }), '/api/status': { status: 503, body: {} } }, protocol: 'http:' });
  await settle();
  assert.equal(f.storage.get('pd.net.remoteUrl'), 'https://pocket.example.com');
  assert.equal(f.banner.hidden, true, 'a linked phone on Wi-Fi is not prompted');
  assert.equal(f.banner.hidden, true);
  f.net.socket(false);
  for (let i = 0; i < 4; i++) {
    assert.equal(f.timers.at(-1)?.ms, 1000);
    await f.runTimers();
    assert.equal(f.banner.hidden, true, `still probing after ${i + 1} failures`);
  }
  await f.runTimers();
  assert.equal(f.banner.hidden, false);
  assert.match(f.banner.children[0].textContent, /Can’t reach your Mac on Wi-Fi/);
  assert.equal(f.fetched.filter((u) => u === '/api/status').length, 5);
  f.banner.button('Switch to remote').onclick();
  assert.deepEqual(f.assigned, ['https://pocket.example.com#terminal=abc123']);
  f.net.socket(true);
  await settle();
  assert.equal(f.banner.hidden, true, 'a socket that comes back withdraws the offer');
  assert.equal(f.fetched.filter((u) => u === '/api/connection').length, 2, 'a reconnect re-checks the route');
});

test('a probe that reaches the Mac stops without an offer', async () => {
  const f = fixture({ responses: { '/api/connection': connection({ route: 'local', sameNetwork: null, networkKey: null }), '/api/status': { status: 200, body: {} } } });
  await settle();
  f.net.socket(false);
  await f.runTimers();
  assert.equal(f.timers.length, 0);
  assert.equal(f.banner.hidden, true);
});

test('Wi-Fi access off hides Ports and the Connection section', async () => {
  const f = fixture({ responses: { '/api/connection': connection({ wifi: false, lanUrl: null, sameNetwork: null, networkKey: null }) } });
  const section = new Element('section');
  f.net.mount(section);
  await settle();
  assert.equal(f.portsBtn.hidden, true);
  assert.equal(section.hidden, true);
  assert.equal(f.banner.hidden, true);
});

test('on Wi-Fi without a cookie for the internet address: the link prompt, Not now per hostname, and Link at tap time', async () => {
  let current = connection({ route: 'local', sameNetwork: null, networkKey: null, linked: false });
  const f = fixture({ responses: { '/api/connection': () => current } });
  await settle();
  assert.equal(f.banner.hidden, false);
  assert.match(f.banner.children[0].textContent, /Link this phone to pocket\.example\.com/);
  assert.equal(f.posted.length, 0);
  f.banner.button('Not now').onclick();
  assert.equal(f.storage.get('pd.net.linkNotNow.pocket.example.com'), '1');
  await f.net.check();
  assert.equal(f.banner.hidden, true, 'dismissed for this hostname');
  current = connection({ route: 'local', sameNetwork: null, networkKey: null, linked: false, remoteUrl: 'https://new-words.trycloudflare.com' });
  await f.net.check();
  assert.equal(f.banner.hidden, false, 'a new Quick link hostname asks again');
  const section = new Element('section');
  f.net.mount(section);
  await settle();
  assert.match(section.children[4].children[0].children[1].textContent, /Not linked yet/);
  assert.equal(section.button('Link this phone').disabled, false);
  f.banner.button('Link').onclick();
  await settle();
  assert.equal(JSON.stringify(f.posted), JSON.stringify([{ method: 'POST', url: '/api/handoff', body: { direction: 'to-remote' } }]));
  assert.equal(f.assigned[0], 'http://192.168.1.20:7777/?h=' + 'a'.repeat(64) + '#terminal=abc123');
  current = connection({ route: 'local', sameNetwork: null, networkKey: null, linked: true });
  await f.net.check();
  assert.equal(f.banner.hidden, true);
  assert.match(section.children[4].children[0].children[1].textContent, /Linked to pocket\.example\.com/);
  assert.equal(section.button('Link this phone').disabled, true);
});

test('landing on the internet address right after linking goes back to Wi-Fi with the same view, once', async () => {
  const f = fixture({ responses: { '/api/connection': connection({ sameNetwork: false }) }, search: '?linked=1', hash: '#chat=chat42' });
  await settle();
  assert.deepEqual(f.history, ['/#chat=chat42'], 'the marker is dropped from the address bar');
  assert.deepEqual(f.replaced, ['http://192.168.1.20:7777#chat=chat42']);
  assert.equal(f.banner.hidden, true);
  const stranded = fixture({ responses: { '/api/connection': connection({ sameNetwork: false, lanUrl: null }) }, search: '?linked=1' });
  await settle();
  assert.deepEqual(stranded.replaced, [], 'without a Wi-Fi address there is nowhere to go back to');
  assert.match(stranded.banner.children[0].textContent, /Linked\. This phone now opens pocket\.example\.com/);
  stranded.banner.button('OK').onclick();
  assert.equal(stranded.banner.hidden, true);
  await stranded.net.check();
  assert.equal(stranded.replaced.length, 0, 'the return happens at most once');
});
