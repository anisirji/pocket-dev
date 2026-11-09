// The Room screen (opened from Settings or the header). The pure helpers at the top are exported so test/room-screen.test.mjs can run them without a browser.

import { hostAddress, shortAddress, inviteLine, inviteProblem, parseInvite, joinError, isLoopbackAddress, formatCode } from './room-invite.js';
export { hostAddress };

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

export function joinProblem({ code, host, level, folders }) {
  if (!code.trim()) return 'Type the code from the host.';
  if (!host.trim()) return 'Type the address of the host.';
  if (level === 'collaborator' && !folders.some((f) => f.trim())) return 'Choose at least one folder to share, or pick Admin.';
  return '';
}

export const friendlyError = (message, { offline = false } = {}) => joinError(message, { offline });

export const statusLine = (state) => !state?.room ? 'Not in a room'
  : state.room.role === 'host' ? `Host of ${state.room.members.length} ${state.room.members.length === 1 ? 'device' : 'devices'}`
    : `Member of ${state.room.members.find((m) => m.deviceId === state.room.hostId)?.name ?? 'the host'}'s room`;


// ---------- the screen (browser only) ----------
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };
const field = (text, input) => { const l = el('label', 'co-field', text); input.setAttribute('aria-label', text); l.append(input); return l; };
const input = (placeholder, type = 'text') => { const i = el('input'); i.type = type; i.placeholder = placeholder; i.autocomplete = 'off'; i.autocapitalize = 'off'; i.spellcheck = false; return i; };
const api = (...args) => window.api(...args);

// Copy works on plain http pages too, where navigator.clipboard is missing.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const t = el('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select();
  try { return document.execCommand('copy'); } finally { t.remove(); }
}

let qrLoading;
const loadQr = () => window.PocketDevQr ? Promise.resolve() : qrLoading ||= new Promise((ok, no) => {
  const s = el('script'); s.src = '/vendor/qrcode/qrcode.js'; s.onload = ok; s.onerror = () => { qrLoading = null; no(new Error('QR failed')); }; document.head.append(s);
});

