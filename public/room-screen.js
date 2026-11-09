// The Room screen in Settings. The pure helpers at the top are exported so test/room-screen.test.mjs can run them without a browser.

export function memberState(member, selfId) {
  if (member.deviceId === selfId) return 'online';
  if (member.status === 'online' || member.online === true) return 'online';
  if (member.status === 'offline' || member.online === false) return 'offline';
  return 'unknown';
}

export const levelText = (member) => member.level === 'admin' ? 'Admin: everything on this device'
  : `Collaborator: ${(member.folders || []).map((f) => f.split('/').filter(Boolean).pop() || f).join(', ') || 'no folders'}`;

// Host first, then the others in the order they joined.
export const sortMembers = (members, hostId) => [...members].sort((a, b) => (b.deviceId === hostId) - (a.deviceId === hostId) || a.joinedAt - b.joinedAt);

export function lastSeenText(ms, now = Date.now()) {
  if (!ms) return 'no answer';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'seen just now';
  if (s < 3600) return `seen ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `seen ${Math.floor(s / 3600)} h ago`;
  return `seen ${Math.floor(s / 86400)} d ago`;
}

// "192.168.1.5:7681" and "laptop.example.com" are fine to type; the server needs a full http or https address.
export function hostAddress(text) {
  const t = String(text || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return /^(\d{1,3}(\.\d{1,3}){3}|localhost)(:\d+)?$|:\d+$/i.test(t) ? `http://${t}` : `https://${t}`;
}

export function joinProblem({ code, host, level, folders }) {
  if (!code.trim()) return 'Type the join code from the host.';
  if (!host.trim()) return 'Type the address of the host.';
  if (level === 'collaborator' && !folders.some((f) => f.trim())) return 'Choose at least one folder to share, or pick Admin.';
  return '';
}

export function friendlyError(message, { offline = false } = {}) {
  const m = String(message || '');
  if (offline || /failed to fetch|networkerror|load failed/i.test(m)) return 'This phone is offline. Check its connection and try again.';
  if (/not valid|expired/i.test(m)) return 'That code is wrong or has expired. Ask the host for a new one.';
  if (/not in a room/i.test(m)) return 'That device is not hosting a room. Check the address, or create the room on the host first.';
  if (/already in a room/i.test(m)) return 'This device is already in a room.';
  if (/unreachable|fetch failed|timed out|timeout|ECONN|ENOTFOUND|did not (accept|take over)|HTTP 50[24]/i.test(m)) return 'Could not reach the other device. Check that it is on, awake and connected, and that the address is right.';
  return m || 'Something went wrong. Try again.';
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };
const field = (text, input) => { const l = el('label', 'co-field', text); input.setAttribute('aria-label', text); l.append(input); return l; };
const input = (placeholder, type = 'text') => { const i = el('input'); i.type = type; i.placeholder = placeholder; i.autocomplete = 'off'; i.autocapitalize = 'off'; i.spellcheck = false; return i; };

