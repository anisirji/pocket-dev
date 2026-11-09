// Room pages: Tasks and Room chats, opened over the app from the Room screen or the header button (shown only in a room).
// The pure helpers at the top are exported so test/room-pages.test.mjs can run them in node; the page code below runs only in a browser.

export const STATUSES = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']];
export const statusLabel = (s) => (STATUSES.find(([k]) => k === s) || [s, s])[1];

// { todo: [...], doing: [...], done: [...] }. "mine" keeps tasks assigned to this device. Newest edit first within a group.
export function groupTasks(tasks, { filter = 'all', selfId = null } = {}) {
  const groups = { todo: [], doing: [], done: [] };
  for (const t of tasks) {
    if (filter === 'mine' && t.assignee !== selfId) continue;
    (groups[t.status] || groups.todo).push(t);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return groups;
}

const nameOf = (members, id) => members.find((m) => m.deviceId === id)?.name;
export const assigneeText = (task, members, selfId) => !task.assignee ? 'Unassigned' : task.assignee === selfId ? 'You' : nameOf(members, task.assignee) || 'Left the room';
export const creatorText = (task, members, selfId) => task.createdBy === selfId ? 'you' : nameOf(members, task.createdBy) || task.createdByName || 'unknown';

// A task shows as editable text only; the form sends just what changed, and nothing when nothing did.
export function taskChanges(task, form) {
  const out = {};
  for (const k of ['title', 'description', 'status', 'assignee']) if ((form[k] ?? null) !== (task[k] ?? null)) out[k] = form[k];
  return out;
}

export function taskProblem(form) {
  if (!String(form.title || '').trim()) return 'Give the task a title.';
  if (form.title.length > 200) return 'The title is too long (200 characters at most).';
  if ((form.description || '').length > 4000) return 'The description is too long (4000 characters at most).';
  return '';
}

export function agoText(ms, now = Date.now()) {
  if (!ms) return 'no activity';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const chatTitle = (c) => (c.title && c.title.trim()) || 'Untitled chat';

// One mirrored event as a plain description the page draws. Streaming and unknown kinds are dropped.
export function describeEvent(ev) {
  const blobs = ev.blobs || {};
  const images = (ev.images || []).map((name) => ({ blobId: `img:${name}`, name, ...blobStatus(blobs[`img:${name}`]) }));
  const files = Object.entries(blobs).filter(([id]) => id.startsWith('att:')).map(([blobId, m]) => ({ blobId, name: blobId.slice(4), ...blobStatus(m) }));
  switch (ev.type) {
    case 'user-text': return { kind: 'user', text: ev.text || '', files };
    case 'assistant-text': return ev.text ? { kind: 'assistant', text: ev.text } : null;
    case 'thinking': return null;
    case 'tool-run': return { kind: 'tool', title: ev.name || 'Tool', summary: ev.summary || '', input: ev.input || '', output: ev.output || '', failed: ev.status === 'error', images, truncated: !!ev.truncated };
    case 'file-edit': return { kind: 'edit', path: ev.path || '', diff: ev.diff || '', truncated: !!ev.truncated };
    case 'error': return { kind: 'error', text: ev.message || 'Error' };
    case 'status': return ev.text ? { kind: 'status', text: ev.text } : null;
    case 'result': return { kind: 'status', text: 'Turn finished' };
    default: return null;
  }
}
const blobStatus = (m) => !m ? { state: 'missing' } : m.tooLarge ? { state: 'large', size: m.size } : m.missing ? { state: 'missing' } : { state: 'ready', size: m.size };

export const sizeText = (n) => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Small mark for a message that came from another device (messages.js passes the message's origin).
export const originLabel = (m) => m && m.origin ? (m.origin.deviceName || 'another device') : '';

export function friendly(message, offline = false) {
  const m = String(message || '');
  if (offline || /failed to fetch|networkerror|load failed/i.test(m)) return 'This phone is offline. Check its connection and try again.';
  if (/not in a room/i.test(m)) return 'This device is not in a room.';
  return m || 'Something went wrong. Try again.';
}

if (typeof document !== 'undefined') {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { 'x-pocket-dev': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (res.status === 401) { location.replace('/login.html'); throw new Error('Not logged in'); }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  };
  const fail = (e) => friendly(e?.message, navigator.onLine === false);

  const link = el('link'); link.rel = 'stylesheet'; link.href = '/room-pages.css'; document.head.append(link);

  let overlay = null, closeTimer = 0;

  // Opens a page over the app. `build(body, ctx)` fills the body and may return { stop }.
  function open(page) {
    close();
    overlay = el('div', 'rp');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    const head = el('header', 'rp-head');
    const back = button('←', close, 'rp-back'); back.setAttribute('aria-label', 'Close');
    const title = el('h2', '', page === 'tasks' ? 'Tasks' : page === 'chats' ? 'Room chats' : 'Room');
    const actions = el('div', 'rp-head-actions');
    head.append(back, title, actions);
    const body = el('div', 'rp-body');
    overlay.append(head, body);
    document.body.append(overlay);
    window.pocketDev?.overlays?.open('room-page', finish);
    const view = (page === 'tasks' ? tasksPage : chatsPage)(body, { actions, title, back });
    overlay.stop = view?.stop;
  }
  function finish() {
    clearInterval(closeTimer);
    if (!overlay) return;
    overlay.stop?.();
    overlay.remove(); overlay = null;
  }
  // The page owns one history entry, so the Android back gesture closes it and lands on the screen below.
  function close() { if (overlay) window.pocketDev?.overlays?.close('room-page'); finish(); }

  const roomInfo = async () => {
    const s = await call('GET', '/api/room');
    return { selfId: s.deviceId, members: s.room?.members || [], inRoom: !!s.room };
  };

  // ---------- Tasks ----------
  function tasksPage(body, { actions }) {
    let tasks = [], info = { selfId: null, members: [] }, filter = 'all', error = '', loaded = false, form = null, stopped = false, busy = false;
    const list = el('div', 'rp-list');
    const newBtn = button('+ New', () => edit(null), 'rp-primary');
    actions.append(newBtn);
    body.append(list);

    async function load() {
      if (busy) return;
      try {
        const [i, r] = await Promise.all([roomInfo(), call('GET', '/api/room/tasks')]);
        if (stopped) return;
        info = i; tasks = r.tasks; error = ''; loaded = true;
        newBtn.hidden = false;
      } catch (e) { error = fail(e); newBtn.hidden = !loaded; }
      if (!form) render();
    }

    async function run(fn) {
      if (busy) return;
      busy = true;
      try { await fn(); error = ''; } catch (e) { error = fail(e); }
      busy = false;
      await load();
    }

    function render() {
      const kids = [];
      const seg = el('div', 'rp-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Filter');
      for (const [k, t] of [['all', 'All'], ['mine', 'Mine']]) {
        const b = button(t, () => { filter = k; render(); }, k === filter ? 'on' : ''); b.setAttribute('aria-pressed', String(k === filter)); seg.append(b);
      }
      kids.push(seg);
      if (error) kids.push(el('p', 'rp-error', error), ...(loaded ? [] : [button('Try again', load)]));
      if (!loaded && !error) kids.push(el('p', 'rp-note', 'Loading...'));
      if (loaded) {
        if (!info.inRoom) kids.push(el('p', 'rp-note', 'This device is not in a room. Join or create one in Settings.'));
        else if (!tasks.length) kids.push(emptyBox('No tasks yet', 'Tasks you add here are shared with every device in the room, even when one of them is off.'));
        else {
          const groups = groupTasks(tasks, { filter, selfId: info.selfId });
          if (filter === 'mine' && !Object.values(groups).some((g) => g.length)) kids.push(emptyBox('Nothing assigned to you', 'Switch to All to see every task in the room.'));
          else for (const [status, label] of STATUSES) kids.push(group(status, label, groups[status]));
        }
      }
      list.replaceChildren(...kids);
    }

    const emptyBox = (h, p) => { const d = el('div', 'rp-empty'); d.append(el('h3', '', h), el('p', 'rp-note', p)); return d; };

    function group(status, label, items) {
      const s = el('section', 'rp-group');
      s.append(el('h3', '', `${label} (${items.length})`));
      if (!items.length) s.append(el('p', 'rp-note rp-none', 'Nothing here'));
      for (const t of items) s.append(card(t));
      return s;
    }

    function card(t) {
      const c = el('article', `rp-card rp-s-${t.status}`);
      const open = button('', () => edit(t), 'rp-card-main');
      open.setAttribute('aria-label', `Edit ${t.id}: ${t.title}`);
      open.append(el('span', 'rp-id', t.id), el('span', 'rp-title', t.title),
        el('span', 'rp-meta', `${assigneeText(t, info.members, info.selfId)} · by ${creatorText(t, info.members, info.selfId)}`));
      const seg = el('div', 'rp-status');
      for (const [k, label] of STATUSES) {
        const b = button(label, () => run(() => call('PATCH', `/api/room/tasks/${t.id}`, { status: k })), k === t.status ? 'on' : '');
        b.setAttribute('aria-pressed', String(k === t.status)); seg.append(b);
      }
      c.append(open, seg);
      return c;
    }

    function edit(t) {
      const f = { title: t?.title || '', description: t?.description || '', status: t?.status || 'todo', assignee: t ? t.assignee : info.selfId };
      form = el('div', 'rp-sheet');
      const sheet = el('div', 'rp-form');
      sheet.append(el('h3', '', t ? `Edit ${t.id}` : 'New task'));
      const title = el('input'); title.value = f.title; title.placeholder = 'Title'; title.maxLength = 200; title.setAttribute('aria-label', 'Title');
      const desc = el('textarea'); desc.value = f.description; desc.rows = 4; desc.placeholder = 'Description (optional)'; desc.setAttribute('aria-label', 'Description');
      const who = el('select'); who.setAttribute('aria-label', 'Assignee');
      const none = el('option', '', 'Unassigned'); none.value = ''; who.append(none);
      for (const m of info.members) { const o = el('option', '', m.deviceId === info.selfId ? `${m.name} (this device)` : m.name); o.value = m.deviceId; who.append(o); }
      if (f.assignee && !info.members.some((m) => m.deviceId === f.assignee)) { const o = el('option', '', 'Left the room'); o.value = f.assignee; who.append(o); }
      who.value = f.assignee || '';
      const st = el('select'); st.setAttribute('aria-label', 'Status');
      for (const [k, label] of STATUSES) { const o = el('option', '', label); o.value = k; st.append(o); }
      st.value = f.status;
      const err = el('p', 'rp-error'); err.setAttribute('role', 'alert');
      const row = el('div', 'rp-row');
      const save = button(t ? 'Save' : 'Create', async () => {
        const next = { title: title.value.trim(), description: desc.value, status: st.value, assignee: who.value || null };
        err.textContent = taskProblem(next);
        if (err.textContent) return;
        save.disabled = true;
        try {
          if (t) { const changes = taskChanges(t, next); if (Object.keys(changes).length) await call('PATCH', `/api/room/tasks/${t.id}`, changes); }
          else await call('POST', '/api/room/tasks', next);
          closeForm(); load();
        } catch (e) { err.textContent = fail(e); save.disabled = false; }
      }, 'rp-primary');
      row.append(save, button('Cancel', closeForm));
      sheet.append(label('Title', title), label('Description', desc), label('Assignee', who), label('Status', st), err, row);
      if (t) sheet.append(button('Delete task', () => {
        if (!confirm(`Delete ${t.id}? It is removed on every device in the room.`)) return;
        call('DELETE', `/api/room/tasks/${t.id}`).then(() => { closeForm(); load(); }).catch((e) => { err.textContent = fail(e); });
      }, 'rp-danger'));
      form.append(sheet);
      overlay.append(form);
      title.focus();
    }
    const label = (text, input) => { const l = el('label', 'rp-field'); l.append(el('span', '', text), input); return l; };
    function closeForm() { form?.remove(); form = null; render(); }

    load();
    closeTimer = setInterval(load, 5000);
    return { stop() { stopped = true; clearInterval(closeTimer); } };
  }

  // ---------- Room chats ----------
  function chatsPage(body, { title, back }) {
    let timer = 0, stopped = false, opened = null;
    const defaultBack = back.onclick;

    async function showList() {
      opened = null; title.textContent = 'Room chats'; back.onclick = defaultBack;
      body.replaceChildren(el('p', 'rp-note', 'Loading...'));
      try {
        const { chats } = await call('GET', '/api/room/chats');
        if (stopped || opened) return;
        const kids = [];
        if (!chats.length) {
          const d = el('div', 'rp-empty'); d.append(el('h3', '', 'No chats from other devices'),
            el('p', 'rp-note', 'AI chats of other devices appear here, read-only, when those devices joined the room with Admin access. A device that joined as a Collaborator shares none, and this device shares its own chats only when it is Admin too.'));
          kids.push(d);
        } else {
          kids.push(el('p', 'rp-note', 'These are copies. Each chat belongs to the device named on it, and you cannot write in it from here.'));
          for (const c of chats) kids.push(chatRow(c));
        }
        body.replaceChildren(...kids);
      } catch (e) { const r = button('Try again', showList); body.replaceChildren(el('p', 'rp-error', fail(e)), r); }
    }

    function chatRow(c) {
      const b = button('', () => showChat(c), 'rp-chat');
      const top = el('span', 'rp-chat-top'); top.append(el('span', 'rp-title', chatTitle(c)), el('span', 'rp-badge', 'Read-only'));
      b.append(top, el('span', 'rp-meta', `${c.deviceName || 'Another device'} · ${agoText(c.updatedAt)}${c.tool ? ` · ${c.tool}` : ''}`));
      return b;
    }

    async function showChat(c) {
      opened = c; title.textContent = chatTitle(c); back.onclick = showList;
      const banner = el('p', 'rp-banner', `Read-only copy. This chat belongs to ${c.deviceName || 'another device'}; you cannot reply from here.`);
      body.replaceChildren(banner, el('p', 'rp-note', 'Loading...'));
      try {
        const full = await call('GET', `/api/room/chats/${encodeURIComponent(c.deviceId)}/${encodeURIComponent(c.chatId)}`);
        if (stopped || opened !== c) return;
        const parts = full.events.map(describeEvent).filter(Boolean);
        const kids = [banner];
        if (!parts.length) kids.push(el('p', 'rp-note', 'No messages in this copy yet.'));
        for (const p of parts) kids.push(eventNode(p, c));
        body.replaceChildren(...kids);
      } catch (e) { body.replaceChildren(banner, el('p', 'rp-error', fail(e)), button('Try again', () => showChat(c))); }
    }

    function eventNode(p, c) {
      if (p.kind === 'user' || p.kind === 'assistant') {
        const d = el('div', `rp-msg rp-${p.kind}`);
        if (p.text) d.append(el('div', 'rp-text', p.text));
        for (const f of p.files || []) d.append(blobNode(f, c, false));
        return d;
      }
      if (p.kind === 'tool') {
        const d = el('details', `rp-tool${p.failed ? ' failed' : ''}`);
        const s = el('summary'); s.append(el('b', '', p.title)); if (p.summary) s.append(el('span', 'rp-meta', p.summary));
        d.append(s);
        if (p.input) d.append(el('pre', '', p.input));
        if (p.output) d.append(el('pre', '', p.output));
        for (const im of p.images) d.append(blobNode(im, c, true));
        if (p.truncated) d.append(el('p', 'rp-note', 'Shortened for sharing.'));
        return d;
      }
      if (p.kind === 'edit') {
        const d = el('details', 'rp-tool');
        d.append(el('summary', '', `Edited ${p.path}`), el('pre', 'rp-diff', p.diff || 'No diff kept.'));
        return d;
      }
      return el('div', `rp-ev-${p.kind}`, p.text);
    }

    // A picture or file: a placeholder until tapped; the bytes are fetched then (the server copies them from the owning device).
    function blobNode(f, c, image) {
      const url = `/api/room/chats/${encodeURIComponent(c.deviceId)}/${encodeURIComponent(c.chatId)}/blob/${encodeURIComponent(f.blobId)}`;
      const box = el('div', 'rp-blob');
      if (f.state === 'large') { box.append(el('span', 'rp-note', `${f.name}: too large to copy here (${sizeText(f.size)}). Open it on ${c.deviceName || 'the other device'}.`)); return box; }
      if (f.state === 'missing') { box.append(el('span', 'rp-note', `${f.name}: not available.`)); return box; }
      const show = button(`${image ? 'Show image' : 'Download'} ${f.name}${f.size ? ` (${sizeText(f.size)})` : ''}`, async () => {
        if (!image) { location.href = url; return; }
        show.disabled = true; show.textContent = 'Loading image...';
        const img = new Image(); img.alt = f.name;
        img.onload = () => show.replaceWith(img);
        img.onerror = () => { show.disabled = false; show.textContent = 'Could not load the image. Tap to try again.'; };
        img.src = url;
      }, 'rp-show');
      box.append(show);
      return box;
    }

    showList();
    timer = setInterval(() => { if (!opened) showList(); }, 15000);
    return { stop() { stopped = true; clearInterval(timer); } };
  }

  // ---------- header button, only in a room ----------
  const api = { open, close };
  window.PocketDevRoomPages = api;
  const head = document.querySelector('header');
  const gear = document.getElementById('settingsBtn');
  if (head && gear) {
    const b = el('button', 'icon-btn glyph', '⇄');
    b.id = 'roomTasksBtn'; b.type = 'button'; b.hidden = true; b.title = 'Room'; b.setAttribute('aria-label', 'Room');
    b.onclick = () => import('/room-screen.js').then((m) => m.openRoom());
    gear.before(b);
    const check = async () => { try { b.hidden = !(await roomInfo()).inRoom; } catch { /* keep the last state */ } };
    check(); setInterval(check, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }
}
