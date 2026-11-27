import { parseInvite, inviteLine, isCode, hostAddress } from './room-invite.js';
import { cameraSupport, cameraError, startCamera, decodePhoto } from './room-scan.js';
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, action, cls = 'st-btn') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; };
const api = (...args) => window.api(...args);
const names = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'Copilot' };
const field = (label, input) => { const wrapper = el('label', 'cc-field', label); wrapper.append(input); return wrapper; };
const input = (placeholder) => { const n = el('input'); n.placeholder = placeholder; n.autocomplete = 'off'; n.autocapitalize = 'off'; n.spellcheck = false; return n; };
let screen;
export async function connectionSummary() {
  const state = await api('GET', '/api/connections');
  return window.PocketMachine.computerSummary(state.computers);
}
export function openConnectedComputers({ request = window.api } = {}) {
  if (screen) return;
  const api = request;
  const previousFocus = document.activeElement;
  const root = el('div', 'rs cc'); screen = root;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Connected computers');
  const head = el('header', 'rs-head'), title = el('h2', null, 'Connected computers');
  const body = el('div', 'rs-body'), error = el('p', 'st-err'); error.setAttribute('role', 'alert');
  const message = el('p', 'cc-message'); message.setAttribute('role', 'status');
  let state, view = 'list', selected, filter = 'all', working = false, generation = 0, connectionType = 'external';
  let pairingGeneration = 0, scanner, cameraRequest;
  const pairingTimers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { pairingTimers.delete(id); fn(); }, ms); pairingTimers.add(id); return id; };
  const stopScanner = () => { pairingGeneration++; cameraRequest?.abort(); cameraRequest = null; scanner?.stop(); scanner = null; for (const id of pairingTimers) clearTimeout(id); pairingTimers.clear(); };
  let resourceController;
  const resources = new Map();
  const draft = { code: '', address: '' };
  const back = button('←', () => view === 'list' ? close() : showList(), 'rs-back'); back.setAttribute('aria-label', 'Back');
  head.append(back, title); root.append(head, error, message, body); document.body.append(root);
  const overlays = window.pocketDev?.overlays;
  const hide = () => { stopScanner(); generation++; resourceController?.abort(); clearInterval(timer); document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', visibleAgain); root.remove(); screen = null; previousFocus?.focus?.(); };
  const close = () => overlays ? overlays.close('computers') : hide();
  const hosted = window.pocketDevSettings?.presentPanel(root, 'computers', hide);
  if (!hosted) overlays?.open('computers', hide);
  const ask = (...args) => window.pocketDevSettings?.confirm(...args) ?? Promise.resolve(confirm(args[0]));
  const enter = (name, label, restore, render, data) => {
    if (hosted) window.pocketDevSettings.pushView(name, label, restore, render, data); else render();
  };
  async function run(action) {
    if (working) return; working = true; error.textContent = '';
    root.setAttribute('aria-busy', 'true');
    try { await action(); } catch (err) { error.textContent = err.message; }
    finally { working = false; root.removeAttribute('aria-busy'); }
  }
  async function refresh() {
    const ticket = ++generation;
    try {
      const fresh = await api('GET', '/api/connections');
      if (screen !== root || ticket !== generation) return;
      state = fresh;
      window.dispatchEvent(new CustomEvent('pd-computers-changed', { detail: state.computers }));
      if (view === 'list') { const scroll = body.scrollTop; showList(); body.scrollTop = scroll; }
      else if (view === 'details' && !state.computers.some((m) => m.deviceId === selected)) showList();
    } catch (err) { if (screen === root) error.textContent = err.message; }
  }
  function note(text) { return el('p', 'st-note', text); }
  function resourceRow(computer) {
    if (!computer.online || !computer.canOpen) return null;
    const row = el('small', 'cc-resources'); row.dataset.computerResources = computer.deviceId;
    row.textContent = resources.get(computer.deviceId) || 'Reading CPU and RAM…'; return row;
  }
  async function refreshResources() {
    resourceController?.abort();
    if (document.hidden || !root.getClientRects().length || !['list', 'details'].includes(view) || !window.PocketMachine?.readPerformance) return;
    const controller = resourceController = new AbortController();
    const wanted = state.computers.filter((computer) => computer.online && computer.canOpen && (view === 'details' ? computer.deviceId === selected : filter === 'all' || computer.connectionType === filter));
    // Small batches keep opening Settings inexpensive on larger computer networks.
    for (let index = 0; index < wanted.length && !controller.signal.aborted; index += 3) await Promise.allSettled(wanted.slice(index, index + 3).map(async (computer) => {
      let text;
      try {
        const sample = await window.PocketMachine.readPerformance(computer, controller.signal);
        const cpu = sample.cpu?.usedPercent, free = sample.memory?.freePercent;
        const valid = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
        text = `${valid(cpu) ? `CPU ${Math.round(cpu)}%` : 'CPU checking'} · ${valid(free) ? `RAM ${Math.round(100 - free)}%` : 'RAM unavailable'}`;
      } catch { text = 'Resource information unavailable'; }
      if (controller.signal.aborted || screen !== root || document.hidden || !root.getClientRects().length) return;
      resources.set(computer.deviceId, text);
      for (const row of body.querySelectorAll('[data-computer-resources]')) if (row.dataset.computerResources === computer.deviceId) row.textContent = text;
    }));
  }
  function showList() {
    stopScanner();
    view = 'list'; title.textContent = 'Connected computers';
    if (!state) { body.replaceChildren(note('Loading connected computers…')); return; }
    const count = el('p', 'cc-summary', window.PocketMachine?.computerSummary(state.computers) || `${state.computers.length} computers`);
    const filters = el('div', 'cc-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter computers');
    for (const [key, label] of [['all', 'All'], ['personal', 'Mine'], ['external', 'Others']]) {
      const b = button(label, () => { filter = key; showList(); }); b.setAttribute('aria-pressed', String(key === filter)); filters.append(b);
    }
    const list = el('div', 'cc-list');
    for (const computer of state.computers.filter((m) => filter === 'all' || m.connectionType === filter)) {
      const row = button('', () => enter('computer-detail', computer.name, showList, () => details(computer.deviceId), computer.deviceId), 'cc-computer');
      const text = el('span', 'cc-computer-text');
      text.append(el('strong', null, computer.name), el('small', null, computer.self ? 'This computer · Online' : `${computer.connectionType === 'personal' ? 'My computer' : 'AI only'} · ${computer.disconnected ? 'Disconnected' : computer.online ? computer.transport === 'internet' ? 'Internet' : 'Wi-Fi' : 'Offline'}`));
      const shares = [computer.sharing.length && `Sharing ${computer.sharing.map((p) => names[p]).join(', ')}`, computer.receiving.length && `Receiving ${computer.receiving.map((p) => names[p]).join(', ')}`].filter(Boolean).join(' · ');
      if (shares) text.append(el('small', null, shares));
      const resource = resourceRow(computer); if (resource) text.append(resource);
      row.append(el('i', `rm-dot ${computer.online ? 'rm-online' : 'rm-offline'}`), text, el('span', null, '›')); list.append(row);
    }
    if (!list.childElementCount) list.append(note(filter === 'all' ? 'Connect another computer to work across your devices or share AI.' : 'No computers in this group.'));
    const connect = button('Connect another computer', () => enter('computer-connect', 'Connect computer', showList, connectStep), 'st-primary');
    body.replaceChildren(count, filters, list, connect);
    if (state.computers.some((computer) => !computer.self && computer.needsApproval)) body.append(note('Existing connections need approval again to verify their identity. Saved chats and project copies remain on their original computers.'));
    refreshResources();
  }
  function details(id) {
    selected = id; view = 'details';
    const computer = state.computers.find((m) => m.deviceId === id);
    title.textContent = computer.name;
    body.replaceChildren(el('h3', 'cc-title', computer.name), note(computer.self ? 'This computer' : `${computer.online ? 'Online' : 'Offline'} · ${computer.transport === 'internet' ? 'Internet' : 'Wi-Fi'}`));
    const resource = resourceRow(computer); if (resource) body.append(resource);
    refreshResources();
    if (computer.self) {
      body.append(el('h3', 'cc-label', 'Access type'), note('My computer · This computer'),
        el('h3', 'cc-label', 'Sharing from this computer'));
      for (const [type, provider] of Object.entries(state.providers)) body.append(note(`${names[type]} · ${provider.installed ? provider.enabled && provider.supported ? 'Sharing on' : 'Sharing off' : 'Not installed'}`));
      body.append(button('Manage AI Tools', () => { if (hosted) window.pocketDevSettings.show('tools'); else { close(); window.pocketDevSettings?.open('tools'); } }),
        el('h3', 'cc-label', 'Shared with you'), note(state.shared.length ? state.shared.map((provider) => `${names[provider.type]} · ${provider.name}`).join(' · ') : 'No AI providers are shared with you.'),
        el('h3', 'cc-label', 'Computer identity'), note(id));
      return;
    }
    if (computer.disconnected) {
      body.append(note('This connection is revoked. Reconnecting restores membership without restoring previous access.'),
        button('Reconnect computer', () => run(async () => {
          await api('POST', `/api/connections/${id}/reconnect`); await refresh(); details(id);
        }), 'st-primary'));
      return;
    }
    if (computer.needsApproval) body.append(button('Approve as my computer', () => run(async () => {
      if (!await ask('I own this computer and approve this connection to access its files, terminals and conversations.')) return;
      await api('PATCH', `/api/connections/${id}`, { computerAccess: true, confirmOwnership: true });
      await refresh(); details(id);
    })));
    body.append(el('h3', 'cc-label', 'Access type'), el('p', null, computer.connectionType === 'personal' ? 'My computer' : 'AI only'));
    if (computer.connectionType === 'personal') {
      const access = el('input'); access.type = 'checkbox'; access.checked = computer.computerAccess;
      const label = field('Allow this computer to access my files, terminal and settings', access);
      access.onchange = () => run(async () => {
        const on = access.checked;
        if (on && !await ask('I own this computer and approve access to its files, terminals, settings and conversations.')) { access.checked = false; return; }
        try { await api('PATCH', `/api/connections/${id}`, { computerAccess: on, confirmOwnership: on }); await refresh(); details(id); } catch (err) { access.checked = !on; throw err; }
      });
      body.append(label);
      if (computer.canOpen) body.append(button('Open computer', () => { localStorage.setItem('pd.machine', id); location.replace(location.pathname); }, 'st-primary'));
    } else body.append(note('Computer access is not shared.'));
    body.append(el('h3', 'cc-label', 'Sharing with this computer'));
    for (const [type, provider] of Object.entries(state.providers).filter(([, p]) => p.installed)) {
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = computer.sharing.includes(type); toggle.disabled = !provider.supported;
      const label = field(names[type], toggle);
      toggle.onchange = () => run(async () => {
        const on = toggle.checked;
        try {
          const ai = [...new Set(on ? [...computer.sharing, type] : computer.sharing.filter((p) => p !== type))];
          await api('PATCH', `/api/connections/${id}`, { ai });
          await refresh(); details(id);
        } catch (err) { toggle.checked = !on; throw err; }
      });
      body.append(label);
      if (!provider.supported) body.append(note(`${names[type]} sharing is not available yet.`));
      else if (!provider.enabled) body.append(note(`${names[type]} sharing is off in AI Tools. Turn it on there to make this permission available.`));
    }
    body.append(el('h3', 'cc-label', 'Shared with you'));
    body.append(note(computer.receiving.length ? computer.receiving.map((p) => names[p]).join(' · ') : computer.online ? 'No AI providers are shared with you.' : 'Reconnect this computer to check available AI providers.'));
    body.append(note('Relevant project content is sent to the AI source computer and its AI service. Its administrator may be able to inspect that content.'));
    body.append(button('Disconnect computer', () => run(async () => {
      if (!await ask(`Disconnect ${computer.name}? Its access and shared AI sessions will stop.`)) return;
      await api('DELETE', `/api/connections/${id}`); await refresh();
      if (hosted) window.pocketDevSettings.back(); else showList();
    }), 'st-btn st-danger'));
  }
  function connectStep() { exchange(connectionType); }
  function exchange(type) {
    stopScanner(); generation++; resourceController?.abort();
    message.textContent = ''; error.textContent = '';
    view = 'connect'; title.textContent = 'Connect computer';
    const own = el('input'); own.type = 'checkbox'; own.checked = type === 'personal';
    const ownership = field('My computer', own);
    const permissions = note('Off: connect for AI sharing only. On: both owners must select My computer to allow computer access.');
    const methods = el('div', 'cc-filters'); methods.setAttribute('role', 'group'); methods.setAttribute('aria-label', 'Pair computers');
    const panel = el('div', 'cc-pair-panel');
    const received = input('Paste connection details'), address = input('Computer address');
    received.value = draft.code; address.value = draft.address;
    received.oninput = () => { draft.code = received.value; };
    address.oninput = () => { draft.address = address.value; };
    const status = note('Show a QR here and scan it from the other computer’s Admin or phone Settings.'); status.setAttribute('role', 'status');
    let mode = '', invitationTimer;
    const valid = () => screen === root && view === 'connect' && panel.isConnected;
    const clear = () => { stopScanner(); clearTimeout(invitationTimer); panel.replaceChildren(); error.textContent = ''; };
    async function connect(text) {
      const parsed = parseInvite(text);
      const host = parsed.host || hostAddress(address.value.trim());
      if (!isCode(parsed.code) || !host) throw new Error('Scan a Pocket Dev computer QR, or paste its connection details.');
      const result = await api('POST', '/api/connections/join', { code: parsed.code, host, connectionType });
      if (!valid()) return;
      clear(); await refresh();
      if (result.callback?.ok === false) {
        panel.append(note('Connected, but the other computer cannot reach this one yet. Check Wi-Fi and firewall access.'));
        status.textContent = 'Connection needs attention';
      } else {
        showList(); message.textContent = 'Computer connected.';
      }
    }
    async function showQr() {
      clear(); mode = 'show'; show.setAttribute('aria-pressed', 'true'); scan.setAttribute('aria-pressed', 'false');
      const ticket = pairingGeneration;
      status.textContent = 'Creating connection QR…';
      try {
        const result = await api('POST', '/api/connections/invite', { connectionType });
        if (!valid() || ticket !== pairingGeneration) return;
        if (typeof result.svg !== 'string') throw new Error('Restart Pocket Dev on this computer to use the updated QR pairing.');
        const qr = el('div', 'rs-qr cc-pair-qr'); qr.setAttribute('role', 'img'); qr.setAttribute('aria-label', 'One-time computer connection QR'); qr.innerHTML = result.svg;
        const expires = Date.now() + result.expiresInSeconds * 1000;
        const expiry = note(`One use · Expires at ${new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        const line = el('code', 'rs-line', result.invite || inviteLine(result.address, result.code));
        line.hidden = true;
        panel.append(qr, expiry, button('Copy connection details', async () => {
          try {
            const ok = window.copyText ? await window.copyText(line.textContent) : await navigator.clipboard.writeText(line.textContent).then(() => true);
            if (!ok) throw new Error(); status.textContent = 'Connection details copied.';
          } catch { line.hidden = false; status.textContent = 'Select the connection details below and copy them.'; }
        }), line, button('New QR', () => run(showQr)));
        status.textContent = 'On the other computer, choose Scan QR. A phone can scan on behalf of the computer whose Settings it has open.';
        invitationTimer = later(() => {
          if (!valid() || ticket !== pairingGeneration) return;
          qr.replaceChildren(); expiry.textContent = 'QR expired. Choose New QR.';
        }, result.expiresInSeconds * 1000);
        const known = new Set(state.computers.map((computer) => computer.deviceId));
        // Poll only while this QR is visible, so pairing finishes on both screens.
        const watch = async () => {
          if (!valid() || document.hidden || ticket !== pairingGeneration || Date.now() >= expires) return;
          try {
            const fresh = await api('GET', '/api/connections');
            if (!valid() || ticket !== pairingGeneration) return;
            if (fresh.computers.some((computer) => !known.has(computer.deviceId))) {
              state = fresh; showList(); message.textContent = 'Computer connected.'; return;
            }
          } catch { /* A temporary connection failure is retried while the QR is visible. */ }
          later(watch, 1500);
        };
        later(watch, 1500);
      } catch (err) { if (valid() && ticket === pairingGeneration) { status.textContent = ''; throw err; } }
    }
    function scanQr() {
      clear(); mode = 'scan'; show.setAttribute('aria-pressed', 'false'); scan.setAttribute('aria-pressed', 'true');
      const support = cameraSupport({ isSecureContext: window.isSecureContext, hasCamera: !!navigator.mediaDevices?.getUserMedia, port: location.port });
      status.textContent = 'Scan the QR shown by the other computer. You can also choose a photo or screenshot.';
      const video = el('video', 'rs-video'); video.hidden = true; video.setAttribute('aria-label', 'Connection QR scanner');
      const camera = button('Use camera', () => run(async () => {
        stopScanner(); const ticket = pairingGeneration;
        cameraRequest = new AbortController();
        video.hidden = false;
        try {
          const active = await startCamera(video, (text) => {
            const finish = () => { if (!valid() || ticket !== pairingGeneration) return; if (working) later(finish, 50); else run(() => connect(text)); };
            finish();
          }, { signal: cameraRequest.signal });
          if (!valid() || ticket !== pairingGeneration) { active.stop(); return; }
          scanner = active;
        } catch (err) { video.hidden = true; throw new Error(cameraError(err)); }
      }), 'st-primary');
      camera.disabled = !support.ok;
      const photo = el('input'); photo.type = 'file'; photo.accept = 'image/*'; photo.hidden = true;
      photo.onchange = () => run(async () => {
        const file = photo.files?.[0]; if (!file) return;
        stopScanner(); video.hidden = true; const ticket = pairingGeneration;
        const text = await decodePhoto(file);
        if (!valid() || ticket !== pairingGeneration) return;
        if (!text) throw new Error('No QR found. Choose a clear photo showing the whole QR.');
        await connect(text);
      }).finally(() => { photo.value = ''; });
      panel.append(video, camera, button('Choose QR photo', () => photo.click()), photo);
      if (!support.ok) panel.append(note(window.isSecureContext ? support.text : 'On a Wi-Fi HTTP connection, choose a QR photo. Live camera scanning needs HTTPS or local Admin on the computer.'));
    }
    const show = button('Show QR', () => run(showQr), 'st-primary');
    show.disabled = state.pairing?.canShowQr === false;
    if (show.disabled) status.textContent = `To add another computer, show the QR from ${state.pairing.hostName || 'your network’s first computer'} and scan it on the new computer. Your existing connections stay connected.`;
    const scan = button('Scan QR', scanQr);
    methods.append(show, scan);
    own.onchange = () => {
      connectionType = own.checked ? 'personal' : 'external';
      if (mode === 'show') run(showQr);
    };
    const manual = el('details', 'cc-manual'); manual.append(el('summary', null, 'Enter connection details instead'),
      field('Connection details or code', received), field('Computer address (if entering only a code)', address),
      button('Connect', () => run(() => connect(received.value)), 'st-primary'));
    body.replaceChildren(ownership, permissions, methods, status, panel, manual);
  }
  function onKey(event) {
    if (hosted || screen !== root) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (view === 'list') close(); else showList(); }
    if (event.key === 'Tab') {
      const controls = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, a[href]')].filter((n) => n.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  }
  document.addEventListener('keydown', onKey);
  function visibleAgain() { if (document.hidden) { resourceController?.abort(); stopScanner(); } else if (root.getClientRects().length) { if (view === 'list') refresh(); else if (view === 'connect') connectStep(); else refreshResources(); } }
  document.addEventListener('visibilitychange', visibleAgain);
  const timer = setInterval(() => { if (!working && !document.hidden && root.getClientRects().length) { if (view === 'list') refresh(); else if (view === 'details') refreshResources(); } }, 10000);
  if (hosted) {
    window.pocketDevSettings.registerRoute('computer-detail', (id) => {
      const computer = state?.computers.find((item) => item.deviceId === id);
      if (computer) enter('computer-detail', computer.name, showList, () => details(id), id);
    });
    window.pocketDevSettings.registerRoute('computer-connect', () => enter('computer-connect', 'Connect computer', showList, connectStep));
    window.pocketDevSettings.registerRoute('computer-code', (type) => {
      connectionType = type === 'external' ? 'external' : 'personal';
      enter('computer-code', 'Connect computer', connectStep, () => exchange(connectionType), connectionType);
    });
  }
  showList(); const ready = refresh(); if (!hosted) back.focus();
  return ready;
}
