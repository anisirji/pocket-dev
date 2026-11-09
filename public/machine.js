// The machine shim. Loaded first on the main page. It holds which device the phone is working on (this one by default,
// or a room member chosen in the switcher, remembered per phone) and, when a member is chosen, sends the page's requests
// through the front door at /m/<deviceId>/... (see forward.js) so the other scripts do not change: fetch, XMLHttpRequest,
// WebSocket, image/link/media URLs, and the browser storage keys are wrapped here, once.
// The pure parts (PocketMachine) also run under node:test; the browser parts only install when there is a document.
(() => {
  const ID = /^[0-9a-f]{4,64}$/;
  // Paths that always belong to the device the phone is logged in on: its room, login, and its own settings and network.
  const LOCAL_API = /^\/api\/(room|login|logout|devices|local|network|settings|invitations|collaborators)(\/|$)/;
  // What a collaborator-rank device answers to: files and messages (and the status check the page starts with).
  const COLLABORATOR_API = /^\/api\/(files|messages|status|folders)(\/|$)/;
  const GLOBAL_KEYS = new Set(['pd.machine', 'pd.machine.devices']);

  // `input` is a URL string as a page would write it. Same-origin /api/ and /ws/ paths get the /m/<id> prefix; everything
  // else (pages, scripts, other hosts, paths already forwarded, this device's own routes) is returned unchanged.
  function rewriteUrl(id, input, base) {
    if (!id || typeof input !== 'string') return input;
    let url, here;
    try { url = new URL(input, base); here = new URL(base); } catch { return input; }
    if (url.host !== here.host || !/^(https?|wss?):$/.test(url.protocol)) return input;
    if (!/^\/(api|ws)\//.test(url.pathname) || LOCAL_API.test(url.pathname)) return input;
    const forwarded = `/m/${id}${url.pathname}${url.search}${url.hash}`;
    return input.startsWith('/') && !input.startsWith('//') ? forwarded : `${url.protocol}//${url.host}${forwarded}`;
  }

  // Local keys stay exactly as they are so nothing is lost for existing users; a remote device gets its own namespace.
  function storageKey(id, key) {
    return !id || GLOBAL_KEYS.has(key) ? key : `m.${id}:${key}`;
  }

  // What this phone may show for a rank on the device it works on. A collaborator only gets Files and Messages.
  function allowedViews(rank) {
    return rank === 'collaborator' ? ['files', 'messages'] : ['terminal', 'git', 'chat', 'files', 'messages'];
  }

  const rankText = (device) => device.self ? 'This device' : device.rank === 'collaborator' ? 'Collaborator: files and messages' : device.rank === 'admin' ? 'Admin' : 'Owner';
  const stateText = (device) => device.online ? rankText(device) : 'Not answering right now';

  // This device first, then online devices, then the rest by name.
  function sortDevices(devices) {
    return [...devices].sort((a, b) => (!!b.self - !!a.self) || (!!b.online - !!a.online) || String(a.name).localeCompare(String(b.name)));
  }

  // True when a request should not be sent at all: the device would refuse it, and the page treats a refusal on some
  // calls (the status strip) as "logged out". `url` is the path as written by the page.
  function blockedFor(rank, id, url, base) {
    if (!id || rank !== 'collaborator') return false;
    const forwarded = rewriteUrl(id, url, base);
    if (forwarded === url) return false;
    return !COLLABORATOR_API.test(new URL(url, base).pathname);
  }

  // The pages say "the Mac" for the device they run on. On another room device that would be wrong (it may not be a Mac, and
  // it is not the one in the user's hand), so its own name stands in. Used for status text, never for what the user typed.
  function sayFor(name, text) {
    return String(text).replace(/your Mac password/g, `the password for ${name}`).replace(/\b[Tt]he Mac(?=[’']s\b)/g, name)
      .replace(/\b[Tt]he Mac\b/g, name).replace(/\b[Tt]his Mac\b/g, name).replace(/\bMac\b/g, name);
  }

  globalThis.PocketMachine = { sayFor, blockedFor, rewriteUrl, storageKey, allowedViews, rankText, stateText, sortDevices };
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const realFetch = window.fetch.bind(window);
  const proto = Storage.prototype;
  const raw = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem };
  const read = (key) => { try { return raw.get.call(localStorage, key); } catch { return null; } };
  const write = (key, value) => { try { if (value == null) raw.remove.call(localStorage, key); else raw.set.call(localStorage, key, value); } catch {} };

  let id = read('pd.machine');
  if (id && !ID.test(id)) id = null;
  let devices = [];
  try { devices = JSON.parse(read('pd.machine.devices')) || []; } catch {}
  const me = () => devices.find((d) => d.deviceId === id);
  const nameOf = () => me()?.name || 'That device';
  const rank = () => (id && me()?.rank) || 'owner';

  PocketMachine.say = (text) => id ? sayFor(me()?.name || 'the device', text) : text;
  const abs = (url) => rewriteUrl(id, url, location.href);
  const mark = () => {
    const root = document.documentElement;
    if (id) root.dataset.machine = 'remote'; else delete root.dataset.machine;
    root.dataset.rank = rank();
  };
  mark();

  proto.getItem = function (key) { return raw.get.call(this, storageKey(id, String(key))); };
  proto.setItem = function (key, value) { return raw.set.call(this, storageKey(id, String(key)), value); };
  proto.removeItem = function (key) { return raw.remove.call(this, storageKey(id, String(key))); };

  const toUrl = (input) => input instanceof URL ? input.href : input;
  window.fetch = async (input, init) => {
    if (!id) return realFetch(input, init);
    const url = toUrl(input);
    let sent = input;
    if (typeof url === 'string' && blockedFor(rank(), id, url, location.href)) {
      return new Response(JSON.stringify({ error: 'Not available on this device with your access.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (typeof url === 'string') sent = abs(url);
    else if (input instanceof Request) { const next = abs(input.url); if (next !== input.url) sent = new Request(next, input); }
    const res = await realFetch(sent, init);
    return /\/m\/[0-9a-f]+\//.test(res.url) ? checked(res) : res;
  };

  // A forwarded answer of 401 is not "log in again": the pages would send the phone to this device's login for a refusal
  // that came from the other device. Only a 401 on this device itself is a real logout.
  async function checked(res) {
    if (res.status === 502) {
      const body = await res.clone().json().catch(() => null);
      if (body?.deviceId === id) showDown(body.error);
    } else if (res.ok) hideDown();
    if (res.status !== 401) return res;
    const own = await realFetch('/api/room/devices', { cache: 'no-store' }).catch(() => null);
    if (!own || own.status === 401) return res;
    return new Response(JSON.stringify({ error: `${nameOf()} did not accept this request.` }), { status: 403, headers: { 'content-type': 'application/json' } });
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, id ? abs(toUrl(url)) : url, ...rest); };

  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(id ? abs(toUrl(url)) : url, protocols);
      // A socket that never opened may mean the device went away: a plain request finds out and shows the banner.
      if (id) this.addEventListener('close', () => { if (this.readyState !== 1 && !this.opened) probe(); });
      this.addEventListener('open', () => { this.opened = true; });
    }
  };
  let probing = 0;
  function probe() {
    if (Date.now() - probing < 5000) return;
    probing = Date.now();
    window.fetch('/api/status', { cache: 'no-store' }).catch(() => {});
  }

  // Elements the page points at the API (images, downloads, media, frames) go through the same rewrite.
  const patchProp = (Ctor, prop) => {
    const d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d?.set) return;
    Object.defineProperty(Ctor.prototype, prop, { ...d, set(value) { d.set.call(this, id ? abs(String(value)) : value); } });
  };
  [[HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLAnchorElement, 'href'], [HTMLSourceElement, 'src']].forEach(([C, p]) => patchProp(C, p));
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, id && /^(src|href)$/i.test(name) ? abs(String(value)) : value);
  };

  function select(next) {
    write('pd.machine', next);
    // The hash can point at a chat or folder that only exists on the old device.
    location.replace(location.pathname);
  }

  // ---- The switcher: a chip in the header, a sheet with the room's devices, the "not answering" banner. ----
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let chip, sheet, banner;

  function renderChip() {
    if (!chip) return;
    chip.hidden = devices.length < 2 && !id;
    const label = id ? nameOf() : (devices.find((d) => d.self)?.name || 'This device');
    const dot = el('i', `mc-dot${me()?.online === false ? ' off' : ''}`);
    chip.replaceChildren(dot, el('span', 'mc-name', label));
    chip.setAttribute('aria-label', `Working on ${label}. Change device`);
  }

  // Files, Chat and Messages cover the header, and with it the chip. The status strip stays above every screen, so its first
  // word (the device it reports on) is also the way to the switcher.
  function renderLabel() {
    const label = document.querySelector('#macStatus .ms-label');
    if (!label || (devices.length < 2 && !id)) return;
    label.textContent = `${id ? nameOf() : (devices.find((d) => d.self)?.name || 'This device')} ▾`;
    label.classList.add('mc-switch');
    label.setAttribute('role', 'button');
    label.title = 'Change device';
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.ms-label.mc-switch')) return;
    e.stopPropagation(); e.preventDefault();
    openSheet();
  }, true);

  async function loadDevices(live) {
    let body;
    try {
      const res = await realFetch(`/api/room/devices${live ? '?live=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) return;
      body = await res.json();
    } catch { return; }
    devices = body.devices || [];
    write('pd.machine.devices', JSON.stringify(devices));
    // Kicked or left: the remembered device is gone, so go back to this one.
    if (id && !me()) return select(null);
    mark();
    renderChip();
    renderLabel();
    if (sheet && !sheet.hidden) renderSheet();
    applyRank();
  }

  function renderSheet() {
    const list = sheet.querySelector('.mc-list');
    list.replaceChildren(...sortDevices(devices).map((d) => {
      const current = d.self ? !id : d.deviceId === id;
      const row = el('button', `mc-row${current ? ' current' : ''}${d.online ? '' : ' offline'}`);
      row.type = 'button';
      row.disabled = !d.online && !current;
      const text = el('span', 'mc-text');
      text.append(el('b', null, d.self ? `${d.name}` : d.name), el('small', null, stateText(d)));
      row.append(el('i', `mc-dot${d.online ? '' : ' off'}`), text, el('span', 'mc-check', current ? '✓' : ''));
      row.onclick = () => { if (!current) select(d.self ? null : d.deviceId); else closeSheet(); };
      return row;
    }));
  }
  function openSheet() {
    renderSheet();
    sheet.hidden = false;
    loadDevices(true);
  }
  const closeSheet = () => { sheet.hidden = true; };

  function showDown(message) {
    if (!banner) return;
    banner.querySelector('.mc-banner-text').textContent = `${nameOf()} is not answering.`;
    banner.querySelector('.mc-banner-text').title = message || '';
    banner.hidden = false;
  }
  const hideDown = () => { if (banner) banner.hidden = true; };

  // Collaborator rank: only Files and Messages exist on that device, so the others are hidden and the page opens on Files.
  let homeShown = false;
  function applyRank() {
    mark();
    if (!id || rank() !== 'collaborator' || homeShown) return;
    homeShown = true;
    const home = el('div', 'mc-home');
    home.append(el('h2', null, nameOf()), el('p', null, 'You can open files and messages on this device.'));
    for (const view of ['files', 'messages']) {
      const b = el('button', 'primary', view === 'files' ? 'Files' : 'Messages');
      b.onclick = () => document.querySelector(`#viewSwitch [data-view="${view}"]`)?.click();
      home.append(b);
    }
    document.getElementById('app')?.append(home);
    document.querySelector('#viewSwitch [data-view="files"]')?.click();
  }

  function build() {
    const anchor = document.getElementById('viewSwitch');
    if (!anchor) return;
    chip = el('button', 'mc-chip');
    chip.type = 'button';
    chip.id = 'machineChip';
    chip.hidden = true;
    chip.onclick = openSheet;
    anchor.after(chip);

    sheet = el('div', 'mc-sheet');
    sheet.hidden = true;
    const panel = el('section', 'mc-panel');
    const head = el('div', 'mc-head');
    const close = el('button', 'icon-btn', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.onclick = closeSheet;
    head.append(el('h2', null, 'Work on'), close);
    panel.append(head, el('div', 'mc-list'), el('p', 'mc-note', 'Terminal, Git, Chat, Files and Messages open on the device you pick.'));
    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    document.body.append(sheet);

    banner = el('aside', 'mc-banner');
    banner.hidden = true;
    banner.setAttribute('role', 'alert');
    const back = el('button', 'primary', 'Back to this device');
    back.type = 'button';
    back.onclick = () => select(null);
    banner.append(el('span', 'mc-banner-text'), back);
    document.body.append(banner);

    renderChip();
    renderLabel();
    applyRank();
  }

  const start = () => { build(); loadDevices(false); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
