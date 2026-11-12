// Messages: one group chat and a direct chat per person, for owner devices, collaborators, guests and the Mac.
// Phones and guest pages call startPhoneMessages (a full-screen view with a live socket); the Admin page calls
// mountMacMessages (an embedded copy that polls). The server decides who sees what; this file only shows it.

const KIND = { device: 'Device', collaborator: 'Collaborator', guest: 'Guest' };
const MB = 1024 * 1024;
const NEAR_BOTTOM = 80;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
const sizeText = (n) => (n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const who = (p) => (p.kind === 'collaborator' || p.kind === 'guest' ? `${p.name} (${p.kind})` : p.name);
function timeText(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
const ICON = {
  back: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  attach: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8z"/></svg>',
  tick: '<svg viewBox="0 0 16 11" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1.5 5.8 3.4 3.4L11 2.2"/></svg>',
};
// WhatsApp's day labels: Today, Yesterday, a weekday inside the last week, then the date.
function dayLabel(at) {
  const d = new Date(at), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const clockText = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'file').toUpperCase();
const fileUrl = (f, extra = '') => `/api/messages/files/${f.id}${extra}`;

// The guest page has no copyText; plain http has no navigator.clipboard, so this falls back to execCommand.
async function copyText(text) {
  if (window.copyText) return window.copyText(text);
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const area = el('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  area.remove();
  return ok;
}

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// `api(method, url, body)` is the page's JSON helper. `writeHeader` is the header the server wants on writes.
function createMessagesView(root, { api, writeHeader, embedded, readKey, onUnread = () => {}, onIncoming = () => {}, onClose }) {
  const state = { you: null, people: new Map(), messages: new Map(), limits: {}, chat: null, online: false, shown: embedded, uploads: [] };
  let read = store.get(readKey);
  const firstRun = !read;
  read ??= {};
  const bubbles = new Map();

  root.classList.add('mx', embedded ? 'mx-embedded' : 'mx-screen');
  root.classList.toggle('mx-in-chat', false);
  const listPane = el('section', 'mx-pane mx-list-pane');
  const listHead = el('div', 'mx-head');
  const close = el('button', 'mx-icon', '✕');
  close.setAttribute('aria-label', 'Close Messages');
  close.onclick = () => onClose?.();
  close.hidden = embedded;
  const listTitle = el('h2', 'mx-title', 'Messages');
  const status = el('span', 'mx-status');
  listHead.append(close, listTitle, status);
  const chats = el('div', 'mx-chats mx-scroll');
  listPane.append(listHead, chats);

  const convo = el('section', 'mx-pane mx-convo-pane');
  const convoHead = el('div', 'mx-head');
  const back = el('button', 'mx-icon mx-back');
  back.innerHTML = ICON.back;
  back.setAttribute('aria-label', 'All chats');
  back.onclick = () => openChat(null);
  const heading = el('div', 'mx-heading');
  const convoTitle = el('h2', 'mx-title');
  const convoSub = el('span', 'mx-sub');
  heading.append(convoTitle, convoSub);
  const convoAvatar = el('span', 'mx-avatar');
  convoHead.append(back, convoAvatar, heading);
  const log = el('div', 'mx-log mx-scroll');
  log.setAttribute('aria-live', 'polite');
  const pill = el('button', 'mx-pill', '↓ New messages');
  pill.hidden = true;
  pill.onclick = () => scrollToEnd(true);
  const tray = el('div', 'mx-tray');
  const error = el('p', 'mx-error');
  error.setAttribute('role', 'alert');
  const form = el('form', 'mx-compose');
  const attach = el('button', 'mx-icon mx-attach');
  attach.innerHTML = ICON.attach;
  attach.type = 'button';
  attach.setAttribute('aria-label', 'Attach files');
  const picker = el('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  const input = el('textarea', 'mx-input');
  input.rows = 1;
  input.placeholder = 'Message';
  input.setAttribute('aria-label', 'Message');
  const send = el('button', 'mx-send');
  send.innerHTML = ICON.send;
  send.setAttribute('aria-label', 'Send');
  form.append(attach, picker, input, send);
  const gone = el('p', 'mx-gone', 'This person is no longer in Messages.');
  convo.append(convoHead, log, pill, tray, error, gone, form);

  const viewer = el('div', 'mx-viewer');
  viewer.hidden = true;
  const viewerImg = el('img');
  const viewerBar = el('div', 'mx-viewer-bar');
  const viewerDownload = el('a', 'mx-btn', 'Download');
  const viewerClose = el('button', 'mx-btn', 'Close');
  viewerBar.append(viewerDownload, viewerClose);
  viewer.append(viewerImg, viewerBar);
  viewerClose.onclick = () => { viewer.hidden = true; };
  viewer.addEventListener('keydown', (e) => { if (e.key === 'Escape') viewer.hidden = true; });
  viewer.onclick = (e) => { if (e.target === viewer) viewer.hidden = true; };
  const body = el('div', 'mx-body');
  body.append(listPane, convo, viewer);
  root.append(body);

  const chatOf = (m) => m.chat;
  const inChat = (id) => [...state.messages.values()].filter((m) => chatOf(m) === id).sort((a, b) => a.seq - b.seq);
  const lastSeq = () => Math.max(0, ...state.messages.keys());
  const visible = () => state.shown && !document.hidden;
  const unreadIn = (id) => inChat(id).filter((m) => !m.mine && m.seq > (read[id] ?? 0)).length;

  function chatList() {
    const rows = new Map([['everyone', { id: 'everyone', name: 'Everyone', kind: 'group' }]]);
    for (const p of state.people.values()) rows.set(p.id, { ...p, here: true });
    for (const m of state.messages.values()) {
      if (m.chat === 'everyone' || rows.has(m.chat)) continue;
      rows.set(m.chat, { id: m.chat, ...(m.mine ? m.to : m.from), here: false });
    }
    const last = (id) => inChat(id).at(-1)?.seq ?? 0;
    return [...rows.values()].sort((a, b) => (a.id === 'everyone' ? -1 : b.id === 'everyone' ? 1 : last(b.id) - last(a.id) || a.name.localeCompare(b.name)));
  }

  function markRead() {
    if (!state.chat || !visible()) return;
    const latest = inChat(state.chat).at(-1)?.seq ?? 0;
    if ((read[state.chat] ?? 0) >= latest) return;
    read[state.chat] = latest;
    store.set(readKey, read);
  }

  function renderStatus() {
    status.textContent = state.online ? '' : 'connecting…';
    let total = 0;
    for (const c of chatList()) total += unreadIn(c.id);
    onUnread(total);
  }

  function renderChats() {
    chats.replaceChildren();
    for (const c of chatList()) {
      const unread = unreadIn(c.id);
      const row = el('button', `mx-row${c.id === state.chat ? ' on' : ''}${unread ? ' unread' : ''}`);
      const avatar = el('span', `mx-avatar mx-k-${c.kind}`, c.kind === 'group' ? '#' : c.name.slice(0, 1).toUpperCase());
      const main = el('span', 'mx-row-main');
      const top = el('span', 'mx-row-top');
      top.append(el('b', 'mx-row-name', c.name), el('span', 'mx-row-kind', c.kind === 'group' ? `${state.people.size + 1} people` : !c.here ? 'No longer here' : c.kind === 'mac' ? '' : KIND[c.kind]));
      const latest = inChat(c.id).at(-1);
      const preview = latest ? `${latest.mine ? 'You: ' : c.id === 'everyone' ? `${latest.from.name}: ` : ''}${latest.text.split('\n')[0] || `📎 ${latest.files.length === 1 ? latest.files[0].name : `${latest.files.length} files`}`}` : 'No messages yet';
      main.append(top, el('span', 'mx-row-preview', preview));
      const side = el('span', 'mx-row-side');
      if (latest) side.append(el('time', 'mx-row-time', timeText(latest.at)));
      if (unread) side.append(el('span', 'mx-count', String(unread)));
      row.append(avatar, main, side);
      row.onclick = () => openChat(c.id, true);
      chats.append(row);
    }
  }

  function openViewer(f) {
    viewerImg.onerror = () => { viewerImg.onerror = null; viewerImg.src = fileUrl(f, '/thumb'); };
    viewerImg.src = fileUrl(f);
    viewerImg.alt = f.name;
    viewerDownload.href = fileUrl(f, '?download=1');
    viewerDownload.download = f.name;
    viewer.hidden = false;
    viewerClose.focus();
  }

  function attachmentNode(f) {
    const wrap = el('div', `mx-file mx-file-${f.kind}`);
    if (f.kind === 'image') {
      const open = el('button', 'mx-thumb-btn');
      open.setAttribute('aria-label', `Open ${f.name}`);
      const img = el('img', 'mx-thumb');
      img.alt = f.name;
      img.loading = 'lazy';
      img.src = fileUrl(f, '/thumb');
      img.onload = () => keepAtEnd();
      img.onerror = () => { img.replaceWith(el('span', 'mx-noprev', f.name)); };
      open.append(img);
      open.onclick = () => openViewer(f);
      wrap.append(open);
    } else if (f.kind === 'video' || f.kind === 'audio') {
      const media = el(f.kind);
      media.controls = true;
      media.preload = 'metadata';
      media.src = fileUrl(f);
      media.setAttribute('aria-label', f.name);
      if (f.kind === 'video') media.playsInline = true;
      wrap.append(media);
    } else {
      const card = el('div', 'mx-card');
      card.append(el('span', 'mx-ext', extOf(f.name)));
      const info = el('span', 'mx-card-info');
      info.append(el('b', 'mx-card-name', f.name), el('small', null, sizeText(f.size)));
      const download = el('a', 'mx-dl', '↓');
      download.href = fileUrl(f, '?download=1');
      download.download = f.name;
      download.setAttribute('aria-label', `Download ${f.name}`);
      card.append(info, download);
      wrap.append(card);
    }
    return wrap;
  }

  // Sender names in the group get one colour each, picked from the sender's id so it stays put between visits.
  const NAME_HUES = [4, 28, 48, 96, 150, 178, 200, 228, 262, 290, 320, 340];
  const nameColor = (id) => `hsl(${NAME_HUES[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_HUES.length]} 70% 66%)`;

  // A run is consecutive messages from one sender on one day; only its first bubble gets the tail and the name.
  function bubble(m, prev = inChat(m.chat).filter((x) => x.seq < m.seq).at(-1)) {
    const newDay = !prev || !sameDay(prev.at, m.at);
    const first = newDay || prev.mine !== m.mine || (!m.mine && prev.from.id !== m.from.id);
    const node = el('article', `mx-msg${m.mine ? ' mine' : ''}${first ? ' first' : ''}`);
    node.dataset.seq = m.seq;
    if (newDay) node.append(el('span', 'mx-day', dayLabel(m.at)));
    const body = el('div', 'mx-bubble');
    if (!m.mine && m.chat === 'everyone' && first) {
      const from = el('div', 'mx-from', m.from.name);
      from.style.color = nameColor(m.from.id);
      if (m.from.kind === 'collaborator' || m.from.kind === 'guest') from.append(el('span', 'mx-tag', m.from.kind));
      body.append(from);
    }
    if (m.text) body.append(el('div', 'mx-text', m.text));
    for (const f of m.files) body.append(attachmentNode(f));
    const meta = el('div', 'mx-meta');
    const more = el('button', 'mx-more', '⋯');
    more.setAttribute('aria-label', 'Message actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = () => openMenu(m, more);
    const tick = el('span', 'mx-tick');
    tick.innerHTML = ICON.tick;
    if (m.origin) { const o = el('span', 'mx-origin', `from ${m.origin.deviceName}`); o.title = 'Sent from another device in your room'; meta.append(o); }
    meta.append(el('time', null, clockText(m.at)), ...(m.mine ? [tick] : []), more);
    body.append(meta);
    node.append(body);
    // Right-click, and long-press on Android, arrive as contextmenu; iOS Safari has none, so touch waits itself.
    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('a, video, audio')) return;
      e.preventDefault();
      openMenu(m, more);
    });
    let press = null;
    node.addEventListener('touchstart', (e) => {
      const [t] = e.touches;
      press = { x: t.clientX, y: t.clientY, timer: setTimeout(() => { press = null; openMenu(m, more); }, 550) };
    }, { passive: true });
    const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
    node.addEventListener('touchmove', (e) => {
      const [t] = e.touches;
      if (press && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) cancel();
    }, { passive: true });
    node.addEventListener('touchend', cancel);
    node.addEventListener('touchcancel', cancel);
    return node;
  }

  let menuFor = null;
  function closeMenu() {
    if (!menuFor) return;
    menu.hidden = true;
    menuFor.button.focus({ preventScroll: true });
    menuFor.node.classList.remove('picked');
    menuFor = null;
  }
  function openMenu(m, button) {
    closeMenu();
    const node = bubbles.get(m.seq);
    if (!node) return;
    menuFor = { button, node };
    node.classList.add('picked');
    const items = [];
    const item = (label, run, cls = '') => {
      const b = el('button', `mx-menu-item ${cls}`, label);
      b.setAttribute('role', 'menuitem');
      b.onclick = async () => { closeMenu(); await run(); };
      items.push(b);
    };
    if (m.text) item('Copy', async () => flash((await copyText(m.text)) ? 'Copied' : 'Could not copy. Select the text instead.'));
    for (const f of m.files) {
      const a = el('a', 'mx-menu-item', m.files.length === 1 ? 'Download' : `Download ${f.name}`);
      a.setAttribute('role', 'menuitem');
      a.href = fileUrl(f, '?download=1');
      a.download = f.name;
      a.onclick = () => closeMenu();
      items.push(a);
    }
    if (m.canDelete) item('Delete for everyone', () => drop(m, true), 'danger');
    item('Hide for me', () => drop(m, false));
    item('Cancel', () => {}, 'cancel');
    menuList.replaceChildren(...items);
    menu.hidden = false;
    items[0].focus({ preventScroll: true });
  }
  async function drop(m, everyone) {
    if (everyone && !confirm('Delete this message for everyone? Its files are deleted from the device too.')) return;
    try {
      await api(everyone ? 'DELETE' : 'POST', everyone ? `/api/messages/${m.seq}` : `/api/messages/${m.seq}/hide`, everyone ? undefined : {});
      remove([m.seq]);
    } catch (err) { showError(err.message); }
  }
  const menu = el('div', 'mx-menu');
  menu.hidden = true;
  const menuList = el('div', 'mx-menu-list');
  menuList.setAttribute('role', 'menu');
  menuList.setAttribute('aria-label', 'Message actions');
  menu.append(menuList);
  menu.onclick = (e) => { if (e.target === menu) closeMenu(); };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...menuList.children];
      all[(all.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
    }
  });
  const flashNote = el('div', 'mx-flash');
  flashNote.hidden = true;
  let flashTimer;
  function flash(text) {
    flashNote.textContent = text;
    flashNote.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashNote.hidden = true; }, 1600);
  }
  convo.append(menu, flashNote);

  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  let stick = true;
  log.addEventListener('scroll', () => {
    stick = atEnd();
    if (stick) pill.hidden = true;
  });
  function scrollToEnd(force) {
    if (!force && !stick) return;
    log.scrollTop = log.scrollHeight;
    stick = true;
    pill.hidden = true;
  }
  const keepAtEnd = () => { if (stick) log.scrollTop = log.scrollHeight; };

  function renderConvo() {
    root.classList.toggle('mx-in-chat', state.chat !== null);
    if (state.chat === null) return;
    const c = chatList().find((x) => x.id === state.chat) ?? { id: state.chat, name: 'Chat', kind: 'group', here: false };
    convoTitle.textContent = c.name;
    convoAvatar.className = `mx-avatar mx-k-${c.kind}`;
    convoAvatar.textContent = c.kind === 'group' ? '#' : c.name.slice(0, 1).toUpperCase();
    convoSub.textContent = c.kind === 'group' ? `Everyone in Messages · ${state.people.size + 1} people` : !c.here ? 'No longer here' : c.kind === 'mac' ? 'This computer, from its Admin page or pocket-dev message' : KIND[c.kind];
    const open = c.id === 'everyone' || c.here;
    form.hidden = !open;
    tray.hidden = !open;
    gone.hidden = open;
  }

  function rebuildLog() {
    bubbles.clear();
    log.replaceChildren();
    let prev;
    for (const m of inChat(state.chat)) {
      const node = bubble(m, prev);
      prev = m;
      bubbles.set(m.seq, node);
      log.append(node);
    }
    if (!bubbles.size) log.append(el('p', 'mx-empty', state.chat === 'everyone' ? 'Say something to everyone.' : 'No messages yet.'));
    scrollToEnd(true);
  }

  function openChat(id, focus = false) {
    state.chat = id;
    error.textContent = '';
    renderConvo();
    renderChats();
    if (id !== null) {
      rebuildLog();
      markRead();
      if (focus && !matchMedia('(pointer: coarse)').matches) input.focus();
    }
    renderStatus();
  }

  function add(list, live) {
    const fresh = list.filter((m) => !state.messages.has(m.seq));
    for (const m of fresh) state.messages.set(m.seq, m);
    if (state.chat !== null) {
      const here = fresh.filter((m) => m.chat === state.chat).sort((a, b) => a.seq - b.seq);
      if (here.length) {
        const wasAtEnd = stick;
        log.querySelector('.mx-empty')?.remove();
        for (const m of here) {
          const node = bubble(m);
          bubbles.set(m.seq, node);
          const after = [...bubbles.keys()].filter((s) => s > m.seq).sort((a, b) => a - b)[0];
          if (after !== undefined) log.insertBefore(node, bubbles.get(after));
          else log.append(node);
        }
        if (wasAtEnd || here.some((m) => m.mine)) scrollToEnd(true);
        else pill.hidden = false;
      }
    }
    markRead();
    renderChats();
    renderConvo();
    renderStatus();
    if (live) for (const m of fresh) if (!m.mine && !(visible() && (state.chat === null || m.chat === state.chat))) onIncoming(m);
  }

  function remove(seqs) {
    for (const seq of seqs) {
      state.messages.delete(seq);
      bubbles.get(seq)?.remove();
      bubbles.delete(seq);
    }
    renderChats();
    renderStatus();
  }

  // A hello or poll: who is here, the limits, and the messages after our cursor. `keep` lists every message still
  // visible, so anything deleted, hidden or cleared while we were away goes too.
  function sync({ you, people, limits, messages, keep }) {
    state.you = you;
    state.people = new Map(people.map((p) => [p.id, p]));
    state.limits = limits ?? {};
    const keepSet = new Set(keep);
    const stale = [...state.messages.keys()].filter((seq) => !keepSet.has(seq));
    if (stale.length) remove(stale);
    if (firstRun && !Object.keys(read).length) {
      for (const m of messages) read[m.chat] = Math.max(read[m.chat] ?? 0, m.seq);
      store.set(readKey, read);
    }
    add(messages, false);
  }

  function receive(msg) {
    if (msg.t === 'hello') sync(msg);
    else if (msg.t === 'message') add([msg.message], true);
    else if (msg.t === 'removed') remove(msg.seqs);
  }

  function showError(text) { error.textContent = text; }

  // The socket's hello names who was here then; someone who logs in later shows up on the next look.
  async function refreshPeople() {
    if (!state.you) return;
    try {
      const { people } = await api('GET', '/api/messages/people');
      state.people = new Map(people.map((p) => [p.id, p]));
      renderChats();
      renderConvo();
    } catch {}
  }
  setInterval(() => { if (visible() && !embedded) refreshPeople(); }, 15000);

  // Refusals the server would give, shown before a byte is sent: Cloudflare answers an oversized body with its own page.
  function refusalFor(file) {
    const { fileMax, lowSpace, largeFile, freeBytes, reserveBytes } = state.limits;
    if (fileMax && file.size > fileMax) return `Over the internet you can send files up to 100 MB. This file is ${sizeText(file.size)}. Connect on the same Wi-Fi as the device to send it.`;
    if (lowSpace && file.size > largeFile) return `The device is low on space (${sizeText(freeBytes)} free). Files over 50 MB are paused until there's more than ${sizeText(reserveBytes)} free. Text and files up to 50 MB still work.`;
    return null;
  }

  function renderTray() {
    tray.replaceChildren();
    for (const u of state.uploads) {
      const chip = el('div', `mx-chip mx-chip-${u.status}`);
      const label = u.status === 'uploading' ? `${Math.floor((100 * u.loaded) / (u.file.size || 1))}%` : u.status === 'error' ? u.error : sizeText(u.file.size);
      chip.append(el('span', 'mx-chip-name', u.file.name), el('span', 'mx-chip-state', label));
      const x = el('button', 'mx-chip-x', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', u.status === 'uploading' ? `Cancel ${u.file.name}` : `Remove ${u.file.name}`);
      x.onclick = () => {
        u.xhr?.abort();
        state.uploads = state.uploads.filter((v) => v !== u);
        renderTray();
      };
      chip.append(x);
      tray.append(chip);
    }
    const busy = state.uploads.some((u) => u.status === 'uploading');
    send.disabled = busy || (!input.value.trim() && !state.uploads.some((u) => u.status === 'done'));
  }

  function upload(u) {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('POST', '/api/messages/files');
    xhr.setRequestHeader(writeHeader, '1');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(u.file.name));
    xhr.upload.onprogress = (e) => { u.loaded = e.loaded; renderTray(); };
    const finish = (status, error) => { Object.assign(u, { status, error, xhr: null }); renderTray(); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) return location.replace('/login.html');
      if (xhr.status !== 201) return finish('error', data?.error || `HTTP ${xhr.status}`);
      u.id = data.id;
      finish('done', null);
    };
    xhr.onerror = () => finish('error', 'Network error');
    xhr.send(u.file);
  }

  attach.onclick = () => picker.click();
  picker.onchange = () => {
    error.textContent = '';
    for (const file of picker.files) {
      const refusal = refusalFor(file);
      if (refusal) { showError(refusal); continue; }
      const u = { file, status: 'uploading', loaded: 0, id: null, error: null, xhr: null };
      state.uploads.push(u);
      upload(u);
    }
    picker.value = '';
    renderTray();
  };
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    renderTray();
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !matchMedia('(pointer: coarse)').matches))) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (send.disabled) return;
    const done = state.uploads.filter((u) => u.status === 'done');
    const text = input.value;
    send.disabled = true;
    try {
      const m = await api('POST', '/api/messages', { text, to: state.chat === 'everyone' ? null : state.chat, files: done.map((u) => u.id) });
      if (input.value === text) input.value = '';
      state.uploads = state.uploads.filter((u) => !done.includes(u));
      error.textContent = '';
      grow();
      add([m], false);
    } catch (err) {
      showError(err.message);
    }
    renderTray();
  };
  document.addEventListener('visibilitychange', () => { markRead(); renderStatus(); });
  renderTray();
  openChat(embedded ? 'everyone' : null);

  return {
    receive,
    sync,
    lastSeq,
    setOnline(on) { state.online = on; renderStatus(); },
    show(chat) {
      state.shown = true;
      openChat(chat === undefined ? state.chat : chat);
      refreshPeople();
    },
    hide() {
      state.shown = false;
      viewer.hidden = true;
    },
  };
}

