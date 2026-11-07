(() => {
  const TOOLS = { claude: 'Claude', codex: 'Codex' };
  const WAITING = ['waiting for you', 'wait'];
  const STATUS = {
    running: ['running', 'run'],
    'waiting-permission': WAITING,
    'waiting-answer': WAITING,
    idle: ['idle', 'idle'],
    error: ['error', 'err'],
    sleeping: ['sleeping', 'sleep'],
    closed: ['closed', 'sleep'],
  };
  const DECISIONS = { allow: 'Allowed', 'allow-chat': 'Allowed for this chat', deny: 'Denied' };
  const KINDS = { command: 'Run a command', file: 'Edit a file', tool: 'Use a tool', plan: 'Approve the plan' };
  const BACKOFF = [1000, 2000, 4000, 8000, 10000];
  const POLL_MS = 3000;
  const MAX_INPUT_PX = 140;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (cls, text, onclick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (onclick) b.onclick = onclick;
    return b;
  };
  const closeKeyboard = () => document.activeElement?.blur();
  // Buttons that take focus would close the phone keyboard, so swallow the press and act on click.
  function keepFocus(b) {
    b.tabIndex = -1;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
  }

  async function api(method, url, body, headers) {
    const raw = body instanceof Blob;
    const res = await fetch(url, {
      method,
      headers: raw ? headers : body ? { 'content-type': 'application/json' } : {},
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.replace('/login.html');
      throw new Error('Not logged in');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let optionsPromise = null;
  function loadOptions() {
    optionsPromise ??= api('GET', '/api/chat/options').catch((err) => {
      optionsPromise = null;
      throw err;
    });
    return optionsPromise;
  }
  let options = null;
  loadOptions().then((o) => { options = o; }, () => {});

  const tilde = (p) => (p || '').replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
  function shortPath(p) {
    const parts = tilde(p).split('/');
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  }
  const baseName = (p) => p.split('/').filter(Boolean).pop() || p;

  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function duration(ms) {
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
    return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  }
  const ticking = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };

  const badge = (tool) => el('span', `chat-badge chat-${tool}`, TOOLS[tool] || tool);
  const spinner = () => el('span', 'chat-spin');
  const isBusy = (c) => c.runningSince != null || c.status === 'running' || c.pending;
  const toolOptions = (tool) => options?.tools?.[tool];
  const findOpt = (list, value) => list?.find((o) => o.value === value);

  // Markdown-ish rendering builds DOM nodes from text, never HTML, so model output cannot inject markup.
  function inline(node, text) {
    const re = /`([^`\n]+)`|\*\*(.+?)\*\*/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      if (m[1] != null) node.append(el('code', 'chat-ic', m[1]));
      else node.append(inline(el('strong'), m[2]));
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
    return node;
  }

  function codeBlock(text, lang) {
    const wrap = el('div', 'chat-codewrap');
    if (lang) wrap.append(el('div', 'chat-code-lang', lang));
    wrap.append(el('pre', 'chat-code chat-pre', text));
    return wrap;
  }

  function md(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    let para = null;
    let list = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([^`\s]*)\s*$/);
      if (fence) {
        const body = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
        frag.append(codeBlock(body.join('\n'), fence[1]));
        para = list = null;
        continue;
      }
      if (!line.trim()) {
        para = list = null;
        continue;
      }
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        frag.append(inline(el('div', 'chat-md-h'), heading[1]));
        para = list = null;
        continue;
      }
      const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
        if (list?.localName !== tag) {
          list = el(tag, 'chat-md-list');
          if (tag === 'ol') list.start = parseInt(item[1], 10);
          frag.append(list);
        }
        para = null;
        list.append(inline(el('li'), item[2]));
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        inline(list.lastChild, ` ${line.trim()}`);
        continue;
      }
      list = null;
      if (para) para.append('\n');
      else frag.append((para = el('p', 'chat-md-p')));
      inline(para, line);
    }
    return frag;
  }

  function diffBlock(diff) {
    const box = el('div', 'chat-diff chat-pre');
    const inner = el('div', 'chat-diff-inner');
    for (const line of diff.replace(/\n$/, '').split('\n')) {
      const cls = /^(@@|\+\+\+ |--- )/.test(line) ? ' chat-dl-meta' : line[0] === '+' ? ' chat-dl-add' : line[0] === '-' ? ' chat-dl-del' : '';
      inner.append(el('div', `chat-dl${cls}`, line || ' '));
    }
    box.append(inner);
    return box;
  }
  function diffStats(diff) {
    let add = 0;
    let del = 0;
    for (const line of diff.split('\n')) {
      if (line[0] === '+' && !line.startsWith('+++ ')) add++;
      else if (line[0] === '-' && !line.startsWith('--- ')) del++;
    }
    return { add, del };
  }

  const root = el('div', 'chat');
  root.hidden = true;
  root.innerHTML = `
    <section class="chat-screen chat-list-screen">
      <header class="chat-head">
        <h2 class="chat-h2">Chats</h2>
        <button type="button" class="chat-icon chat-close" aria-label="Close chats">✕</button>
      </header>
      <div class="chat-scroll chat-rows"></div>
      <div class="chat-foot"><button type="button" class="chat-primary chat-new-btn">New chat</button></div>
    </section>
    <section class="chat-screen chat-convo-screen">
      <header class="chat-head">
        <button type="button" class="chat-icon chat-back" aria-label="Back to chats">‹</button>
        <div class="chat-head-main">
          <div class="chat-title"></div>
          <div class="chat-sub"></div>
        </div>
        <button type="button" class="chat-setchip" aria-label="Model and mode"></button>
      </header>
      <div class="chat-body">
        <div class="chat-scroll chat-log-scroll">
          <div class="chat-empty">Send a message to start.</div>
          <div class="chat-log"></div>
        </div>
        <button type="button" class="chat-latest" hidden>↓ latest</button>
        <div class="chat-conn" hidden></div>
      </div>
      <div class="chat-dock">
        <div class="chat-card" hidden></div>
        <div class="chat-statusline" hidden></div>
        <div class="chat-notice" hidden></div>
        <div class="chat-files" hidden></div>
        <form class="chat-composer">
          <button type="button" class="chat-attach" aria-label="Attach a file">📎</button>
          <textarea class="chat-input" rows="1" enterkeyhint="send" autocomplete="off" placeholder="Message"></textarea>
          <button type="submit" class="chat-send">Send</button>
        </form>
        <input class="chat-file-input" type="file" multiple hidden>
      </div>
    </section>
    <div class="chat-sheet-wrap chat-new-wrap" hidden><div class="chat-backdrop"></div><div class="chat-sheet chat-new-sheet"></div></div>
    <div class="chat-sheet-wrap chat-settings-wrap" hidden><div class="chat-backdrop"></div><div class="chat-sheet chat-settings-sheet"></div></div>`;
  document.body.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const ui = {
    listScreen: q('.chat-list-screen'), rows: q('.chat-rows'), newBtn: q('.chat-new-btn'), close: q('.chat-close'),
    convoScreen: q('.chat-convo-screen'), back: q('.chat-back'), title: q('.chat-title'), sub: q('.chat-sub'), setchip: q('.chat-setchip'),
    scroll: q('.chat-log-scroll'), empty: q('.chat-empty'), log: q('.chat-log'), latest: q('.chat-latest'), conn: q('.chat-conn'),
    card: q('.chat-card'), statusline: q('.chat-statusline'), notice: q('.chat-notice'), files: q('.chat-files'),
    composer: q('.chat-composer'), attach: q('.chat-attach'), input: q('.chat-input'), send: q('.chat-send'), fileInput: q('.chat-file-input'),
    newWrap: q('.chat-new-wrap'), newSheet: q('.chat-new-sheet'), settingsWrap: q('.chat-settings-wrap'), settingsSheet: q('.chat-settings-sheet'),
  };

  // Navigation: every history entry carries the whole layer stack, so popstate and reload just re-apply it.
  let stack = [];
  const convoIdOf = (s) => s.find((l) => l.layer === 'convo')?.id ?? null;
  const hasLayer = (s, layer) => s.some((l) => l.layer === layer);
  const hashFor = (s) => (convoIdOf(s) ? `#chat=${convoIdOf(s)}` : '#chat');
  const top = () => stack[stack.length - 1]?.layer;

  function push(...layers) {
    let next = stack;
    for (const layer of layers) {
      next = [...next, layer];
      history.pushState({ pdChat: next }, '', hashFor(next));
    }
    apply(next);
  }
  function replace(next) {
    history.replaceState({ pdChat: next }, '', hashFor(next));
    apply(next);
  }
  const back = () => history.back();
  const closeAll = () => stack.length && history.go(-stack.length);

  window.addEventListener('popstate', (e) => {
    const next = e.state?.pdChat;
    if (Array.isArray(next)) apply(next);
    else if (stack.length) apply([]);
  });

  function apply(next) {
    const prev = stack;
    stack = next;
    const id = convoIdOf(next);
    root.hidden = !next.length;
    ui.listScreen.hidden = !next.length || !!id;
    ui.convoScreen.hidden = !id;
    ui.newWrap.hidden = !hasLayer(next, 'new');
    ui.settingsWrap.hidden = !hasLayer(next, 'settings');
    if (id !== convoIdOf(prev)) {
      leaveConvo();
      if (id) enterConvo(id);
    }
    if (hasLayer(next, 'new') && !hasLayer(prev, 'new')) renderNewSheet();
    if (hasLayer(next, 'settings') && !hasLayer(prev, 'settings')) renderSettings();
    if (next.length && !id) refreshList();
    if (!next.length) {
      closeKeyboard();
      if (location.hash.startsWith('#chat')) history.replaceState(history.state, '', location.pathname + location.search);
    } else if (!prev.length) {
      closeKeyboard();
      fitViewport();
    }
  }

  function showChat(chat) {
    const convo = { layer: 'convo', id: chat.id };
    if (convo.id === convoIdOf(stack)) return;
    seed = chat.tool ? chat : null;
    if (!stack.length) push({ layer: 'list' }, convo);
    else if (top() === 'list') push(convo);
    else replace([{ layer: 'list' }, convo]);
  }

  // List screen.
  let list = [];
  let listKey = '';
  let listSeq = 0;
  const listVisible = () => stack.length && !convoIdOf(stack);

  async function refreshList() {
    const seq = ++listSeq;
    if (!list.length && !ui.rows.firstChild) ui.rows.replaceChildren(el('div', 'chat-placeholder', 'Loading chats…'));
    try {
      const items = await api('GET', '/api/chat');
      if (seq !== listSeq) return;
      // Replacing rows under a finger swallows the tap, so only rebuild when something visible changed.
      const key = JSON.stringify(items) + Math.floor(Date.now() / 60000);
      if (key === listKey && ui.rows.querySelector('.chat-row')) return;
      list = items;
      listKey = key;
      renderList();
    } catch (err) {
      if (seq !== listSeq || list.length) return;
      const box = el('div', 'chat-placeholder', `Could not load chats: ${err.message}`);
      box.append(button('chat-secondary chat-retry', 'Try again', refreshList));
      ui.rows.replaceChildren(box);
    }
  }

  function renderList() {
    if (!list.length) {
      ui.rows.replaceChildren(el('div', 'chat-placeholder', 'No chats yet. Start one to talk to Claude Code or Codex in a folder on this Mac.'));
      return;
    }
    ui.rows.replaceChildren(...list.map((c) => {
      const [label, cls] = c.pending ? WAITING : STATUS[c.status] || [c.status, 'idle'];
      const row = button(`chat-row${cls === 'wait' ? ' chat-row-wait' : ''}`, null, () => showChat(c));
      const line1 = el('div', 'chat-row-line');
      const chip = el('span', `chat-status chat-st-${cls}`);
      if (cls === 'run') chip.append(spinner());
      chip.append(label);
      line1.append(badge(c.tool), el('span', 'chat-row-title', c.title || 'New chat'), chip);
      const line2 = el('div', 'chat-row-line chat-row-meta');
      line2.append(el('span', 'chat-row-path', shortPath(c.cwd)), el('span', 'chat-row-time', ago(c.updatedAt)));
      row.append(line1, line2);
      return row;
    }));
  }

  setInterval(() => {
    if (listVisible() && !document.hidden) refreshList();
  }, POLL_MS);

  ui.close.onclick = closeAll;
  ui.newBtn.onclick = () => push({ layer: 'new' });
  for (const wrap of [ui.newWrap, ui.settingsWrap]) wrap.querySelector('.chat-backdrop').onclick = back;

  // Sheets.
  function field(label, control, hint) {
    const box = el('div', 'chat-field');
    if (control.matches('select, input')) control.setAttribute('aria-label', label);
    box.append(el('span', 'chat-label', label), control);
    if (hint) box.append(hint);
    return box;
  }
  function select(items, value, onchange) {
    const s = el('select', 'chat-select');
    for (const it of items || []) {
      const o = el('option', null, it.label || it.value);
      o.value = it.value;
      s.append(o);
    }
    if (value != null) s.value = value;
    s.onchange = () => onchange?.(s.value);
    return s;
  }
  function sheetHead(title) {
    const head = el('div', 'chat-sheet-head');
    head.append(el('h3', 'chat-h3', title), button('chat-icon', '✕', back));
    head.lastChild.setAttribute('aria-label', 'Close');
    return head;
  }
  const modeHint = (modes, value) => el('span', 'chat-hint', findOpt(modes, value)?.description || '');

  // /api/folders may be missing or shaped differently; accept strings or {path,name} in any of the known groups.
  async function loadFolders(opts) {
    const groups = [];
    const seen = new Set();
    const add = (label, items) => {
      const rows = [];
      for (const it of Array.isArray(items) ? items : []) {
        const path = typeof it === 'string' ? it : it?.path;
        if (!path || seen.has(path)) continue;
        seen.add(path);
        rows.push({ path, name: (typeof it === 'object' && it.name) || baseName(path) });
      }
      if (rows.length) groups.push({ label, rows });
    };
    try {
      const f = await api('GET', '/api/folders');
      add('Pinned', f?.pinned);
      add('Recent', f?.recent);
      add('Projects', f?.projects);
    } catch {}
    if (!groups.length) add('Recent', opts.recent);
    if (opts.home && !seen.has(opts.home)) add('', [{ path: opts.home, name: 'Home' }]);
    return groups;
  }

  async function renderNewSheet() {
    const sheet = ui.newSheet;
    sheet.replaceChildren(sheetHead('New chat'), el('div', 'chat-placeholder', 'Loading…'));
    let opts;
    try {
      opts = options = await loadOptions();
    } catch (err) {
      sheet.lastChild.textContent = `Could not load options: ${err.message}`;
      return;
    }
    const groups = await loadFolders(opts);
    if (top() !== 'new') return;
    const cwd = opts.recent?.[0] || groups[0]?.rows[0]?.path || opts.home || '';
    const state = { tool: opts.tools.claude ? 'claude' : Object.keys(opts.tools)[0], cwd, model: null, mode: null };

    const seg = el('div', 'chat-seg');
    const folders = el('div', 'chat-folders');
    const path = el('input', 'chat-text chat-path');
    Object.assign(path, { type: 'text', value: state.cwd, placeholder: '/path/to/folder', autocapitalize: 'off', spellcheck: false });
    path.setAttribute('autocorrect', 'off');
    path.setAttribute('enterkeyhint', 'done');
    const toolFields = el('div', 'chat-tool-fields');
    const start = button('chat-primary chat-start', 'Start');

    const renderSeg = () => seg.replaceChildren(...Object.keys(opts.tools).map((tool) => {
      const b = button(`chat-seg-btn chat-seg-${tool}${tool === state.tool ? ' on' : ''}`, opts.tools[tool].label || TOOLS[tool], () => {
        state.tool = tool;
        renderSeg();
        renderToolFields();
      });
      return b;
    }));
    const renderFolders = () => folders.replaceChildren(...groups.flatMap((g) => [
      ...(g.label ? [el('div', 'chat-folder-group', g.label)] : []),
      ...g.rows.map((r) => {
        const b = button(`chat-folder${r.path === state.cwd ? ' on' : ''}`, null, () => {
          state.cwd = path.value = r.path;
          renderFolders();
        });
        b.append(el('span', 'chat-folder-name', r.name), el('span', 'chat-folder-path', tilde(r.path)));
        return b;
      }),
    ]));
    const renderToolFields = () => {
      const t = opts.tools[state.tool];
      state.model = t.defaultModel;
      state.mode = t.defaultMode;
      const hint = modeHint(t.modes, state.mode);
      toolFields.replaceChildren(
        field('Model', select(t.models, state.model, (v) => { state.model = v; })),
        field('Mode', select(t.modes, state.mode, (v) => {
          state.mode = v;
          hint.textContent = findOpt(t.modes, v)?.description || '';
        }), hint),
      );
    };
    path.oninput = () => {
      state.cwd = path.value.trim();
      renderFolders();
    };
    start.onclick = async () => {
      if (!state.cwd) return path.focus();
      const mode = findOpt(opts.tools[state.tool].modes, state.mode);
      if (mode?.confirm && !confirm(mode.confirm)) return;
      start.disabled = true;
      start.textContent = 'Starting…';
      try {
        const chat = await api('POST', '/api/chat', { tool: state.tool, cwd: state.cwd, model: state.model, mode: state.mode, ...(mode?.confirm ? { confirmBypass: true } : {}) });
        if (top() !== 'new') return;
        showChat(chat);
        ui.input.focus();
      } catch (err) {
        start.disabled = false;
        start.textContent = 'Start';
        sheetError(sheet, err.message);
      }
    };

    renderSeg();
    renderFolders();
    renderToolFields();
    const body = el('div', 'chat-sheet-body');
    body.append(seg, field('Folder', folders), path, toolFields);
    const foot = el('div', 'chat-sheet-foot');
    foot.append(start);
    sheet.replaceChildren(sheetHead('New chat'), body, foot);
  }

  function sheetError(sheet, text) {
    let box = sheet.querySelector('.chat-sheet-err');
    if (!box) sheet.querySelector('.chat-sheet-foot').prepend((box = el('div', 'chat-sheet-err')));
    box.textContent = text;
  }

  async function renderSettings() {
    const sheet = ui.settingsSheet;
    const c = convo.chat;
    sheet.replaceChildren(sheetHead('Chat settings'), el('div', 'chat-placeholder', 'Loading…'));
    let t;
    try {
      t = (options = await loadOptions()).tools[c.tool];
    } catch (err) {
      sheet.lastChild.textContent = `Could not load options: ${err.message}`;
      return;
    }
    if (top() !== 'settings') return;
    const state = { model: c.model, mode: c.mode };
    const hint = modeHint(t.modes, state.mode);
    const save = button('chat-primary', 'Save');
    const del = button('chat-danger-link', 'Delete chat');
    save.onclick = async () => {
      if (state.model === c.model && state.mode === c.mode) return back();
      const mode = findOpt(t.modes, state.mode);
      const bypass = state.mode !== c.mode && mode?.confirm;
      if (bypass && !confirm(mode.confirm)) return;
      save.disabled = true;
      try {
        const chat = await api('PATCH', `/api/chat/${convo.id}`, { model: state.model, mode: state.mode, ...(bypass ? { confirmBypass: true } : {}) });
        setChat(chat);
        if (top() === 'settings') back();
      } catch (err) {
        save.disabled = false;
        sheetError(sheet, err.message);
      }
    };
    del.onclick = async () => {
      if (!confirm(`Delete "${c.title}"? Its history is removed from Pocket Dev.`)) return;
      convo.leaving = true;
      try {
        await api('DELETE', `/api/chat/${convo.id}`);
        disconnect();
        history.go(-2);
      } catch (err) {
        convo.leaving = false;
        sheetError(sheet, err.message);
      }
    };
    const body = el('div', 'chat-sheet-body');
    body.append(
      field('Model', select(t.models, state.model, (v) => { state.model = v; })),
      field('Mode', select(t.modes, state.mode, (v) => {
        state.mode = v;
        hint.textContent = findOpt(t.modes, v)?.description || '';
      }), hint),
      el('p', 'chat-hint', 'Changes apply from the next message.'),
      del,
    );
    const foot = el('div', 'chat-sheet-foot');
    foot.append(save);
    sheet.replaceChildren(sheetHead('Chat settings'), body, foot);
  }

  // Conversation state. events is ordered by seq; nodes maps event id to its rendered element.
  let seed = null;
  const convo = {
    id: null, chat: null, events: [], byId: new Map(), nodes: new Map(), expanded: new Set(),
    dirty: new Set(), chatDirty: false, frame: 0, stick: true,
    ws: null, retry: 0, attempt: 0, online: false, everOnline: false, leaving: false,
    files: [], uploadsOff: false, sending: false,
  };

  function resetLog() {
    convo.events = [];
    convo.byId.clear();
    convo.nodes.clear();
    convo.dirty.clear();
    ui.log.replaceChildren();
  }

  function enterConvo(id) {
    Object.assign(convo, { id, chat: seed?.id === id ? seed : null, stick: true, attempt: 0, online: false, everOnline: false, leaving: false, files: [], sending: false });
    convo.expanded = new Set();
    seed = null;
    resetLog();
    ui.input.value = '';
    ui.notice.hidden = true;
    growInput();
    renderFiles();
    cardKey = null;
    ui.card.hidden = true;
    ui.title.textContent = convo.chat?.title || '';
    ui.sub.replaceChildren();
    ui.setchip.textContent = '';
    convo.chatDirty = true;
    schedule();
    renderConn();
    connect();
    loadOptions().then((o) => {
      options = o;
      convo.chatDirty = true;
      schedule();
    }, () => {});
  }

  function leaveConvo() {
    if (!convo.id) return;
    disconnect();
    convo.id = null;
    convo.chat = null;
    cancelAnimationFrame(convo.frame);
    convo.frame = 0;
  }

  function connect() {
    const id = convo.id;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/${encodeURIComponent(id)}`);
    convo.ws = ws;
    ws.onopen = () => {
      if (convo.ws !== ws) return;
      convo.online = convo.everOnline = true;
      convo.attempt = 0;
      renderConn();
    };
    ws.onmessage = (e) => {
      if (convo.ws === ws) onMessage(JSON.parse(e.data));
    };
    ws.onclose = (e) => {
      if (convo.ws !== ws) return;
      convo.ws = null;
      convo.online = false;
      if (e.code === 4404) return chatGone();
      renderConn();
      clearTimeout(convo.retry);
      convo.retry = setTimeout(connect, BACKOFF[Math.min(convo.attempt++, BACKOFF.length - 1)]);
    };
  }

  function disconnect() {
    clearTimeout(convo.retry);
    const ws = convo.ws;
    convo.ws = null;
    ws?.close();
  }

  function chatGone() {
    disconnect();
    if (convo.leaving || !convoIdOf(stack)) return;
    convo.leaving = true;
    const depth = stack.length - stack.findIndex((l) => l.layer === 'convo');
    history.go(-depth);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !convo.id) return;
    if (!convo.ws) {
      clearTimeout(convo.retry);
      convo.attempt = 0;
      connect();
    }
  });

  function onMessage(msg) {
    if (msg.t === 'hello') {
      resetLog();
      for (const ev of msg.events) upsert(ev);
      setChat(msg.chat);
    } else if (msg.t === 'event') {
      upsert(msg.event);
    } else if (msg.t === 'delta') {
      const ev = convo.byId.get(msg.id);
      if (!ev) return;
      ev[msg.field] = (ev[msg.field] || '') + msg.d;
      markDirty(ev.id);
    } else if (msg.t === 'chat') {
      setChat(msg.chat);
    } else if (msg.t === 'closed') {
      chatGone();
    }
  }

  function upsert(ev) {
    const old = convo.byId.get(ev.id);
    convo.byId.set(ev.id, ev);
    if (old) {
      convo.events[convo.events.indexOf(old)] = ev;
    } else {
      let i = convo.events.length;
      while (i > 0 && convo.events[i - 1].seq > ev.seq) i--;
      convo.events.splice(i, 0, ev);
    }
    markDirty(ev.id);
  }

  function setChat(chat) {
    if (chat.id !== convo.id) return;
    convo.chat = chat;
    convo.chatDirty = true;
    schedule();
  }

  function markDirty(id) {
    convo.dirty.add(id);
    schedule();
  }
  function schedule() {
    convo.frame ||= requestAnimationFrame(flush);
  }

  function flush() {
    convo.frame = 0;
    if (!convo.id) return;
    const stick = convo.stick;
    for (const id of convo.dirty) {
      const ev = convo.byId.get(id);
      if (!ev) continue;
      const node = renderEvent(ev);
      const old = convo.nodes.get(id);
      if (old) {
        carryScroll(old, node);
        old.replaceWith(node);
      } else {
        const i = convo.events.indexOf(ev);
        const next = convo.events.slice(i + 1).find((e) => convo.nodes.has(e.id));
        ui.log.insertBefore(node, next ? convo.nodes.get(next.id) : null);
      }
      convo.nodes.set(id, node);
    }
    convo.dirty.clear();
    ui.empty.hidden = convo.events.length > 0;
    if (convo.chatDirty) {
      convo.chatDirty = false;
      renderChrome();
    }
    renderCard();
    if (stick) scrollToBottom();
    renderLatest();
  }

  // Re-rendering a streaming tool output must not yank its inner scroll back to the top.
  function carryScroll(oldNode, newNode) {
    const olds = oldNode.querySelectorAll('.chat-pre');
    const news = newNode.querySelectorAll('.chat-pre');
    olds.forEach((o, i) => {
      const n = news[i];
      if (!n) return;
      const atEnd = o.scrollHeight - o.scrollTop - o.clientHeight < 8;
      requestAnimationFrame(() => {
        n.scrollTop = atEnd ? n.scrollHeight : o.scrollTop;
        n.scrollLeft = o.scrollLeft;
      });
    });
  }

  function fold(ev, cls, head, body) {
    const open = convo.expanded.has(ev.id);
    const wrap = el('div', `chat-fold ${cls}${open ? ' open' : ''}`);
    const h = button('chat-fold-head', null, () => {
      if (open) convo.expanded.delete(ev.id);
      else convo.expanded.add(ev.id);
      markDirty(ev.id);
    });
    h.setAttribute('aria-expanded', String(open));
    h.append(el('span', 'chat-caret', '▶'), ...head);
    wrap.append(h);
    if (open) wrap.append(body());
    return wrap;
  }

  function runIcon(status) {
    if (status === 'running') return spinner();
    if (status === 'ok') return el('span', 'chat-ok', '✓');
    if (status === 'error') return el('span', 'chat-bad', '✗');
    return el('span', status === 'stopped' ? 'chat-stopped' : 'chat-denied', status);
  }

  function resolvedLine(ok, text) {
    const line = el('div', `chat-resolved${ok ? '' : ' chat-resolved-no'}`);
    line.append(el('span', 'chat-resolved-mark', ok ? '✓' : '✗'), el('span', 'chat-resolved-text', text));
    return line;
  }

  function answersText(answers) {
    return Object.values(answers || {}).flat().join(', ') || '(no answer)';
  }

  const RENDER = {
    'user-text': (ev) => {
      const node = el('div', 'chat-user');
      if (ev.text) node.append(el('div', 'chat-user-text', ev.text));
      if (ev.attachments?.length) {
        const files = el('div', 'chat-user-files');
        for (const p of ev.attachments) files.append(el('span', 'chat-user-file', `📎 ${baseName(p)}`));
        node.append(files);
      }
      return node;
    },
    'assistant-text': (ev) => {
      const node = el('div', 'chat-assistant');
      node.append(md(ev.text || ''));
      if (ev.streaming) {
        let tail = node.lastElementChild;
        if (tail?.matches('ol, ul')) tail = tail.lastElementChild;
        else if (tail?.matches('.chat-codewrap')) tail = tail.querySelector('pre');
        (tail || node).append(el('span', 'chat-caret-blink'));
      }
      return node;
    },
    thinking: (ev) => fold(ev, 'chat-thinking', [el('span', 'chat-fold-name', 'Thinking…'), ...(ev.streaming ? [spinner()] : [])],
      () => el('div', 'chat-thinking-text', ev.text || '')),
    'tool-run': (ev) => fold(ev, 'chat-tool',
      [el('span', 'chat-fold-name', ev.name), el('span', 'chat-fold-summary', ev.summary || ''), runIcon(ev.status)],
      () => {
        const body = el('div', 'chat-fold-body');
        if (ev.input) body.append(el('div', 'chat-io-label', 'Input'), el('pre', 'chat-io chat-pre', ev.input));
        if (ev.output || ev.status === 'running') body.append(el('div', 'chat-io-label', 'Output'), el('pre', 'chat-io chat-pre', ev.output || '…'));
        if (!body.firstChild) body.append(el('div', 'chat-io-label', 'No output'));
        return body;
      }),
    'file-edit': (ev) => {
      const { add, del } = diffStats(ev.diff || '');
      const stats = el('span', 'chat-stats');
      stats.append(el('span', 'chat-stat-add', `+${add}`), el('span', 'chat-stat-del', `−${del}`));
      return fold(ev, 'chat-edit', [el('span', 'chat-fold-name', 'Edit'), el('span', 'chat-fold-summary', shortPath(ev.path)), stats, runIcon(ev.status)],
        () => {
          const body = el('div', 'chat-fold-body');
          body.append(el('div', 'chat-edit-path', tilde(ev.path)), diffBlock(ev.diff || ''));
          return body;
        });
    },
    'permission-request': (ev) => {
      const r = ev.resolution;
      if (!r) return el('div', 'chat-sys chat-sys-wait', `Permission requested: ${ev.title}`);
      const text = `${DECISIONS[r.decision] || r.decision}: ${ev.title}${r.message ? ` (“${r.message}”)` : ''}`;
      return resolvedLine(r.decision !== 'deny', text);
    },
    question: (ev) => {
      const r = ev.resolution;
      if (!r) return el('div', 'chat-sys chat-sys-wait', `Question: ${ev.questions?.[0]?.header || ev.questions?.[0]?.question || ''}`);
      if (r.cancelled) return resolvedLine(false, 'Question cancelled');
      return resolvedLine(true, `Answered: ${answersText(r.answers)}`);
    },
    result: (ev) => {
      const bits = [ev.status, duration(ev.durationMs || 0)];
      if (ev.costUsd != null) bits.push(`$${ev.costUsd.toFixed(ev.costUsd < 0.1 ? 3 : 2)}`);
      return el('div', `chat-result chat-result-${ev.status}`, bits.join(' · '));
    },
    error: (ev) => el('div', 'chat-error', ev.message),
    status: (ev) => el('div', 'chat-sys', ev.text),
  };

  function renderEvent(ev) {
    const node = (RENDER[ev.type] || ((e) => el('div', 'chat-sys', e.type)))(ev);
    node.dataset.id = ev.id;
    return node;
  }

  function renderChrome() {
    const c = convo.chat;
    if (!c) return;
    ui.title.textContent = c.title || 'New chat';
    const path = el('span', 'chat-sub-path', shortPath(c.cwd));
    path.title = c.cwd;
    ui.sub.replaceChildren(badge(c.tool), path);
    const t = toolOptions(c.tool);
    const model = findOpt(t?.models, c.model)?.label || c.model;
    const mode = findOpt(t?.modes, c.mode)?.label || c.mode;
    ui.setchip.replaceChildren(el('span', 'chat-setchip-model', model), el('span', 'chat-setchip-mode', mode));
    ui.input.placeholder = `Message ${TOOLS[c.tool] || c.tool}`;
    renderComposer();
    renderStatusLine();
  }

  function renderStatusLine() {
    const c = convo.chat;
    let text = '';
    let cls = '';
    if (c?.waking) {
      text = 'Waking up…';
    } else if (c?.pending) {
      text = 'Waiting for you';
      cls = ' chat-statusline-wait';
    } else if (c && isBusy(c)) {
      text = `${TOOLS[c.tool]} is working… ${c.runningSince ? ticking(Date.now() - c.runningSince) : ''}`.trim();
    }
    ui.statusline.hidden = !text;
    ui.statusline.className = `chat-statusline${cls}`;
    if (!text) return;
    if (cls) ui.statusline.replaceChildren(text);
    else ui.statusline.replaceChildren(spinner(), text);
  }

  setInterval(() => {
    if (convo.id && convo.chat?.runningSince && !document.hidden) renderStatusLine();
  }, 1000);

  function renderConn() {
    ui.conn.hidden = convo.online;
    ui.conn.textContent = convo.everOnline ? 'reconnecting…' : 'connecting…';
  }

  const atBottom = () => ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 40;
  function scrollToBottom() {
    ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }
  function renderLatest() {
    ui.latest.hidden = convo.stick || !convo.events.length;
  }
  ui.scroll.addEventListener('scroll', () => {
    convo.stick = atBottom();
    renderLatest();
  }, { passive: true });
  new ResizeObserver(() => {
    if (convo.id && convo.stick) scrollToBottom();
  }).observe(ui.scroll);
  keepFocus(ui.latest);
  ui.latest.onclick = () => {
    convo.stick = true;
    ui.scroll.scrollTo({ top: ui.scroll.scrollHeight, behavior: 'smooth' });
    renderLatest();
  };

  ui.back.onclick = back;
  ui.setchip.onclick = () => {
    if (convo.chat) push({ layer: 'settings' });
  };

  // Request card pinned above the composer. It rebuilds only when the pending request changes,
  // so a half-typed deny reason or a selected answer survives unrelated events.
  let cardKey = null;
  function pendingEvent() {
    const pid = convo.chat?.pendingId;
    if (!pid) return null;
    return convo.events.find((e) => e.requestId === pid && !e.resolution) || null;
  }
  function renderCard() {
    const ev = pendingEvent();
    const key = ev ? `${convo.id}:${ev.requestId}` : null;
    if (key === cardKey) return;
    cardKey = key;
    ui.card.hidden = !ev;
    ui.card.replaceChildren(...(ev ? [ev.type === 'question' ? questionCard(ev) : permissionCard(ev)] : []));
  }

  async function answer(card, body) {
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      setChat(await api('POST', `/api/chat/${convo.id}/answer`, body));
    } catch (err) {
      for (const b of card.querySelectorAll('button')) b.disabled = false;
      card.dispatchEvent(new Event('chat-reenable'));
      notice(err.message);
    }
  }

  function permissionCard(ev) {
    const card = el('div', 'chat-card-inner');
    const scroll = el('div', 'chat-card-scroll');
    scroll.append(el('div', 'chat-card-kicker', KINDS[ev.kind] || 'Permission'), el('div', 'chat-card-title', ev.title));
    if (ev.detail) {
      if (ev.kind === 'plan') {
        const plan = el('div', 'chat-card-plan');
        plan.append(md(ev.detail));
        scroll.append(plan);
      } else {
        scroll.append(el('pre', 'chat-card-detail chat-pre', ev.detail));
      }
    }
    if (ev.diff) scroll.append(diffBlock(ev.diff));
    const reason = el('input', 'chat-text chat-reason');
    Object.assign(reason, { type: 'text', placeholder: 'Reason (optional), then tap Deny', hidden: true });
    reason.setAttribute('enterkeyhint', 'send');
    const actions = el('div', 'chat-card-actions');
    const opts = ev.options?.length ? ev.options : [{ id: 'allow', label: 'Allow' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }];
    for (const o of opts) {
      const cls = o.id === 'allow' ? 'chat-primary' : o.id === 'deny' ? 'chat-deny' : 'chat-secondary';
      const b = button(cls, o.label, () => {
        if (o.id === 'deny' && reason.hidden) {
          reason.hidden = false;
          reason.focus();
          return;
        }
        const message = o.id === 'deny' ? reason.value.trim() : '';
        answer(card, { requestId: ev.requestId, decision: o.id, ...(message ? { message } : {}) });
        closeKeyboard();
      });
      if (o.id === 'deny') keepFocus(b);
      actions.append(b);
    }
    reason.onkeydown = (e) => {
      if (e.key === 'Enter') actions.querySelector('.chat-deny')?.click();
    };
    card.append(scroll, reason, actions);
    return card;
  }

  function questionCard(ev) {
    const card = el('div', 'chat-card-inner');
    const scroll = el('div', 'chat-card-scroll');
    const picked = new Map(ev.questions.map((qn) => [qn.id, new Set()]));
    const other = new Map();
    const submit = button('chat-primary chat-submit', 'Submit');
    const answers = () => Object.fromEntries(ev.questions.map((qn) => {
      const list = [...picked.get(qn.id)];
      const o = other.get(qn.id);
      if (o?.on && o.input.value.trim()) list.push(o.input.value.trim());
      return [qn.id, list];
    }));
    const refresh = () => {
      submit.disabled = Object.values(answers()).some((a) => !a.length);
    };
    for (const qn of ev.questions) {
      const box = el('div', 'chat-q');
      if (qn.header) box.append(el('div', 'chat-card-kicker', qn.header));
      box.append(el('div', 'chat-q-text', qn.question));
      if (qn.multiSelect) box.append(el('div', 'chat-hint', 'Pick any that apply'));
      const opts = el('div', 'chat-q-opts');
      const set = picked.get(qn.id);
      const optButtons = [];
      const sync = () => {
        for (const [b, label] of optButtons) b.classList.toggle('on', label === null ? !!other.get(qn.id)?.on : set.has(label));
        refresh();
      };
      for (const o of qn.options || []) {
        const b = button(`chat-q-opt${qn.multiSelect ? ' chat-q-multi' : ''}`, null, () => {
          if (qn.multiSelect) {
            if (set.has(o.label)) set.delete(o.label);
            else set.add(o.label);
          } else {
            set.clear();
            set.add(o.label);
            if (other.get(qn.id)) other.get(qn.id).on = false;
            other.get(qn.id)?.input.setAttribute('hidden', '');
          }
          sync();
        });
        b.append(el('span', 'chat-q-mark'), el('span', 'chat-q-label', o.label));
        if (o.description) b.append(el('span', 'chat-q-desc', o.description));
        optButtons.push([b, o.label]);
        opts.append(b);
      }
      if (qn.allowOther) {
        const input = el('input', 'chat-text chat-q-other');
        Object.assign(input, { type: 'text', placeholder: 'Your answer', hidden: true });
        input.setAttribute('enterkeyhint', 'done');
        input.oninput = refresh;
        const state = { on: false, input };
        other.set(qn.id, state);
        const b = button(`chat-q-opt${qn.multiSelect ? ' chat-q-multi' : ''}`, null, () => {
          state.on = qn.multiSelect ? !state.on : true;
          if (!qn.multiSelect) set.clear();
          input.hidden = !state.on;
          if (state.on) input.focus();
          sync();
        });
        b.append(el('span', 'chat-q-mark'), el('span', 'chat-q-label', 'Other…'));
        optButtons.push([b, null]);
        opts.append(b, input);
      }
      box.append(opts);
      scroll.append(box);
    }
    submit.onclick = () => {
      closeKeyboard();
      answer(card, { requestId: ev.requestId, answers: answers() });
    };
    card.addEventListener('chat-reenable', refresh);
    refresh();
    const actions = el('div', 'chat-card-actions');
    actions.append(submit);
    card.append(scroll, actions);
    return card;
  }

  // Composer.
  let noticeTimer = 0;
  function notice(text) {
    ui.notice.textContent = text;
    ui.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 5000);
  }

  function growInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, MAX_INPUT_PX)}px`;
    ui.input.style.overflowY = ui.input.scrollHeight > MAX_INPUT_PX ? 'auto' : 'hidden';
  }

  function renderComposer() {
    const busy = convo.chat && isBusy(convo.chat);
    const uploading = convo.files.some((f) => !f.path);
    ui.send.textContent = busy ? 'Stop' : 'Send';
    ui.send.classList.toggle('chat-stop', !!busy);
    ui.send.disabled = !busy && (convo.sending || uploading || (!ui.input.value.trim() && !convo.files.length));
    ui.attach.disabled = convo.uploadsOff;
    ui.attach.title = convo.uploadsOff ? 'Attachments are not available on this server' : 'Attach a file';
  }

  function renderFiles() {
    ui.files.hidden = !convo.files.length;
    ui.files.replaceChildren(...convo.files.map((f) => {
      const chip = el('span', `chat-file${f.path ? '' : ' chat-file-up'}`);
      chip.append(el('span', 'chat-file-name', f.path ? f.name : `${f.name} (uploading…)`));
      const x = button('chat-file-x', '✕', () => {
        convo.files = convo.files.filter((g) => g !== f);
        renderFiles();
      });
      x.setAttribute('aria-label', `Remove ${f.name}`);
      chip.append(x);
      return chip;
    }));
    renderComposer();
  }

  ui.input.addEventListener('input', () => {
    growInput();
    renderComposer();
  });
  keepFocus(ui.send);
  ui.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = convo.chat;
    if (!convo.id) return;
    if (c && isBusy(c)) {
      try {
        setChat(await api('POST', `/api/chat/${convo.id}/interrupt`));
      } catch (err) {
        notice(err.message);
      }
      return;
    }
    const text = ui.input.value.trim();
    const attachments = convo.files.filter((f) => f.path).map((f) => f.path);
    if (!text && !attachments.length) return;
    convo.sending = true;
    renderComposer();
    try {
      const chat = await api('POST', `/api/chat/${convo.id}/message`, { text, ...(attachments.length ? { attachments } : {}) });
      ui.input.value = '';
      convo.files = [];
      growInput();
      renderFiles();
      convo.stick = true;
      setChat(chat);
      closeKeyboard();
    } catch (err) {
      notice(err.status === 409 ? `${TOOLS[c?.tool] || 'The agent'} is still working. Stop it or wait.` : err.message);
    } finally {
      convo.sending = false;
      renderComposer();
    }
  });

  ui.attach.onclick = () => ui.fileInput.click();
  ui.fileInput.onchange = async () => {
    const picked = [...ui.fileInput.files];
    ui.fileInput.value = '';
    for (const file of picked) {
      const f = { name: file.name, path: null };
      convo.files.push(f);
      renderFiles();
      try {
        f.path = (await api('POST', '/api/upload', file, { 'x-filename': encodeURIComponent(file.name) })).path;
      } catch (err) {
        convo.files = convo.files.filter((g) => g !== f);
        if (err.status === 404) {
          convo.uploadsOff = true;
          convo.files = [];
          renderFiles();
          notice('This server cannot receive attachments yet.');
          return;
        }
        notice(`Could not upload ${file.name}: ${err.message}`);
      }
      renderFiles();
    }
  };

  const vv = window.visualViewport;
  function fitViewport() {
    if (root.hidden) return;
    const h = vv ? vv.height : window.innerHeight;
    root.style.height = `${h}px`;
    root.style.setProperty('--chat-h', `${h}px`);
    if (vv) root.style.transform = `translateY(${vv.offsetTop}px)`;
  }
  vv?.addEventListener('resize', fitViewport);
  vv?.addEventListener('scroll', fitViewport);
  window.addEventListener('orientationchange', fitViewport);

  window.pocketDevChat = {
    open(chatId) {
      if (chatId) return showChat({ id: chatId });
      if (!stack.length) push({ layer: 'list' });
    },
    async startFromSession({ tool, id, cwd }) {
      const t = (options = await loadOptions()).tools[tool];
      const chat = await api('POST', '/api/chat', { tool, cwd, model: t.defaultModel, mode: t.defaultMode, resume: { sessionId: id } });
      showChat(chat);
      return chat;
    },
  };

  // Covers a reload (history.state still holds the stack) and a typed or linked #chat / #chat=<id>.
  function openFromHash() {
    const m = location.hash.match(/^#chat(?:=([\w-]+))?$/);
    if (!m || (stack.length && hashFor(stack) === location.hash)) return;
    const saved = history.state?.pdChat;
    if (Array.isArray(saved) && hashFor(saved) === location.hash) return apply(saved);
    history.replaceState(null, '', location.pathname + location.search);
    if (stack.length) apply([]);
    push({ layer: 'list' }, ...(m[1] ? [{ layer: 'convo', id: m[1] }] : []));
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
})();