export function mountRoom(container, { api }) {
  container.className = 'co rm';
  let state = null, loadError = '', joinKids = null, joinGo = null, mode = 'home', invite = null, busy = false, inviteTimer = 0, polling = false;
  const sections = el('div');
  container.replaceChildren(sections);

  const offline = () => navigator.onLine === false;
  const fail = (err) => friendlyError(err?.message, { offline: offline() });

  async function refresh() {
    if (polling) return;
    polling = true;
    try { state = await api('GET', '/api/room?live=1'); loadError = ''; }
    catch (err) { loadError = fail(err); }
    finally { polling = false; }
    render();
  }

  async function act(run) {
    if (busy) return;
    busy = true; message.textContent = ''; if (joinGo) joinGo.disabled = true;
    try { await run(); mode = 'home'; joinKids = null; await refresh(); }
    catch (err) { message.textContent = fail(err); }
    finally { busy = false; if (joinGo) joinGo.disabled = false; render(); }
  }
  const message = el('p', 'co-error'); message.setAttribute('role', 'alert');

  // The server fills in this device's addresses when it knows them; on a plain local setup the address in the browser bar is the best guess.
  async function withAddress(path, body) {
    try { return await api('POST', path, body); }
    catch (err) { if (!/address/i.test(err.message)) throw err; return api('POST', path, { ...body, addresses: [location.origin] }); }
  }

  function render() {
    const kids = [el('h3', '', 'Room')];
    if (!state) {
      kids.push(el('p', 'co-note', loadError || 'Loading...'));
      if (loadError) kids.push(button('Try again', refresh));
    } else {
      if (loadError) kids.push(el('p', 'co-error', `${loadError} Showing what was last known.`));
      kids.push(...(state.room ? roomView(state.room) : mode === 'join' ? (joinKids ||= joinView()) : homeView()));
    }
    kids.push(message);
    sections.replaceChildren(...kids);
  }

  function homeView() {
    const actions = el('div', 'co-actions');
    actions.append(button('Create room', () => act(() => withAddress('/api/room/create', {})), 'co-primary'), button('Join room', () => { mode = 'join'; message.textContent = ''; render(); }));
    return [el('p', 'co-note', 'A room links your devices so they can see each other. One device is the host. It decides who joins.'), actions];
  }

  function roomView(room) {
    const host = room.role === 'host';
    const out = [];
    const hostMember = room.members.find((m) => m.deviceId === room.hostId);
    if (!host && hostMember && memberState(hostMember, state.deviceId) === 'offline') out.push(el('p', 'co-error', 'The host is not answering. Check that its Mac is on, awake and connected. This room works again when it is back.'));
    out.push(el('p', 'co-note', host ? 'This device is the host. You decide who joins and who leaves.' : `You are a member. ${hostMember ? hostMember.name : 'The host'} is the host.`));
    const list = el('ul', 'co-list');
    for (const m of sortMembers(room.members, room.hostId)) list.append(memberItem(m, room, host));
    out.push(list);
    const actions = el('div', 'co-actions');
    if (host) {
      actions.append(button(invite ? 'New code' : 'Invite a device', makeInvite, 'co-primary'));
      const alone = room.members.length === 1;
      if (alone) actions.append(button('Close room', () => { if (confirm('Close this room? It is removed from this device.')) act(() => api('POST', '/api/room/leave')); }, 'co-danger'));
    } else actions.append(button('Leave room', () => {
      if (confirm('Leave this room? This device loses access to the other devices and they lose access to it.')) act(() => api('POST', '/api/room/leave'));
    }, 'co-danger'));
    out.push(actions);
    const pages = el('div', 'co-actions');
    pages.append(button('Tasks', () => window.PocketDevRoomPages?.open('tasks'), 'co-primary'), button('Room chats', () => window.PocketDevRoomPages?.open('chats')), button('Approvals', () => window.PocketDevApprovals?.open()));
    out.push(pages);
    out.push(modesHost());
    if (host) {
      if (invite) out.push(inviteView());
      if (room.members.length > 1) out.push(el('p', 'co-note', 'To leave as host, hand the room over to another device first.'));
    }
    if (room.revoked?.length) out.push(el('p', 'co-note', `Removed devices: ${room.revoked.map((r) => r.name).join(', ')}`));
    return out;
  }

  // Who may do what on this device. Draws and refreshes itself; this screen only gives it a place.
  let modes = null;
  function modesHost() {
    if (modes) return modes.host;
    const host = el('div', 'md-host');
    modes = { host };
    import('/room-modes.js').then((m) => { modes.api = m.mountModes(host, { api }); modes.api.refresh(); })
      .catch((err) => { host.textContent = `Could not load the mode controls: ${err.message}. Reload this page.`; });
    return host;
  }

  function memberItem(m, room, host) {
    const st = memberState(m, state.deviceId), self = m.deviceId === state.deviceId;
    const li = el('li', 'co-item');
    const head = el('div', 'co-item-head');
    const title = el('h4', 'rm-name');
    const dot = el('span', `rm-dot rm-${st}`); dot.setAttribute('aria-hidden', 'true');
    title.append(dot, `${m.name}${self ? ' (this device)' : ''}`);
    head.append(title, el('span', 'co-role', m.role === 'host' ? 'Host' : 'Member'));
    const status = st === 'online' ? 'Online' : st === 'offline' ? (m.lastSeen ? `Offline, ${lastSeenText(m.lastSeen)}` : 'Offline') : 'Status not known';
    li.append(head, el('p', 'co-note', `${status}. ${levelText(m)}`));
    if (host && !self) {
      const a = el('div', 'co-actions');
      a.append(
        button('Make host', () => { if (confirm(`Make ${m.name} the host? This device becomes a member and can no longer invite or remove devices.`)) act(() => api('POST', '/api/room/handover', { deviceId: m.deviceId })); }),
        button('Remove', () => { if (confirm(`Remove ${m.name} from the room? It loses access straight away and needs a new code to come back.`)) act(() => api('POST', '/api/room/kick', { deviceId: m.deviceId })); }, 'co-danger'));
      li.append(a);
    }
    return li;
  }

  async function makeInvite() {
    if (busy) return;
    busy = true; message.textContent = '';
    try {
      const r = await api('POST', '/api/room/invite');
      const address = r.addresses?.[0] || location.origin;
      let svg = '';
      try { await loadQr(); svg = window.PocketDevQr.svg(`${address}\n${r.code}`); } catch { /* The code and address below still work without the picture. */ }
      invite = { ...r, address, svg, expiresAt: Date.now() + r.expiresInSeconds * 1000 };
      clearInterval(inviteTimer);
      inviteTimer = setInterval(() => { if (!container.isConnected) return clearInterval(inviteTimer); const t = container.querySelector('.rm-timer'); if (t) t.textContent = timerText(); }, 1000);
    } catch (err) { message.textContent = fail(err); }
    finally { busy = false; render(); }
  }
  const timerText = () => {
    const s = Math.max(0, Math.round((invite.expiresAt - Date.now()) / 1000));
    return s ? `Works once. Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'This code has expired. Make a new one.';
  };
  function inviteView() {
    const box = el('div', 'co-result');
    box.append(el('p', 'co-note', 'On the other device choose Join room, then type this code and address, or scan the picture.'));
    const code = el('textarea'); code.readOnly = true; code.rows = 2; code.value = invite.code; code.setAttribute('aria-label', 'Join code');
    box.append(code);
    if (invite.svg) { const q = el('div'); q.innerHTML = invite.svg; box.append(q.firstChild); }
    const addr = el('input'); addr.readOnly = true; addr.value = invite.address; addr.setAttribute('aria-label', 'Host address');
    box.append(field('Host address', addr), el('p', 'co-note rm-timer', timerText()));
    return box;
  }
  let qrLoading;
  const loadQr = () => window.PocketDevQr ? Promise.resolve() : qrLoading ||= new Promise((ok, no) => {
    const s = el('script'); s.src = '/vendor/qrcode/qrcode.js'; s.onload = ok; s.onerror = () => { qrLoading = null; no(new Error('QR failed')); }; document.head.append(s);
  });

  function joinView() {
    const name = input('This device name (optional)'), code = input('Join code'), host = input('Host address, for example 192.168.1.5:7681');
    host.inputMode = 'url';
    const level = el('select'); for (const [v, t] of [['collaborator', 'Collaborator: only the folders I choose'], ['admin', 'Admin: everything on this device']]) { const o = el('option', '', t); o.value = v; level.append(o); }
    const folders = el('div'); const rows = [];
    const addRow = () => {
      const i = el('input'); i.type = 'text'; rows.push(i);
      folders.append(window.PocketDevFolderPicker?.field(i, { api, label: `Folder ${rows.length}` }) ?? field(`Folder ${rows.length}`, i));
    };
    addRow();
    const foldersBox = el('div', 'co-field'); foldersBox.append(el('span', '', 'Folders other devices may use here'), folders, button('Add another folder', addRow));
    level.onchange = () => { foldersBox.hidden = level.value === 'admin'; };
    const err = el('p', 'co-error'); err.setAttribute('role', 'alert');
    const go = button('Join', () => {
      const values = { code: code.value, host: host.value, level: level.value, folders: rows.map((r) => r.value) };
      err.textContent = joinProblem(values);
      if (err.textContent) return;
      act(() => withAddress('/api/room/join', { name: name.value.trim() || undefined, code: values.code.trim(), host: hostAddress(values.host), level: values.level, ...(values.level === 'collaborator' && { folders: values.folders.map((f) => f.trim()).filter(Boolean) }) }));
    }, 'co-primary');
    joinGo = go;
    const form = el('div', 'co-form');
    form.append(el('p', 'co-note', 'Ask the host for a join code. It works once and expires after 10 minutes. You choose here what the room may use on this device.'),
      field('Join code', code), field('Host address', host), field('Name of this device', name), field('Access for the room', level), foldersBox, err);
    const actions = el('div', 'co-actions');
    actions.append(go, button('Cancel', () => { mode = 'home'; joinKids = null; message.textContent = ''; render(); }));
    return [form, actions];
  }

  setInterval(() => { if (container.isConnected && container.offsetParent && !busy && mode !== 'join') refresh(); }, 10_000);
  render();
  return { refresh };
}
