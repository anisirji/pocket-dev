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
  const peers = state.computers.filter((m) => !m.self);
  return peers.length ? `${peers.filter((m) => m.online).length} online · ${peers.length} connected` : 'Manage computer connections';
}
export function openConnectedComputers() {
  if (screen) return;
  const previousFocus = document.activeElement;
  const root = el('div', 'rs cc'); screen = root;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Connected computers');
  const head = el('header', 'rs-head'), title = el('h2', null, 'Connected computers');
  const body = el('div', 'rs-body'), error = el('p', 'st-err'); error.setAttribute('role', 'alert');
  let state, view = 'list', selected, filter = 'all', working = false, generation = 0;
  const back = button('←', () => view === 'list' ? close() : showList(), 'rs-back'); back.setAttribute('aria-label', 'Back');
  head.append(back, title); root.append(head, error, body); document.body.append(root);
  const overlays = window.pocketDev?.overlays;
  const hide = () => { generation++; clearInterval(timer); document.removeEventListener('keydown', onKey); root.remove(); screen = null; previousFocus?.focus?.(); };
  const close = () => overlays ? overlays.close('computers') : hide();
  overlays?.open('computers', hide);
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
      if (view === 'list') showList();
      else if (view === 'details' && !state.computers.some((m) => m.deviceId === selected)) showList();
    } catch (err) { if (screen === root) error.textContent = err.message; }
  }
  function note(text) { return el('p', 'st-note', text); }
  function showList() {
    view = 'list'; title.textContent = 'Connected computers';
    if (!state) { body.replaceChildren(note('Loading connected computers…')); return; }
    const peers = state.computers.filter((m) => !m.self), count = el('p', 'cc-summary', `${peers.filter((m) => m.online).length} online · ${peers.filter((m) => !m.online).length} offline`);
    const filters = el('div', 'cc-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter computers');
    for (const [key, label] of [['all', 'All'], ['personal', 'Mine'], ['external', 'Others']]) {
      const b = button(label, () => { filter = key; showList(); }); b.setAttribute('aria-pressed', String(key === filter)); filters.append(b);
    }
    const list = el('div', 'cc-list');
    for (const computer of state.computers.filter((m) => filter === 'all' || m.connectionType === filter)) {
      const row = button('', () => details(computer.deviceId), 'cc-computer');
      const text = el('span', 'cc-computer-text');
      text.append(el('strong', null, computer.name), el('small', null, computer.self ? 'My computer · This computer' : `${computer.connectionType === 'personal' ? 'My computer' : 'AI only'} · ${computer.disconnected ? 'Disconnected' : computer.online ? computer.transport === 'internet' ? 'Internet' : 'Wi-Fi' : 'Offline'}`));
      const shares = [computer.sharing.length && `Sharing ${computer.sharing.map((p) => names[p]).join(', ')}`, computer.receiving.length && `Receiving ${computer.receiving.map((p) => names[p]).join(', ')}`].filter(Boolean).join(' · ');
      if (shares) text.append(el('small', null, shares));
      row.append(el('i', `rm-dot ${computer.online ? 'rm-online' : 'rm-offline'}`), text, el('span', null, '›')); list.append(row);
    }
    if (!list.childElementCount) list.append(note(filter === 'all' ? 'Connect another computer to work across your devices or share AI.' : 'No computers in this group.'));
    const connect = button('Connect computer', connectStep, 'st-primary');
    body.replaceChildren(count, filters, list, connect);
    if (state.migration?.legacyDeviceIds?.length) body.append(note('Existing connections need approval again to verify their identity. Saved chats and project copies remain on their original computers.'));
  }
  function details(id) {
    selected = id; view = 'details';
    const computer = state.computers.find((m) => m.deviceId === id);
    title.textContent = computer.name;
    body.replaceChildren(el('h3', 'cc-title', computer.name), note(computer.self ? 'This computer' : `${computer.online ? 'Online' : 'Offline'} · ${computer.transport === 'internet' ? 'Internet' : 'Wi-Fi'}`));
    if (computer.self) {
      body.append(note(`Computer identity: ${id}`), note('Manage installed and shared providers in Settings → AI Tools.'));
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
      if (!confirm('I own this computer and approve this connection to access its files, terminals and conversations.')) return;
      await api('PATCH', `/api/connections/${id}`, { computerAccess: true, confirmOwnership: true });
      await refresh(); details(id);
    })));
    body.append(el('h3', 'cc-label', 'Access type'), el('p', null, computer.connectionType === 'personal' ? 'My computer' : 'AI only'));
    if (computer.connectionType === 'personal') {
      const access = el('input'); access.type = 'checkbox'; access.checked = computer.computerAccess;
      const label = field('Allow this computer to access my files, terminal and settings', access);
      access.onchange = () => run(async () => {
        const on = access.checked;
        if (on && !confirm('I own this computer and approve access to its files, terminals, settings and conversations.')) { access.checked = false; return; }
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
      if (!confirm(`Disconnect ${computer.name}? Its access and shared AI sessions will stop.`)) return;
      await api('DELETE', `/api/connections/${id}`); await refresh(); showList();
    }), 'st-btn st-danger'));
  }
  function connectStep() {
    view = 'connect'; generation++; title.textContent = 'Connect computer';
    let type = 'personal';
    const choice = el('div', 'cc-choices');
    for (const [key, label, description] of [['personal', 'My computer', 'Access and manage another computer you own.'], ['external', "Someone else’s computer", 'Share AI without granting computer access.']]) {
      const radio = el('input'); radio.type = 'radio'; radio.name = 'computer-type'; radio.value = key; radio.checked = key === type;
      radio.onchange = () => { type = key; };
      const text = el('span'); text.append(el('strong', null, label), el('small', null, description));
      const labelNode = el('label', 'cc-choice'); labelNode.append(radio, text); choice.append(labelNode);
    }
    body.replaceChildren(note('1 of 2'), el('h3', 'cc-title', 'Whose computer is it?'), choice, button('Continue', () => exchange(type), 'st-primary'));
  }
  function exchange(type) {
    view = 'connect'; title.textContent = 'Connect computer';
    const received = input('Paste connection details or enter a code'), address = input('Computer address, e.g. http://192.168.1.24:7777');
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
        await refresh(); showList();
      }), 'st-primary'));
  }
  function onKey(event) { if (screen === root && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey);
  const timer = setInterval(() => { if (view === 'list' && !working) refresh(); }, 10000);
  showList(); refresh(); back.focus();
}
