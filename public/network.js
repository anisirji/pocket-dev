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
  const hostOf = (url) => new URL(url).hostname;
  // A landing with ?linked=1 is the internet address right after a link from Wi-Fi: the page goes straight back to
  // the Wi-Fi address it came from, carrying the same view. The Wi-Fi side never navigates on its own, so there is
  // no loop.
  const landingHash = location.hash;
  let justLinked = new URLSearchParams(location.search).get('linked') === '1';
  if (justLinked) history.replaceState(history.state, '', location.pathname + location.hash);

  // The open chat, else the active terminal, so the other address reopens the same work.
  function fragment() {
    const chat = window.pocketDevChat?.current?.();
    if (chat) return `#chat=${chat}`;
    const terminal = window.pocketDev?.activeSession?.();
    return terminal ? `#terminal=${terminal}` : '';
  }

  // The token is asked for at the moment of the tap, so its 60 seconds cover only the redirect.
  async function handoff(direction) {
    const { url } = await window.api('POST', '/api/handoff', { direction });
    location.assign(url + fragment());
  }
  const switchToLocal = () => handoff('to-lan');
  // Gives this device a cookie for the internet address while it is still at home, so that address never asks for
  // the password later.
  const linkToRemote = () => handoff('to-remote');
  function switchToRemote() {
    const url = remoteUrl();
    if (url) location.assign(url + fragment());
  }
  // From the internet address the switch link is minted first: once the link closes this phone reaches the Mac on
  // Wi-Fi only, where its internet cookie is no login, and the reply to the closing request may never arrive.
  async function turnOffInternet() {
    const remote = info.route === 'remote';
    if (!confirm(remote ? 'Turn off internet access? This phone then reaches the Mac only on its Wi-Fi, and switches there now.' : 'Turn off internet access? Only the Mac can turn it back on.')) return;
    const next = remote && info.lanUrl ? (await window.api('POST', '/api/handoff', { direction: 'to-lan' })).url + fragment() : null;
    try { await window.api('PUT', '/api/network', { internet: { kind: 'off' } }); } catch {}
    if (next) location.assign(next);
    else check();
  }

  const banner = h('aside', 'nw-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const text = h('span', 'nw-text');
  const actions = h('span', 'nw-actions');
  const err = h('span', 'nw-text');
  banner.append(text, actions);
  document.getElementById('clientError').after(banner);

  const PROMPTS = {
    local: { text: () => 'You’re on the same Wi-Fi as your Mac. Switch to local?', action: 'Switch', go: () => switchToLocal(), later: () => info?.networkKey && store.set(`pd.net.notNow.${info.networkKey}`, '1') },
    remote: { text: () => 'Can’t reach your Mac on Wi-Fi. Switch to remote?', action: 'Switch to remote', go: () => switchToRemote() },
    link: { text: () => `Link this phone to ${hostOf(info.remoteUrl)} so you won’t need to log in when you’re away.`, action: 'Link', go: () => linkToRemote(), later: () => store.set(`pd.net.linkNotNow.${hostOf(info.remoteUrl)}`, '1') },
    linked: { text: () => `Linked. This phone now opens ${hostOf(info.remoteUrl)} without logging in.`, action: 'OK', go: () => showPrompt(null) },
  };

  function showPrompt(kind) {
    banner.hidden = !kind;
    banner.dataset.kind = kind ?? '';
    if (!kind) return;
    const prompt = PROMPTS[kind];
    text.textContent = prompt.text();
    const go = h('button', 'nw-btn nw-primary', prompt.action);
    go.onclick = () => Promise.resolve(prompt.go()).catch((e) => { text.textContent = e.message; });
    const later = h('button', 'nw-btn', 'Not now');
    later.onclick = () => {
      prompt.later?.();
      showPrompt(null);
    };
    actions.replaceChildren(go, ...(prompt.later ? [later] : []));
  }

  function render() {
    const ports = document.getElementById('portsBtn');
    if (ports) ports.hidden = info?.wifi === false;
    if (enabled() && info.route === 'local' && info.remoteUrl) store.set('pd.net.remoteUrl', info.remoteUrl);
    if (!enabled()) store.remove('pd.net.remoteUrl');
    if (justLinked && enabled() && info.route === 'remote') {
      justLinked = false;
      if (info.lanUrl) return location.replace(info.lanUrl + (landingHash || fragment()));
      showPrompt('linked');
      return renderSection();
    }
    const nearby = enabled() && info.route === 'remote' && info.sameNetwork === true && info.lanUrl && !store.get(`pd.net.notNow.${info.networkKey}`);
    const unlinked = enabled() && info.route === 'local' && info.linked === false && info.remoteUrl && !store.get(`pd.net.linkNotNow.${hostOf(info.remoteUrl)}`);
    if (nearby) showPrompt('local');
    else if (unlinked) showPrompt('link');
    else if (banner.dataset.kind && banner.dataset.kind !== 'linked') showPrompt(null);
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

  function row(label, detail, action, onclick, current) {
    const node = h('div', 'nw-row');
    const addr = h('div', 'nw-addr');
    addr.append(h('b', null, label), h('small', null, detail ?? 'Not available right now'));
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
    off.onclick = () => turnOffInternet().catch((e) => { err.textContent = e.message; });
    err.textContent = '';
    const linkText = !info.remoteUrl ? 'The internet link is not connected right now.'
      : info.linked ? `Linked to ${hostOf(info.remoteUrl)}: it opens without the password.`
        : `Not linked yet: ${hostOf(info.remoteUrl)} would ask for the password. Link from Wi-Fi.`;
    section.replaceChildren(
      h('h3', null, 'Connection'),
      h('p', 'nw-summary', remote ? 'Connected over the internet' : 'Connected over Wi-Fi'),
      row('Wi-Fi', info.lanUrl, 'Switch to local', remote && info.lanUrl ? switchToLocal : null, !remote),
      row('Internet', info.remoteUrl, 'Switch to remote', !remote && info.remoteUrl ? switchToRemote : null, remote),
      row('Away from home', linkText, 'Link this phone', !remote && info.linked === false && info.remoteUrl ? linkToRemote : null, false),
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
