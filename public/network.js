// Switching between the Mac's Wi-Fi address and its internet link. The server says which route this page came in on
// and whether the phone looks like it is on the Mac's own network; nothing switches by itself. Settings shows both
// addresses with Switch buttons, a small prompt offers the local route when the Mac is nearby, and a lost Wi-Fi
// connection offers the internet link. The view to reopen travels in the URL fragment.
(() => {
  const PROBE_EVERY_MS = 1000;
  const PROBE_FAILURES = 5;
  const STYLE = `
.nw-banner { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel-2); font-size: 13.5px; line-height: 1.35; }
.nw-banner[hidden] { display: none; }
.nw-text { flex: 1 1 180px; min-width: 0; }
.nw-actions { flex: none; display: flex; gap: 8px; }
.nw-btn { height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; font-size: 13px; font-weight: 600; }
.nw-primary { background: var(--accent); border-color: var(--accent); color: #08101e; }
.nw-summary { margin: -4px 0 6px; }
.nw-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; }
.nw-row + .nw-row { border-top: 1px solid var(--line); }
.nw-addr { display: grid; gap: 2px; min-width: 0; }
.nw-addr b { font-size: 14px; }
.nw-addr small { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.nw-now { color: var(--ok, #7ee787); }
.nw-row .st-btn { flex: none; }
.nw-off { margin-top: 12px; width: 100%; }
`;
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    remove(key) { try { localStorage.removeItem(key); } catch {} },
  };
  const h = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const style = h('style', null, STYLE);
  document.head.append(style);

  let info = null;
  let checking = null;
  let section = null;
  let probe = 0;
  let failures = 0;
  const enabled = () => info !== null && info.wifi && info.internet !== 'off';
  const remoteUrl = () => info?.remoteUrl ?? store.get('pd.net.remoteUrl');

  // The open chat, else the active terminal, so the other address reopens the same work.
  function fragment() {
    const chat = window.pocketDevChat?.current?.();
    if (chat) return `#chat=${chat}`;
    const terminal = window.pocketDev?.activeSession?.();
    return terminal ? `#terminal=${terminal}` : '';
  }

  // The token is asked for at the moment of the tap, so its 60 seconds cover only the redirect.
  async function switchToLocal() {
    const { url } = await window.api('POST', '/api/handoff', {});
    location.assign(url + fragment());
  }
  function switchToRemote() {
    const url = remoteUrl();
    if (url) location.assign(url + fragment());
  }

  const banner = h('aside', 'nw-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const text = h('span', 'nw-text');
  const actions = h('span', 'nw-actions');
  const err = h('span', 'nw-text');
  banner.append(text, actions);
  document.getElementById('clientError').after(banner);

  function showPrompt(kind) {
    banner.hidden = !kind;
    banner.dataset.kind = kind ?? '';
    if (!kind) return;
    text.textContent = kind === 'local' ? 'You’re on the same Wi-Fi as your Mac. Switch to local?' : 'Can’t reach your Mac on Wi-Fi. Switch to remote?';
    const go = h('button', 'nw-btn nw-primary', kind === 'local' ? 'Switch' : 'Switch to remote');
    go.onclick = () => (kind === 'local' ? switchToLocal().catch((e) => { text.textContent = e.message; }) : switchToRemote());
    const later = h('button', 'nw-btn', 'Not now');
    later.onclick = () => {
      if (kind === 'local' && info?.networkKey) store.set(`pd.net.notNow.${info.networkKey}`, '1');
      showPrompt(null);
    };
    actions.replaceChildren(go, later);
  }

  function render() {
    const ports = document.getElementById('portsBtn');
    if (ports) ports.hidden = info?.wifi === false;
    if (enabled() && info.route === 'local' && info.remoteUrl) store.set('pd.net.remoteUrl', info.remoteUrl);
    if (!enabled()) store.remove('pd.net.remoteUrl');
    const nearby = enabled() && info.route === 'remote' && info.sameNetwork === true && info.lanUrl && !store.get(`pd.net.notNow.${info.networkKey}`);
    if (nearby) showPrompt('local');
    else if (banner.dataset.kind) showPrompt(null);
    renderSection();
  }

  // A 404 means internet access is off on the Mac, so there is nothing to switch between.
  function check() {
    if (document.hidden) return Promise.resolve();
    checking ??= (async () => {
      let res;
      try { res = await fetch('/api/connection', { headers: { 'x-pocket-dev': '1' }, cache: 'no-store' }); } catch { return; }
      if (res.status === 404) info = null;
      else if (res.ok) info = await res.json();
      else return;
      render();
    })().finally(() => { checking = null; });
    return checking;
  }

  // The page reports each terminal socket's state. A socket that comes back after a drop is the network-change
  // signal; one that stays down starts a short probe, and about five failed seconds offer the internet link.
  function socket(online) {
    if (online) {
      clearTimeout(probe);
      probe = 0;
      if (banner.dataset.kind === 'remote') showPrompt(null);
      check();
      return;
    }
    if (!probe && !document.hidden) {
      failures = 0;
      probe = setTimeout(probeOnce, PROBE_EVERY_MS);
    }
  }
  async function probeOnce() {
    probe = 0;
    try {
      if ((await fetch('/api/status', { cache: 'no-store' })).ok) return;
    } catch {}
    failures++;
    if (failures < PROBE_FAILURES) {
      probe = setTimeout(probeOnce, PROBE_EVERY_MS);
      return;
    }
    const local = info ? info.route === 'local' : location.protocol === 'http:';
    if (local && remoteUrl() && navigator.onLine !== false) showPrompt('remote');
  }

  function row(label, url, action, onclick, current) {
    const node = h('div', 'nw-row');
    const addr = h('div', 'nw-addr');
    addr.append(h('b', null, label), h('small', null, url ?? 'Not available right now'));
    if (current) addr.append(h('small', 'nw-now', 'You are here'));
    const button = h('button', 'st-btn', action);
    button.type = 'button';
    button.disabled = !onclick;
    if (onclick) button.onclick = () => Promise.resolve(onclick()).catch((e) => { err.textContent = e.message; });
    node.append(addr, button);
    return node;
  }

  function renderSection() {
    if (!section) return;
    section.hidden = !enabled();
    if (!enabled()) return void section.replaceChildren();
    const remote = info.route === 'remote';
    const off = h('button', 'st-btn st-danger nw-off', 'Turn off internet access');
    off.type = 'button';
    off.onclick = async () => {
      if (!confirm(remote ? 'Turn off internet access? This phone then reaches the Mac only on its Wi-Fi, and switches there now.' : 'Turn off internet access? Only the Mac can turn it back on.')) return;
      // The reply may not arrive when it travels through the link being closed.
      try { await window.api('PUT', '/api/network', { internet: { kind: 'off' } }); } catch {}
      if (remote && info.lanUrl) location.assign(info.lanUrl + fragment());
      else check();
    };
    err.textContent = '';
    section.replaceChildren(
      h('h3', null, 'Connection'),
      h('p', 'nw-summary', remote ? 'Connected over the internet' : 'Connected over Wi-Fi'),
      row('Wi-Fi', info.lanUrl, 'Switch to local', remote && info.lanUrl ? switchToLocal : null, !remote),
      row('Internet', info.remoteUrl, 'Switch to remote', !remote && info.remoteUrl ? switchToRemote : null, remote),
      err,
      off,
    );
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();

  window.pocketDevNetwork = {
    check,
    socket,
    fragment,
    mount(node) {
      section = node;
      renderSection();
      check();
    },
  };
})();
