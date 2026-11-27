(() => {
  let nextId = 0;
  const node = (tag, className, text) => {
    const result = document.createElement(tag); result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  const fallback = (state = {}) => ({ local: state.urls?.lan || null, remote: state.urls?.remote || null, remoteEnabled: Boolean(state.urls?.remote || state.network?.internet?.kind && state.network.internet.kind !== 'off') });

  window.PocketConnectionQr = { options: (state) => state?.qrConnections || fallback(state), mount(root, { request, button, kind = 'login', ids = {}, codeClass = '', image = false } = {}) {
    const id = `connection-qr-${++nextId}`, label = kind === 'share' ? 'Show share QR' : 'Show login QR';
    let choices = { local: null, remote: null, remoteEnabled: false }, enabled = false, active = false, selected = 'local', generation = 0, busy = false, expiryTimer, refreshPending = false, statusMessage = '';
    const cache = new Map();
    root.classList.add('cq-panel'); root.hidden = true;
    const tabs = node('div', 'cq-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Connection method');
    const panel = node('div', 'cq-content'); panel.id = id; panel.setAttribute('role', 'tabpanel');
    const tabButtons = new Map();
    for (const [key, text] of [['local', 'Local connection'], ['remote', 'Remote connection']]) {
      const tab = node('button', '', text); tab.type = 'button'; tab.id = `${id}-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', id);
      tab.onclick = () => { if (key === selected) return; selected = key; generation++; busy = false; statusMessage = ''; render(); load(); };
      tab.onkeydown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const key = event.key === 'Home' ? 'local' : event.key === 'End' ? 'remote' : selected === 'local' ? 'remote' : 'local';
        tabButtons.get(key).focus(); tabButtons.get(key).click();
      };
      tabButtons.set(key, tab); tabs.append(tab);
    }
    const title = node('strong', 'cq-title'), note = node('p', 'cq-note');
    const layout = node('div', 'cq-layout'), code = node('div', `cq-code ${codeClass}`.trim()); code.setAttribute('role', 'img'); code.setAttribute('aria-label', kind === 'share' ? 'QR code for the Pocket Dev address' : 'One-time Pocket Dev login QR');
    const details = node('div', 'cq-details'), url = node('a', 'cq-url'); url.target = '_blank'; url.rel = 'noopener noreferrer'; url.referrerPolicy = 'no-referrer';
    const actions = node('div', 'cq-actions'), copy = node('button', 'cq-button', kind === 'share' ? 'Copy link' : 'Copy login link'), open = node('a', 'cq-button', 'Open'); copy.type = 'button';
    open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
    const expiry = node('p', 'cq-note'), status = node('p', 'cq-status'); status.setAttribute('role', 'status');
    for (const [name, element] of Object.entries({ code, url, copy, expiry })) if (ids[name]) element.id = ids[name];
    actions.append(copy, open); details.append(url, actions, expiry); layout.append(code, details); panel.append(title, note, layout, status); root.replaceChildren(tabs, panel);
    const visible = () => active && !document.hidden && root.getClientRects().length > 0;
    const current = () => {
      const item = cache.get(selected);
      return item && item.base === choices[selected] && (kind !== 'login' || item.expiresAt > Date.now()) ? item : null;
    };
    function render() {
      clearTimeout(expiryTimer); const data = current();
      tabs.hidden = !choices.remoteEnabled;
      for (const [key, tab] of tabButtons) { tab.setAttribute('aria-selected', String(key === selected)); tab.tabIndex = key === selected ? 0 : -1; }
      panel.setAttribute('aria-labelledby', `${id}-${selected}`);
      title.textContent = selected === 'local' ? 'Connect using Wi-Fi' : 'Connect remotely';
      note.textContent = selected === 'local' ? 'Both devices must be on the same local network.' : 'Use the remote connection when you are away from this network.';
      code.replaceChildren(); code.hidden = !data; expiry.hidden = !data || kind !== 'login';
      if (data) {
        if (image) { const picture = node('img', ''); picture.alt = 'One-time Pocket Dev login QR'; picture.width = picture.height = 224; picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`; code.append(picture); }
        else code.innerHTML = data.svg;
        if (kind === 'login') {
          expiry.textContent = `Works once. Expires at ${new Date(data.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
          expiryTimer = setTimeout(() => { cache.delete(selected); statusMessage = 'The login QR expired. Show a new code.'; render(); }, Math.min(2147483647, Math.max(1, data.expiresAt - Date.now())));
        }
      }
      const address = data?.url || choices[selected]; url.textContent = address || ''; url.hidden = !address;
      if (address) url.href = address; else url.removeAttribute('href');
      copy.disabled = !data; open.setAttribute('aria-disabled', String(!data));
      if (data) open.href = data.url; else open.removeAttribute('href');
      status.textContent = busy ? 'Creating QR code…' : !choices[selected] ? selected === 'local' ? 'Local access is unavailable. Check Wi-Fi and local access on the computer.' : 'The remote link is not ready. You can still use the local connection.' : statusMessage;
      if (button) {
        button.disabled = !enabled || busy || !(choices.local || choices.remote);
        button.textContent = busy ? 'Creating…' : data ? kind === 'share' ? 'Refresh share QR' : 'New code' : label;
        button.setAttribute('aria-expanded', String(active)); button.setAttribute('aria-busy', String(busy));
      }
    }
    async function load(force = false) {
      if (!visible() || !enabled || !choices[selected] || busy) return;
      if (!force && current()) return render();
      const run = ++generation, connection = selected, base = choices[connection]; busy = true; refreshPending = false; statusMessage = ''; render();
      try {
        const data = await request(connection);
        if (run !== generation || !active) return;
        const parsed = new URL(data.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== new URL(base).origin || typeof data.svg !== 'string'
          || (kind === 'share' && (parsed.search || parsed.hash)) || (kind === 'login' && (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()))) throw new Error('The connection address changed. Refresh the code, or restart Pocket Dev if it needs an update.');
        cache.set(connection, { ...data, base }); busy = false; render();
      } catch (error) {
        if (run !== generation || !active) return;
        cache.delete(connection); busy = false; statusMessage = error.message; render();
      } finally { if (run === generation && busy) { busy = false; render(); } }
    }
    copy.onclick = async () => {
      const data = current(); if (!data) return;
      try {
        if (window.copyText) { if (!await window.copyText(data.url)) throw new Error(); }
        else await navigator.clipboard.writeText(data.url);
        statusMessage = 'Copied'; render();
      } catch { statusMessage = 'Could not copy. Select the address and copy it manually.'; render(); }
    };
    function hide() { active = false; generation++; busy = false; refreshPending = false; statusMessage = ''; cache.clear(); clearTimeout(expiryTimer); root.hidden = true; render(); }
    function show() { if (!active) selected = 'local'; statusMessage = ''; active = true; root.hidden = false; render(); return load(true); }
    if (button) button.onclick = show;
    render();
    return { show, hide, update(next, available = true) {
      const changed = choices[selected] !== next[selected]; choices = { ...next }; enabled = available;
      for (const [key, data] of cache) if (data.base !== choices[key] || (kind === 'login' && data.expiresAt <= Date.now())) cache.delete(key);
      if (!choices.remoteEnabled && selected === 'remote') { selected = 'local'; generation++; busy = false; refreshPending = true; statusMessage = ''; }
      if (!enabled) return hide();
      if (changed) { generation++; busy = false; refreshPending = true; statusMessage = ''; }
      render(); if (visible() && refreshPending) { refreshPending = false; load(); }
    } };
  } };
})();
