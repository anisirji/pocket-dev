import { parseInvite, inviteLine } from './room-invite.js';
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
export function openConnectedComputers() {
  if (screen) return;
  const previousFocus = document.activeElement;
  const root = el('div', 'rs cc'); screen = root;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Connected computers');
  const head = el('header', 'rs-head'), title = el('h2', null, 'Connected computers');
  const body = el('div', 'rs-body'), error = el('p', 'st-err'); error.setAttribute('role', 'alert');
  let state, view = 'list', selected, filter = 'all', working = false, generation = 0, connectionType = 'personal';
  let resourceController;
  const resources = new Map();
  const draft = { code: '', address: '' };
  const back = button('←', () => view === 'list' ? close() : showList(), 'rs-back'); back.setAttribute('aria-label', 'Back');
  head.append(back, title); root.append(head, error, body); document.body.append(root);
  const overlays = window.pocketDev?.overlays;
  const hide = () => { generation++; resourceController?.abort(); clearInterval(timer); document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', visibleAgain); root.remove(); screen = null; previousFocus?.focus?.(); };
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
    view = 'list'; title.textContent = 'Connected computers';
    if (!state) { body.replaceChildren(note('Loading connected computers…')); return; }
    const count = el('p', 'cc-summary', window.PocketMachine.computerSummary(state.computers));
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
  function connectStep() {
    view = 'connect'; generation++; resourceController?.abort(); title.textContent = 'Connect computer';
    let type = connectionType;
    const choice = el('div', 'cc-choices');
    for (const [key, label, description] of [['personal', 'My computer', 'Access and manage another computer you own.'], ['external', "Someone else’s computer", 'Share AI without granting computer access.']]) {
      const radio = el('input'); radio.type = 'radio'; radio.name = 'computer-type'; radio.value = key; radio.checked = key === type;
      radio.onchange = () => { connectionType = type = key; };
      const text = el('span'); text.append(el('strong', null, label), el('small', null, description));
      const labelNode = el('label', 'cc-choice'); labelNode.append(radio, text); choice.append(labelNode);
    }
    body.replaceChildren(note('1 of 2'), el('h3', 'cc-title', 'Whose computer is it?'), choice, button('Continue', () => enter('computer-code', 'Connect computer', connectStep, () => exchange(type), type), 'st-primary'));
  }
  function exchange(type) {
    view = 'connect'; title.textContent = 'Connect computer';
    const received = input('Paste connection details or enter a code'), address = input('Computer address, e.g. http://192.168.1.24:7777');
    received.value = draft.code; address.value = draft.address;
    received.oninput = () => { draft.code = received.value; };
    address.oninput = () => { draft.address = address.value; };
    const invitation = el('div', 'cc-invitation');
    body.replaceChildren(note('2 of 2'), note('Open Connected computers on the other computer. Create a code here or enter the code from there.'),
      button('Create connection code', () => run(async () => {
        const result = await api('POST', '/api/connections/invite', { connectionType: type });
        const code = el('div', 'rs-code', result.code), line = el('code', 'rs-line', result.invite || inviteLine(result.address, result.code));
        const expires = Date.now() + result.expiresInSeconds * 1000;
        invitation.replaceChildren(code, line, note(`One use · Expires at ${new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
          button('Copy connection details', async () => { const ok = await window.copyText?.(line.textContent); if (!ok) error.textContent = 'Select and copy the connection details above.'; }));
      })), invitation, el('h3', 'cc-label', 'Or enter a code'), field('Connection code', received), field('Computer address', address),
      button('Connect', () => run(async () => {
        const parsed = parseInvite(received.value);
        await api('POST', '/api/connections/join', { code: parsed.code || received.value.trim(), host: parsed.host || address.value.trim(), connectionType: type });
        await refresh();
        if (hosted) { overlays.close('computer-connect'); } else showList();
      }), 'st-primary'));
  }
  function onKey(event) { if (!hosted && screen === root && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey);
  function visibleAgain() { if (document.hidden) resourceController?.abort(); else if (root.getClientRects().length) { if (view === 'list') refresh(); else refreshResources(); } }
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