let screen = null;
export function openRoom() {
  if (screen) return;
  const { overlays } = window.pocketDev || {};
  let state = null, loadError = '', notice = null, busy = false, sig = '', polling = false;
  const sheets = new Set();
  const root = el('div', 'rs co');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Room');
  const back = button('←', () => (overlays ? overlays.close('room') : closeScreen()), 'rs-back'); back.setAttribute('aria-label', 'Close Room');
  const head = el('header', 'rs-head'); head.append(back, el('h2', '', 'Room'));
  const body = el('div', 'rs-body');
  root.append(head, body);
  document.body.append(root);
  screen = root;

  const offline = () => navigator.onLine === false;
  const message = el('p', 'co-error'); message.setAttribute('role', 'alert');

  const permissions = el('details', 'rs-perm');
  permissions.append(el('summary', '', 'Permissions: what other devices may do here'));
  const modesHost = el('div', 'md-host');
  permissions.append(el('p', 'co-note', 'Choose what each device in the room may do on this device, and who answers when a device asks for permission.'), modesHost);
  let modes = null;
  function loadModes() {
    if (modes) return;
    modes = import('/room-modes.js').then((m) => { const x = m.mountModes(modesHost, { api }); x.refresh(); return x; })
      .catch((err) => { modesHost.textContent = `Could not load the permission controls: ${err.message}. Reload this page.`; });
  }
  permissions.addEventListener('toggle', () => { if (permissions.open) loadModes(); });

  async function refresh(force) {
    if (polling) return;
    polling = true;
    try { state = await api('GET', '/api/room?live=1'); loadError = ''; }
    catch (err) { loadError = joinError(err?.message, { offline: offline() }); }
    finally { polling = false; }
    const next = JSON.stringify([state?.room?.members?.map((m) => [m.deviceId, m.name, m.status, m.online, m.role, m.level]), state?.room?.role, state?.room?.revoked?.length, loadError, !!state]);
    if (force || next !== sig) { sig = next; render(); }
  }
  async function act(run) {
    if (busy) return;
    busy = true; message.textContent = '';
    try { await run(); } catch (err) { message.textContent = joinError(err?.message, { offline: offline() }); }
    finally { busy = false; await refresh(true); }
  }

  function render() {
    const kids = [];
    if (!state) {
      kids.push(el('p', 'rs-status', loadError || 'Loading...'));
      if (loadError) kids.push(button('Try again', () => refresh(true)));
      body.replaceChildren(...kids, message);
      return;
    }
    const room = state.room;
    kids.push(el('p', 'rs-status', statusLine(state)));
    if (loadError) kids.push(el('p', 'co-error', `${loadError} Showing what was last known.`));
    if (!room) {
      kids.push(el('p', 'co-note', 'A room links your devices so they can see each other and share work. One device is the host and decides who joins.'));
      kids.push(button('Join a room', () => joinSheet(), 'rs-main'));
      kids.push(button('Start a room on this device', () => act(() => api('POST', '/api/room/create', {})), 'rs-second'));
    } else {
      const host = room.role === 'host';
      const hostMember = room.members.find((m) => m.deviceId === room.hostId);
      if (!host && hostMember && memberState(hostMember, state.deviceId) === 'offline') kids.push(el('p', 'co-error', 'The host is not answering. Check that it is on, awake and connected. This room works again when it is back.'));
      if (notice) kids.push(noticeCard());
      const list = el('ul', 'rs-devices');
      for (const m of sortMembers(room.members, room.hostId)) list.append(memberItem(m, host));
      kids.push(list);
      if (host) kids.push(button('Add a device', () => inviteSheet(), 'rs-main'));
      else kids.push(button('Leave', () => { if (confirm('Leave this room? This device loses access to the other devices and they lose access to it.')) act(() => api('POST', '/api/room/leave')); }, 'rs-main rs-danger'));
      kids.push(el('h3', 'rs-h', 'Shared work'));
      const work = el('div', 'rs-row');
      work.append(button('Tasks', () => window.PocketDevRoomPages?.open('tasks')), button('Room chats', () => window.PocketDevRoomPages?.open('chats')), button('Approvals', () => window.PocketDevApprovals?.open()));
      kids.push(work, permissions);
      if (room.revoked?.length) kids.push(el('p', 'co-note', `Removed devices: ${room.revoked.map((r) => r.name).join(', ')}`));
      if (host && room.members.length > 1) kids.push(el('p', 'co-note', 'To leave as host, make another device the host first (Manage on that device).'));
      if (host && room.members.length === 1) kids.push(button('Close room', () => { if (confirm('Close this room? It is removed from this device.')) act(() => api('POST', '/api/room/leave')); }, 'rs-danger'));
      if (!host && state.advertised?.length) kids.push(el('p', 'co-note', `This device tells the others it is at ${shortAddress(state.advertised[0])}.`));
    }
    body.replaceChildren(...kids, message);
  }

  function memberItem(m, host) {
    const st = memberState(m, state.deviceId), self = m.deviceId === state.deviceId;
    const li = el('li', 'rs-dev');
    const top = el('div', 'rs-dev-top');
    const dot = el('span', `rm-dot rm-${st}`); dot.setAttribute('aria-hidden', 'true');
    const name = el('span', 'rs-dev-name'); name.append(dot, `${m.name}${self ? ' (this device)' : ''}`);
    top.append(name, el('span', 'co-role', m.role === 'host' ? 'Host' : st === 'online' ? 'Online' : st === 'offline' ? 'Offline' : ''));
    li.append(top);
    const detail = st === 'offline' && m.lastSeen ? `Offline, ${lastSeenText(m.lastSeen)}. ` : '';
    li.append(el('p', 'co-note', `${detail}${levelText(m)}`));
    if (host && !self) {
      const d = el('details', 'rs-manage');
      d.append(el('summary', '', 'Manage'));
      const a = el('div', 'rs-row');
      a.append(
        button('Make host', () => { if (confirm(`Make ${m.name} the host? This device becomes a member and can no longer add or remove devices.`)) act(() => api('POST', '/api/room/handover', { deviceId: m.deviceId })); }),
        button('Remove', () => { if (confirm(`Remove ${m.name} from the room? It loses access straight away and needs a new code to come back.`)) act(() => api('POST', '/api/room/kick', { deviceId: m.deviceId })); }, 'rs-danger'));
      d.append(a);
      li.append(d);
    }
    return li;
  }

  // Joined, but the host could not call this device back.
  function noticeCard() {
    const card = el('div', 'rs-warn');
    card.append(el('p', '', `Joined, but the host cannot reach this device at ${shortAddress(notice.address)}. Check the firewall and that both devices are on the same Wi-Fi.`));
    const addr = input('This device address, like 192.168.1.50:7777'); addr.value = shortAddress(notice.address);
    const err = el('p', 'co-error');
    card.append(field('Address the host should use for this device', addr), button('Save and test', async () => {
      err.textContent = '';
      const a = hostAddress(addr.value);
      const bad = inviteProblem({ host: a, code: 'AAAAAAAA', allowLoopback: state?.allowLoopback });
      if (bad && !/code/i.test(bad)) { err.textContent = bad; return; }
      try {
        const r = await api('POST', '/api/room/address', { addresses: [a] });
        if (r.callback?.ok) { notice = null; await refresh(true); } else { notice = r.callback; render(); }
      } catch (e) { err.textContent = joinError(e.message, { offline: offline() }); }
    }, 'rs-second'), err);
    return card;
  }

  // ----- bottom sheets -----
  function sheet(title, build) {
    const back = el('div', 'rs-back-drop');
    const box = el('div', 'rs-sheet');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
    const cleanups = [];
    const handle = { onClose: (fn) => cleanups.push(fn), close() { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } } back.remove(); sheets.delete(handle); } };
    const top = el('div', 'rs-sheet-top');
    top.append(el('h3', '', title), button('✕', () => handle.close(), 'rs-x'));
    top.lastChild.setAttribute('aria-label', 'Close');
    box.append(top);
    back.onclick = (e) => { if (e.target === back) handle.close(); };
    build(box, handle);
    back.append(box);
    root.append(back);
    sheets.add(handle);
    return handle;
  }

  function inviteSheet() {
    sheet('Add a device', (box, h) => {
      const content = el('div', 'rs-invite');
      box.append(content);
      let timer = 0, poll = 0, current = null;
      const startCount = state.room.members.length;
      h.onClose(() => { clearInterval(timer); clearInterval(poll); });
      const tickText = () => {
        if (!current) return '';
        const s = Math.max(0, Math.round((current.expiresAt - Date.now()) / 1000));
        return s ? `Works once. Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'This code has expired.';
      };
      async function load() {
        content.replaceChildren(el('p', 'co-note', 'Making an invite...'));
        let r;
        try { r = await api('POST', '/api/room/invite'); }
        catch (err) { content.replaceChildren(el('p', 'co-error', joinError(err.message, { offline: offline() })), button('Try again', load)); return; }
        let svg = '';
        try { await loadQr(); svg = window.PocketDevQr.svg(r.invite); } catch { /* the code and line still work without the picture */ }
        current = { ...r, expiresAt: Date.now() + r.expiresInSeconds * 1000 };
        const code = el('div', 'rs-code', r.code); code.setAttribute('aria-label', 'Invite code');
        const line = el('div', 'rs-line', r.invite); line.setAttribute('aria-label', 'Invite');
        const copied = el('span', 'co-note');
        const actions = el('div', 'rs-row');
        actions.append(button('Copy', async () => { copied.textContent = (await copyText(r.invite)) ? 'Copied.' : 'Could not copy. Select the line and copy it.'; }, 'rs-second'));
        if (navigator.share) actions.append(button('Share', () => navigator.share({ title: 'Join my Pocket Dev room', text: r.invite }).catch(() => {}), 'rs-second'));
        actions.append(copied);
        const timerEl = el('p', 'co-note rm-timer', tickText());
        clearInterval(timer);
        timer = setInterval(() => { timerEl.textContent = tickText(); }, 1000);
        const kids = [el('p', 'co-note', 'Type this code on the other device, or scan the picture.'), code, line, actions];
        if (svg) { const q = el('div', 'rs-qr'); q.innerHTML = svg; kids.push(q); }
        kids.push(timerEl, el('p', 'co-note', `On the other device: Settings, Room, Join a room. The host address is ${shortAddress(r.address)}.`), button('Get a new code', load, 'rs-link'));
        content.replaceChildren(...kids);
      }
      poll = setInterval(async () => {
        try {
          const s = await api('GET', '/api/room');
          if (s.room && s.room.members.length > startCount) {
            const joiner = s.room.members.at(-1);
            clearInterval(poll); clearInterval(timer);
            content.replaceChildren(el('p', 'rs-joined', `${joiner.name} joined.`), button('Done', () => h.close(), 'rs-main'));
            refresh(true);
          }
        } catch { /* try again on the next tick */ }
      }, 3000);
      load();
    });
  }

  function joinSheet() {
    sheet('Join a room', (box, h) => {
      const invite = el('textarea'); invite.rows = 2; invite.placeholder = '192.168.1.24:7777  ABCD-EFGH';
      invite.autocapitalize = 'off'; invite.spellcheck = false; invite.autocomplete = 'off';
      const host = input('Host address, like 192.168.1.24:7777'); host.inputMode = 'url';
      const hostField = field('Address of the host', host); hostField.hidden = true;
      const parsed = el('p', 'co-note');
      const advertised = state.advertised?.[0] ? shortAddress(state.advertised[0]) : '';
      const mine = input('This device address, like 192.168.1.50:7777'); mine.value = advertised;
      const name = input('This device name (optional)');
      const level = el('select');
      for (const [v, t] of [['collaborator', 'Only the folders I choose'], ['admin', 'Everything on this device']]) { const o = el('option', '', t); o.value = v; level.append(o); }
      const folders = el('div'); const rows = [];
      const addRow = () => {
        const i = el('input'); i.type = 'text'; rows.push(i);
        folders.append(window.PocketDevFolderPicker?.field(i, { api, label: `Folder ${rows.length}` }) ?? field(`Folder ${rows.length}`, i));
      };
      addRow();
      const foldersBox = el('div', 'co-field'); foldersBox.append(el('span', '', 'Folders other devices may use here'), folders, button('Add another folder', addRow));
      level.onchange = () => { foldersBox.hidden = level.value === 'admin'; };
      const err = el('p', 'co-error'); err.setAttribute('role', 'alert');

      const read = () => {
        const p = parseInvite(invite.value);
        const hostValue = host.value.trim() ? hostAddress(host.value) : p.host;
        return { code: p.code, host: hostValue, typedOnly: !!invite.value.trim() };
      };
      const onInput = () => {
        const p = parseInvite(invite.value);
        if (p.code && !p.host) hostField.hidden = false; else if (p.host) hostField.hidden = true;
        parsed.textContent = p.code || p.host ? `Address: ${p.host ? shortAddress(p.host) : 'not given'}. Code: ${p.code ? formatCode(p.code) : 'not found'}.` : '';
        err.textContent = '';
      };
      invite.oninput = onInput;
      invite.onpaste = () => setTimeout(onInput, 0);

      // scan from the camera, or from a photo
      const scan = el('div', 'rs-scan');
      const video = el('video', 'rs-video'); video.hidden = true;
      const scanMsg = el('p', 'co-note');
      let camera = null;
      const stopCamera = () => { camera?.stop(); camera = null; video.hidden = true; cancelScan.hidden = true; };
      h.onClose(stopCamera);
      const fill = (text) => { invite.value = text; hostField.hidden = true; host.value = ''; onInput(); scanMsg.textContent = 'Read the invite. Check it below, then tap Join.'; };
      const cancelScan = button('Cancel scan', () => { stopCamera(); scanMsg.textContent = ''; }); cancelScan.hidden = true;
      const camBtn = button('Scan QR with camera', async () => {
        scanMsg.textContent = '';
        const scanner = await import('/room-scan.js');
        const support = scanner.cameraSupport({ isSecureContext: window.isSecureContext, hasCamera: !!navigator.mediaDevices?.getUserMedia, port: location.port });
        if (!support.ok) { scanMsg.textContent = support.text; return; }
        stopCamera();
        video.hidden = false; cancelScan.hidden = false;
        try { camera = await scanner.startCamera(video, (text) => { camera = null; stopCamera(); fill(text); }); }
        catch (e) { stopCamera(); scanMsg.textContent = scanner.cameraError(e); }
      });
      const photo = el('input'); photo.type = 'file'; photo.accept = 'image/*'; photo.setAttribute('capture', 'environment'); photo.hidden = true;
      photo.onchange = async () => {
        const file = photo.files?.[0]; photo.value = '';
        if (!file) return;
        scanMsg.textContent = 'Reading the photo...';
        try {
          const scanner = await import('/room-scan.js');
          const text = await scanner.decodePhoto(file);
          if (text) fill(text); else scanMsg.textContent = 'No QR code found in that photo. Try again closer, in focus, with the whole picture in view.';
        } catch { scanMsg.textContent = 'That file could not be read as a picture.'; }
      };
      const photoBtn = button('Choose a photo of the QR', () => photo.click());
      const scanRow = el('div', 'rs-row'); scanRow.append(camBtn, photoBtn, photo);
      scan.append(scanRow, video, cancelScan, scanMsg);

      const go = button('Join', async () => {
        const r = read();
        const allow = state.allowLoopback;
        const problem = inviteProblem({ host: r.host, code: r.code, allowLoopback: allow })
          || (level.value === 'collaborator' && !rows.some((x) => x.value.trim()) ? 'Choose at least one folder to share, or pick "Everything on this device".' : '');
        if (problem) { err.textContent = problem; if (r.code && !r.host) hostField.hidden = false; return; }
        const myAddress = mine.value.trim() ? hostAddress(mine.value) : '';
        if (myAddress && isLoopbackAddress(myAddress) && !allow) { err.textContent = `This device address cannot be ${shortAddress(myAddress)}: that means this device itself. Use its Wi-Fi address, like 192.168.1.50:7777.`; return; }
        if (busy) return;
        busy = true; go.disabled = true; err.textContent = '';
        try {
          const res = await api('POST', '/api/room/join', { name: name.value.trim() || undefined, code: r.code, host: r.host, level: level.value,
            ...(myAddress && { addresses: [myAddress] }), ...(level.value === 'collaborator' && { folders: rows.map((x) => x.value.trim()).filter(Boolean) }) });
          notice = res.callback && !res.callback.ok ? res.callback : null;
          h.close();
          busy = false;
          await refresh(true);
        } catch (e) { err.textContent = joinError(e.message, { host: r.host, offline: offline() }); busy = false; go.disabled = false; }
      }, 'rs-main');

      box.append(el('p', 'co-note', 'Ask the host to open Room and tap Add a device. The code works once and lasts 10 minutes.'),
        field('Paste the invite or type address and code', invite), parsed, hostField, scan,
        field('Name of this device (optional)', name),
        field('Address of this device (the host calls it back here)', mine),
        field('What can the room use on this device?', level), foldersBox, err, go);
      if (!advertised) box.append(el('p', 'co-note', 'This device could not work out its own Wi-Fi address. Type it above if the join says the host cannot reach it.'));
    });
  }

  function closeScreen() {
    for (const s of [...sheets]) s.close();
    clearInterval(pollTimer);
    root.remove();
    screen = null;
  }
  overlays?.open('room', closeScreen);
  const pollTimer = setInterval(() => { if (!document.hidden && !sheets.size) refresh(); }, 10_000);
  render();
  refresh(true);
}

export async function roomSummary() {
  const s = await api('GET', '/api/room');
  return statusLine(s);
}