// The phone and guest page: a full-screen view over the current one, a socket that stays open in the background
// for toasts and the unread badge, and window.pocketDevMessages.open(chat).
export function startPhoneMessages({ api = window.api, badgeOn } = {}) {
  // index.html already explains a missing connection.js (an older server); Messages stays closed until a restart.
  if (typeof window.PocketDevConnection !== 'function') return null;
  const root = el('div');
  root.hidden = true;
  document.body.append(root);
  const toast = el('button', 'mx-toast');
  toast.hidden = true;
  document.body.append(toast);
  const badge = el('span', 'mx-badge');
  badge.hidden = true;
  badgeOn?.append(badge);
  let toastTimer;
  // Same contract as index.html's pocketDev.overlays; the guest page has none, so the view closes without history.
  const overlays = window.pocketDev?.overlays ?? { open() {}, close(name) { if (name === 'messages') closed(); } };
  let open = false;
  const closed = () => { open = false; root.hidden = true; view.hide(); };
  const view = createMessagesView(root, {
    api, writeHeader: 'x-pocket-dev', embedded: false, readKey: 'pd.messages.read',
    onClose: () => overlays.close('messages'),
    onUnread: (n) => { badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n); },
    onIncoming: (m) => {
      toast.replaceChildren(el('b', null, m.chat === 'everyone' ? `${who(m.from)} in Everyone` : who(m.from)), el('span', null, m.text.split('\n')[0] || `📎 ${m.files.map((f) => f.name).join(', ')}`));
      toast.hidden = false;
      toast.onclick = () => { toast.hidden = true; show(m.chat); };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
    },
  });
  function show(chat) {
    if (!open) {
      open = true;
      root.hidden = false;
      overlays.open('messages', closed);
    }
    view.show(chat);
  }
  const connection = new window.PocketDevConnection({
    url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/messages?after=${view.lastSeq()}`,
    waitForHello: true,
    onMessage: (msg) => view.receive(msg),
    onState: (s) => view.setOnline(s === 'connected'),
  });
  window.pocketDevMessages = { open: show, connection };
  return window.pocketDevMessages;
}

// The Admin page takes part as the Mac. It polls instead of holding a socket, and adds storage and clearing.
export function mountMacMessages(section, { api, toast = () => {} }) {
  const head = el('div', 'panel-head');
  head.append(el('h2', null, 'Messages'));
  const usage = el('span', 'count');
  head.append(usage);
  const host = el('div', 'mx-host');
  const storage = el('details', 'mx-storage');
  storage.append(el('summary', null, 'Storage'));
  const storageBody = el('div', 'mx-storage-body');
  storage.append(storageBody);
  const note = el('p', 'note', 'Messages, photos, videos and files shared between this Mac, your devices and the people you invite. Pocket Dev never reads or writes the clipboard: paste with ⌘V, or run pbpaste | pocket-dev message.');
  section.replaceChildren(head, note, host, storage);
  const view = createMessagesView(host, { api, writeHeader: 'x-pocket-admin', embedded: true, readKey: 'pd.messages.read.mac' });

  async function renderStorage() {
    const s = await api('GET', '/api/messages/storage');
    usage.textContent = `${sizeText(s.usage)} of files · ${sizeText(s.freeBytes)} free on this device`;
    storageBody.replaceChildren();
    if (s.lowSpace) storageBody.append(el('p', 'err', `Low on space: files over 50 MB wait until more than ${sizeText(s.reserveBytes)} is free.`));
    for (const c of s.chats) {
      const row = el('div', 'mx-storage-row');
      row.append(el('span', null, `${c.title} · ${c.count} message${c.count === 1 ? '' : 's'} · ${sizeText(c.bytes)}`));
      const clear = el('button', 'btn btn-sm', 'Clear');
      clear.onclick = () => wipe({ chat: c.id }, `Clear ${c.title}? Its messages and files are deleted for everyone.`);
      row.append(clear);
      storageBody.append(row);
    }
    if (!s.chats.length) storageBody.append(el('p', 'note', 'No messages yet.'));
    else {
      const all = el('button', 'btn btn-danger-outline', 'Clear all');
      all.onclick = () => wipe({}, 'Clear every chat? All messages and files are deleted for everyone.');
      storageBody.append(all);
    }
  }
  async function wipe(body, question) {
    if (!confirm(question)) return;
    try {
      const r = await api('POST', '/api/messages/clear', body);
      toast(`Cleared ${r.removed} message${r.removed === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message, true); }
    poll();
  }

  let polling = false;
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      view.sync(await api('GET', `/api/messages?after=${view.lastSeq()}`));
      view.setOnline(true);
      await renderStorage();
    } catch {
      view.setOnline(false);
    } finally {
      polling = false;
    }
  }
  setInterval(poll, 2000);
  document.addEventListener('visibilitychange', poll);
  poll();
  return { refresh: poll };
}
