(() => {
  // An older running server may serve the new page before it knows the route
  // for connection.js. Keep the chat entry points usable for explaining recovery.
  if (typeof window.PocketDevConnection !== 'function' || typeof window.PocketDevDrafts !== 'function') {
    const message = window.pocketDev.clientUpdateMessage;
    window.pocketDevChat = {
      open() { window.pocketDev.showClientError(message); },
      async startFromSession() { throw new Error(message); },
    };
    return;
  }
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
  const DECISIONS = { allow: 'Allowed', 'allow-chat': 'Allowed for this chat', 'allow-project': 'Allowed for this project', deny: 'Denied' };
  const FALLBACK_OPTIONS = [{ id: 'allow', label: 'Allow once' }, { id: 'allow-chat', label: 'Always allow in this chat' }, { id: 'deny', label: 'Deny' }];
  const KINDS = { command: 'Run a command', file: 'Edit a file', tool: 'Use a tool', plan: 'Approve the plan' };
  const POLL_MS = 3000;
  const MAX_INPUT_PX = 140;
  const TOAST_MS = 2600;
  const QUEUE_UPDATE_MESSAGE = 'Queued-message editing needs a Pocket Dev update. Let active chats and queued messages finish, then restart Pocket Dev from Settings → This device and refresh. Your edit stays in this tab.';

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

  // Not window.api: the flows below branch on the status code (409 busy, 404 no uploads) and upload raw bodies.
  async function api(method, url, body, headers, { signal } = {}) {
    const raw = body instanceof Blob;
    const res = await fetch(url, {
      method,
      signal,
      headers: { 'x-pocket-dev': '1', ...(raw ? headers : body ? { 'content-type': 'application/json' } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.replace('/login.html');
      throw new Error('Not logged in');
    }
    const data = res.status === 204 ? null : await res.json().catch((err) => {
      if (res.ok) throw err; // A missing acknowledgement must not clear the draft.
      return null;
    });
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  }

  async function sendWithTimeout(url, body, method = 'POST') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try { return await api(method, url, body, undefined, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
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

  // Engine settings come from the tool's schema; schema order is display order.
  const schemaOf = (tool) => options?.tools?.[tool]?.settings || [];
  const choiceOf = (setting, value) => setting.choices.find((c) => c.value === value);
  const valueOf = (settings, setting) => settings?.[setting.key] ?? setting.default;
  const choiceLabel = (setting, value) => choiceOf(setting, value)?.label || value;
  const shortModel = (id) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '');

  // Local paths open through the authenticated Files API, never file:// or a
  // shell/editor protocol. Files applies its normal root and symlink checks.
  function localFileTarget(target) {
    if (!target.startsWith('/') || target.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(target)) return null;
    const path = target.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');
    return { path, href: `/api/files/download?${new URLSearchParams({ path, inline: '1' })}` };
  }

  // Build DOM nodes from text, never model-generated HTML. Only web URLs and
  // local file paths become links; other protocols remain literal text.
  function inline(node, text) {
    const re = /`([^`\n]+)`|\*\*(.+?)\*\*|\[([^\]\n]+)\]\((<[^<>\n]+>|[^\s)]+)\)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      if (m[1] != null) node.append(el('code', 'chat-ic', m[1]));
      else if (m[2] != null) node.append(inline(el('strong'), m[2]));
      else {
        const target = m[4].startsWith('<') ? m[4].slice(1, -1) : m[4];
        const local = localFileTarget(target);
        if (!local && !/^https?:\/\//i.test(target)) {
          node.append(m[0]);
          last = m.index + m[0].length;
          continue;
        }
        const a = inline(el('a', 'chat-md-a'), m[3]);
        a.href = local?.href || target;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (local) {
          a.title = local.path;
          a.onclick = (event) => {
            if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !window.openFile) return;
            event.preventDefault();
            window.openFile(local.path);
          };
        }
        node.append(a);
      }
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

  // A table row is a line that starts with "|". Pipes inside `code` or written \| stay in the cell.
  function tableCells(line) {
    const t = line.trim();
    if (!t.startsWith('|')) return null;
    const cells = [];
    let cur = '';
    let tick = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (c === '\\' && t[k + 1] === '|') { cur += '|'; k++; }
      else if (c === '`') { tick = !tick; cur += c; }
      else if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) cells.push(cur.trim());
    return cells;
  }

  const isTableRule = (cells) => cells?.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

  function table(head, aligns, rows) {
    const wrap = el('div', 'chat-md-tablewrap');
    const t = el('table', 'chat-md-table');
    const addRow = (parent, cells, tag) => {
      const tr = el('tr');
      aligns.forEach((align, col) => {
        const cell = inline(el(tag), cells[col] ?? '');
        if (align) cell.style.textAlign = align;
        tr.append(cell);
      });
      parent.append(tr);
    };
    const thead = el('thead');
    addRow(thead, head, 'th');
    const tbody = el('tbody');
    for (const row of rows) addRow(tbody, row, 'td');
    t.append(thead, tbody);
    wrap.append(t);
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
      const head = tableCells(line);
      const rule = head && i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
      if (isTableRule(rule)) {
        const aligns = rule.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
        const rows = [];
        let j = i + 2;
        for (let cells; j < lines.length && (cells = tableCells(lines[j])); j++) rows.push(cells);
        frag.append(table(head, aligns, rows));
        i = j - 1;
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
      <header class="chat-head chat-convo-head">
        <div class="chat-head-row">
          <button type="button" class="chat-icon chat-back" aria-label="Back to chats">‹</button>
          <div class="chat-head-main">
            <div class="chat-title"></div>
            <div class="chat-sub"></div>
          </div>
          <button type="button" class="chat-icon chat-menu" aria-label="Chat settings">⋯</button>
        </div>
        <div class="chat-chips" role="toolbar" aria-label="Engine settings"></div>
      </header>
      <div class="chat-body">
        <div class="chat-scroll chat-log-scroll">
          <div class="chat-empty">Send a message to start.</div>
          <div class="chat-log"></div>
        </div>
        <button type="button" class="chat-latest" hidden>↓ latest</button>
        <div class="chat-conn" role="status" aria-live="polite" hidden></div>
      </div>
      <div class="chat-dock">
        <div class="chat-card" hidden></div>
        <div class="chat-work" hidden></div>
        <div class="chat-statusline" hidden></div>
        <div class="chat-notice" hidden></div>
        <div class="chat-queue" role="list" aria-label="Queued messages" hidden></div>
        <div class="chat-queue-edit" hidden><span class="chat-queue-edit-label" role="status"></span><button type="button" class="chat-queue-cancel">Cancel</button></div>
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
    <div class="chat-sheet-wrap chat-settings-wrap" hidden><div class="chat-backdrop"></div><div class="chat-sheet chat-settings-sheet"></div></div>
    <section class="chat-screen chat-perms-screen" hidden>
      <header class="chat-head">
        <button type="button" class="chat-icon chat-perms-back" aria-label="Back to chat settings">‹</button>
        <div class="chat-head-main">
          <div class="chat-title">Permissions</div>
          <div class="chat-sub chat-perms-sub"></div>
        </div>
      </header>
      <div class="chat-scroll chat-perms-body"></div>
    </section>
    <div class="chat-sheet-wrap chat-pick-wrap" hidden><div class="chat-backdrop"></div><div class="chat-sheet chat-pick-sheet"></div></div>
    <div class="chat-toast" role="status" aria-live="polite" hidden></div>`;
  document.body.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const ui = {
    listScreen: q('.chat-list-screen'), rows: q('.chat-rows'), newBtn: q('.chat-new-btn'), close: q('.chat-close'),
    convoScreen: q('.chat-convo-screen'), back: q('.chat-back'), title: q('.chat-title'), sub: q('.chat-sub'), menu: q('.chat-menu'), chips: q('.chat-chips'),
    scroll: q('.chat-log-scroll'), empty: q('.chat-empty'), log: q('.chat-log'), latest: q('.chat-latest'), conn: q('.chat-conn'),
    card: q('.chat-card'), work: q('.chat-work'), statusline: q('.chat-statusline'), notice: q('.chat-notice'), queue: q('.chat-queue'), files: q('.chat-files'),
    dock: q('.chat-dock'), composer: q('.chat-composer'), attach: q('.chat-attach'), input: q('.chat-input'), send: q('.chat-send'), fileInput: q('.chat-file-input'),
    newWrap: q('.chat-new-wrap'), newSheet: q('.chat-new-sheet'), settingsWrap: q('.chat-settings-wrap'), settingsSheet: q('.chat-settings-sheet'),
    permsScreen: q('.chat-perms-screen'), permsBack: q('.chat-perms-back'), permsSub: q('.chat-perms-sub'), permsBody: q('.chat-perms-body'),
    pickWrap: q('.chat-pick-wrap'), pickSheet: q('.chat-pick-sheet'), toast: q('.chat-toast'),
  };

  // Navigation. The layer stack is the source of truth and apply() renders it. Each layer owns one back level: an
  // entry in the page's shared overlay stack when it exists, else our own history entry carrying the whole stack.
  let stack = [];
  const convoIdOf = (s) => s.find((l) => l.layer === 'convo')?.id ?? null;
  const hasLayer = (s, layer) => s.some((l) => l.layer === layer);
  const hashFor = (s) => (convoIdOf(s) ? `#chat=${convoIdOf(s)}` : '#chat');
  const top = () => stack[stack.length - 1]?.layer;
  const sameLayer = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const sharedOverlays = window.pocketDev?.overlays;
  const nav = sharedOverlays ? overlayNav(sharedOverlays) : historyNav();
  const push = (...layers) => nav.push([...stack, ...layers]);
  const replace = (next) => nav.replace(next);
  const pop = (n) => n > 0 && n <= stack.length && nav.pop(n);
  const back = () => pop(1);
  const closeAll = () => pop(stack.length);
  const popFrom = (layer) => pop(stack.length - stack.findIndex((l) => l.layer === layer));

  function historyNav() {
    window.addEventListener('popstate', (e) => {
      const next = e.state?.pdChat;
      if (Array.isArray(next)) apply(next);
      else if (stack.length) apply([]);
    });
    return {
      push(next) {
        for (let d = stack.length + 1; d <= next.length; d++) history.pushState({ pdChat: next.slice(0, d) }, '', hashFor(next.slice(0, d)));
        apply(next);
      },
      replace(next) {
        history.replaceState({ pdChat: next }, '', hashFor(next));
        apply(next);
      },
      pop: (n) => history.go(-n),
    };
  }

  // The shared stack owns history, so the hash is only read (links), and a reload restores from sessionStorage.
  function overlayNav(overlays) {
    const name = (depth) => `chat-${depth}`;
    const open = (from, to) => {
      for (let d = from + 1; d <= to; d++) {
        overlays.open(name(d), () => {
          if (stack.length >= d) apply(stack.slice(0, d - 1));
        });
      }
    };
    return {
      push(next) {
        const from = stack.length;
        apply(next);
        open(from, next.length);
      },
      replace(next) {
        const from = stack.length;
        apply(next);
        if (next.length < from) overlays.close(name(next.length + 1));
        else open(from, next.length);
      },
      pop(n) {
        const depth = stack.length - n + 1;
        apply(stack.slice(0, depth - 1));
        overlays.close(name(depth));
      },
    };
  }
  const SAVED = 'pd.chat.stack';
  function saveStack(next) {
    try {
      if (next.length) sessionStorage.setItem(SAVED, JSON.stringify(next));
      else sessionStorage.removeItem(SAVED);
    } catch {}
  }
  function savedStack() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SAVED));
      return Array.isArray(s) ? s : null;
    } catch {
      return null;
    }
  }

  // Sheets and screens that sit above the list or conversation. Each renders when its layer appears or changes.
  const LAYERS = {
    new: [ui.newWrap, renderNewSheet],
    settings: [ui.settingsWrap, renderSettings],
    perms: [ui.permsScreen, renderPerms],
    pick: [ui.pickWrap, renderPicker],
  };

  function apply(next) {
    const prev = stack;
    stack = next;
    const id = convoIdOf(next);
    root.hidden = !next.length;
    ui.listScreen.hidden = !next.length || !!id;
    ui.convoScreen.hidden = !id;
    if (id !== convoIdOf(prev)) {
      leaveConvo();
      if (id) enterConvo(id);
    }
    for (const [layer, [node, render]] of Object.entries(LAYERS)) {
      const now = next.find((l) => l.layer === layer);
      node.hidden = !now;
      if (now && !sameLayer(now, prev.find((l) => l.layer === layer))) render(now);
    }
    if (next.length && !id) refreshList();
    if (sharedOverlays) saveStack(next);
    if (top() !== prev[prev.length - 1]?.layer) closeKeyboard();
    if (!next.length) {
      hideToast();
      // A typed #chat link pops our entries before its hashchange arrives, so only strip the hash we wrote.
      if (!sharedOverlays && prev.length && location.hash === hashFor(prev)) history.replaceState(history.state, '', location.pathname + location.search);
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
      ui.rows.replaceChildren(el('div', 'chat-placeholder', 'No chats yet. Start one to talk to Claude Code or Codex in a folder on this device.'));
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
  for (const wrap of [ui.newWrap, ui.settingsWrap, ui.pickWrap]) wrap.querySelector('.chat-backdrop').onclick = back;
  ui.permsBack.onclick = back;

  function field(label, control) {
    const box = el('div', 'chat-field');
    if (control.matches('input')) control.setAttribute('aria-label', label);
    box.append(el('span', 'chat-label', label), control);
    return box;
  }
  function sheetHead(title) {
    const head = el('div', 'chat-sheet-head');
    head.append(el('h3', 'chat-h3', title), button('chat-icon', '✕', back));
    head.lastChild.setAttribute('aria-label', 'Close');
    return head;
  }
  const placeholder = (text) => el('div', 'chat-placeholder', text);
  function sheetError(sheet, text) {
    let box = sheet.querySelector('.chat-sheet-err');
    if (!box) {
      box = el('div', 'chat-sheet-err');
      const foot = sheet.querySelector('.chat-sheet-foot');
      if (foot) foot.prepend(box);
      else sheet.append(box);
    }
    box.textContent = text;
  }

  // One engine setting's current value. Choices that need a confirm (bypass, full access) stay visibly hot.
  function settingChip(setting, value, onclick) {
    const choice = choiceOf(setting, value);
    const label = choice?.label || value;
    const b = button(`chat-chip${choice?.confirm ? ' chat-chip-risky' : ''}`, null, onclick);
    const face = el('span', 'chat-chip-face');
    face.append(el('span', 'chat-chip-k', setting.label), el('span', 'chat-chip-v', label));
    b.append(face);
    b.dataset.key = setting.key;
    b.setAttribute('aria-label', `${setting.label}: ${label}`);
    return b;
  }

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

  // The new chat draft lives outside the sheet so the picker layer above the sheet can change it.
  let draft = null;
  let renderDraftChips = () => {};
  function ensureDraft(opts) {
    if (draft) return;
    const tools = Object.keys(opts.tools);
    draft = {
      tool: opts.tools[opts.defaultTool] ? opts.defaultTool : tools.includes('claude') ? 'claude' : tools[0],
      cwd: opts.defaultCwd || opts.recent?.[0] || '',
      settings: Object.fromEntries(tools.map((t) => [t, { ...opts.tools[t].defaults }])),
      confirmed: new Set(),
    };
  }
  const confirmedKey = (tool, key, value) => `${tool}:${key}=${value}`;

  async function renderNewSheet() {
    const sheet = ui.newSheet;
    draft = null;
    sheet.replaceChildren(sheetHead('New chat'), placeholder('Loading…'));
    let opts;
    try {
      opts = options = await loadOptions();
    } catch (err) {
      sheet.lastChild.textContent = `Could not load options: ${err.message}`;
      return;
    }
    ensureDraft(opts);
    const groups = await loadFolders(opts);
    if (!hasLayer(stack, 'new')) return;
    draft.cwd ||= groups[0]?.rows[0]?.path || opts.home || '';

    const seg = el('div', 'chat-seg');
    const chips = el('div', 'chat-chips chat-chips-wrap');
    const folders = el('div', 'chat-folders');
    const path = el('input', 'chat-text chat-path');
    Object.assign(path, { type: 'text', value: draft.cwd, placeholder: '/path/to/folder', autocapitalize: 'off', spellcheck: false });
    path.setAttribute('autocorrect', 'off');
    path.setAttribute('enterkeyhint', 'done');
    const start = button('chat-primary chat-start', 'Start');

    const renderSeg = () => seg.replaceChildren(...Object.keys(opts.tools).map((tool) => button(
      `chat-seg-btn chat-seg-${tool}${tool === draft.tool ? ' on' : ''}`, opts.tools[tool].label || TOOLS[tool], () => {
        draft.tool = tool;
        renderSeg();
        renderDraftChips();
      })));
    renderDraftChips = () => chips.replaceChildren(...schemaOf(draft.tool).map((s) => settingChip(
      s, valueOf(draft.settings[draft.tool], s), () => push({ layer: 'pick', key: s.key, scope: 'new' }))));
    const renderFolders = () => folders.replaceChildren(...groups.flatMap((g) => [
      ...(g.label ? [el('div', 'chat-folder-group', g.label)] : []),
      ...g.rows.map((r) => {
        const b = button(`chat-folder${r.path === draft.cwd ? ' on' : ''}`, null, () => {
          draft.cwd = path.value = r.path;
          renderFolders();
        });
        b.append(el('span', 'chat-folder-name', r.name), el('span', 'chat-folder-path', tilde(r.path)));
        return b;
      }),
    ]));
    path.oninput = () => {
      draft.cwd = path.value.trim();
      renderFolders();
    };
    start.onclick = async () => {
      if (!draft.cwd) return path.focus();
      const { tool, cwd } = draft;
      const schema = schemaOf(tool);
      const settings = Object.fromEntries(schema.map((s) => [s.key, valueOf(draft.settings[tool], s)]));
      const risky = schema.map((s) => [s, choiceOf(s, settings[s.key])]).filter(([, c]) => c?.confirm);
      for (const [s, c] of risky) {
        if (!draft.confirmed.has(confirmedKey(tool, s.key, c.value)) && !confirm(c.confirm)) return;
      }
      start.disabled = true;
      start.textContent = 'Starting…';
      try {
        const chat = await api('POST', '/api/chat', { tool, cwd, settings, ...(risky.length ? { confirmBypass: true } : {}) });
        if (!hasLayer(stack, 'new')) return;
        showChat(chat);
        ui.input.focus();
      } catch (err) {
        start.disabled = false;
        start.textContent = 'Start';
        sheetError(sheet, err.message);
      }
    };

    renderSeg();
    renderDraftChips();
    renderFolders();
    const body = el('div', 'chat-sheet-body');
    const folderField = window.PocketDevFolderPicker?.field(path, { api, label: 'Folder', onSelect: () => { draft.cwd = path.value; renderFolders(); } }) ?? field('Folder', path);
    body.append(seg, chips, folderField, folders);
    const foot = el('div', 'chat-sheet-foot');
    foot.append(start);
    sheet.replaceChildren(sheetHead('New chat'), body, foot);
  }

  function renderSettings() {
    const sheet = ui.settingsSheet;
    const c = convo.chat;
    sheet.dataset.chat = c?.id || '';
    if (!c) {
      sheet.replaceChildren(sheetHead('Chat settings'), placeholder('Loading…'));
      return;
    }
    const where = el('div', 'chat-set-where');
    where.append(badge(c.tool), el('span', 'chat-set-path', tilde(c.cwd)));
    const perms = button('chat-set-row', null, () => push({ layer: 'perms' }));
    const main = el('span', 'chat-set-row-main');
    main.append(el('span', 'chat-set-row-title', 'Permissions'), el('span', 'chat-set-row-hint', 'What runs without asking'));
    perms.append(main, el('span', 'chat-set-chev', '›'));
    const del = button('chat-danger-link', 'Delete chat', async () => {
      if (!confirm(`Delete "${c.title}"? Its history is removed from Pocket Dev.`)) return;
      convo.leaving = true;
      try {
        await api('DELETE', `/api/chat/${c.id}`);
        disconnect();
        popFrom('convo');
      } catch (err) {
        convo.leaving = false;
        sheetError(sheet, err.message);
      }
    });
    const body = el('div', 'chat-sheet-body');
    body.append(where, perms, del);
    sheet.replaceChildren(sheetHead('Chat settings'), body);
  }

  // Permissions screen: the rules that let requests through without a card, per chat and per project file.
  let permsSeq = 0;
  async function renderPerms() {
    const id = convo.id;
    const seq = ++permsSeq;
    ui.permsSub.textContent = convo.chat?.title || '';
    ui.permsBody.replaceChildren(placeholder('Loading…'));
    try {
      const data = await api('GET', `/api/chat/${id}/permissions`);
      if (seq === permsSeq && convo.id === id) drawPerms(id, data);
    } catch (err) {
      if (seq !== permsSeq) return;
      const box = placeholder(`Could not load permissions: ${err.message}`);
      box.append(button('chat-secondary chat-retry', 'Try again', renderPerms));
      ui.permsBody.replaceChildren(box);
    }
  }

  function drawPerms(id, data) {
    const codex = convo.chat?.tool === 'codex';
    const remove = async (b, body) => {
      for (const x of ui.permsBody.querySelectorAll('.chat-rule-x')) x.disabled = true;
      b.textContent = 'Removing…';
      try {
        const next = await api('DELETE', `/api/chat/${id}/permissions`, body);
        if (convo.id === id && hasLayer(stack, 'perms')) drawPerms(id, next);
      } catch (err) {
        for (const x of ui.permsBody.querySelectorAll('.chat-rule-x')) x.disabled = false;
        b.textContent = 'Remove';
        toast(`Could not remove ${body.rule}: ${err.message}`);
      }
    };
    const ruleRow = (rule, label, body) => {
      const row = el('div', 'chat-rule-row');
      const text = el('div', 'chat-rule-text');
      text.append(el('code', 'chat-rule-code', rule));
      if (label && label !== rule) text.append(el('span', 'chat-rule-label', label));
      const b = button('chat-secondary chat-rule-x', 'Remove', () => remove(b, body));
      b.setAttribute('aria-label', `Remove ${rule}`);
      row.append(text, b);
      return row;
    };
    const section = (title, hint, rows, empty) => {
      const box = el('section', 'chat-perm-sec');
      box.append(el('h4', 'chat-label', title), el('p', 'chat-hint', hint));
      box.append(...(rows.length ? rows : [el('div', 'chat-perm-empty', empty)]));
      return box;
    };
    const chatRows = (data.chat || []).map((r) => ruleRow(r.rule, r.label, { scope: 'chat', rule: r.rule }));
    const files = (data.project || []).filter((f) => f.rules?.length).map((f) => {
      const group = el('div', 'chat-perm-file');
      const name = el('div', 'chat-perm-file-name', f.file);
      name.title = f.path || f.file;
      group.append(name, ...f.rules.map((rule) => ruleRow(rule, null, { scope: 'project', rule, file: f.file })));
      return group;
    });
    ui.permsBody.replaceChildren(
      section('This chat', 'Allowed for the rest of this chat. Remove one and it asks again.', chatRows, 'Nothing allowed for this chat yet.'),
      section('This project', codex ? '' : 'Saved in the folder’s Claude settings, so every Claude session here skips the ask.', files,
        codex ? 'Codex keeps no project rules.' : 'No project rules in this folder.'),
    );
  }

  // The picker serves both the open chat (a PATCH, applied now or next turn) and the new chat draft.
  let pickKey = null;
  const pickKeyOf = (t) => `${t.tool}:${t.setting.key}:${t.value}`;
  function pickTarget(layer) {
    const own = layer.scope === 'new'
      ? draft && { tool: draft.tool, settings: draft.settings[draft.tool] }
      : convo.chat && { tool: convo.chat.tool, settings: convo.chat.settings };
    const setting = own && schemaOf(own.tool).find((s) => s.key === layer.key);
    return setting ? { ...own, setting, value: valueOf(own.settings, setting) } : null;
  }

  async function renderPicker(layer) {
    const sheet = ui.pickSheet;
    pickKey = null;
    let target = options && pickTarget(layer);
    if (!target) {
      sheet.replaceChildren(sheetHead(''), placeholder('Loading…'));
      try {
        options = await loadOptions();
      } catch (err) {
        sheet.lastChild.textContent = `Could not load options: ${err.message}`;
        return;
      }
      if (layer.scope === 'new') ensureDraft(options);
      if (!sameLayer(stack[stack.length - 1], layer)) return;
      // Without a chat view yet, renderChrome renders the picker once the hello arrives.
      if (!(target = pickTarget(layer))) return;
    }
    const { setting, value } = target;
    pickKey = pickKeyOf(target);
    const list = el('div', 'chat-pick-list');
    const choices = choiceOf(setting, value) ? setting.choices : [{ value, label: value, description: 'Custom model' }, ...setting.choices];
    for (const c of choices) {
      const on = c.value === value;
      const b = button(`chat-pick-opt${on ? ' on' : ''}${c.confirm ? ' chat-pick-risky' : ''}`, null, () => choose(layer, target, c.value, b));
      b.setAttribute('aria-pressed', String(on));
      b.dataset.value = c.value;
      b.append(el('span', 'chat-pick-mark', on ? '✓' : ''), el('span', 'chat-pick-label', c.label || c.value));
      if (c.description) b.append(el('span', 'chat-pick-desc', c.description));
      list.append(b);
    }
    const body = el('div', 'chat-sheet-body chat-pick-body');
    body.append(list);
    if (setting.custom) {
      const form = el('form', 'chat-pick-custom');
      const input = el('input', 'chat-text');
      Object.assign(input, { type: 'text', placeholder: `Other ${setting.label.toLowerCase()} name`, autocapitalize: 'off', spellcheck: false });
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', input.placeholder);
      const use = button('chat-secondary', 'Use');
      use.type = 'submit';
      form.append(input, use);
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) choose(layer, target, v, use);
      };
      body.append(form);
    }
    sheet.replaceChildren(sheetHead(setting.label), body);
  }

  async function choose(layer, { tool, setting, value }, next, b) {
    if (next === value) return back();
    const choice = choiceOf(setting, next);
    if (choice?.confirm && !confirm(choice.confirm)) return;
    if (layer.scope === 'new') {
      draft.settings[tool][setting.key] = next;
      if (choice?.confirm) draft.confirmed.add(confirmedKey(tool, setting.key, next));
      back();
      renderDraftChips();
      return;
    }
    const sheet = ui.pickSheet;
    const lock = (on) => {
      for (const x of sheet.querySelectorAll('button')) x.disabled = on;
    };
    lock(true);
    b.append(spinner());
    try {
      const { applied, ...chat } = await api('PATCH', `/api/chat/${convo.id}`, { settings: { [setting.key]: next }, ...(choice?.confirm ? { confirmBypass: true } : {}) });
      setChat(chat);
      if (sameLayer(stack[stack.length - 1], layer)) back();
      const how = applied?.[setting.key];
      if (how) toast(`${setting.label}: ${choiceLabel(setting, next)} · ${how === 'now' ? 'applied now' : 'from the next turn'}`);
    } catch (err) {
      lock(false);
      b.querySelector('.chat-spin')?.remove();
      sheetError(sheet, err.message);
    }
  }

  let toastTimer = 0;
  function toast(text) {
    const t = ui.toast;
    const overDock = convoIdOf(stack) && !hasLayer(stack, 'perms');
    t.style.bottom = `${(overDock ? ui.dock.offsetHeight : 0) + 14}px`;
    t.textContent = text;
    t.hidden = false;
    t.classList.remove('on');
    void t.offsetWidth;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    ui.toast.hidden = true;
  }

  // Conversation state. events is ordered by seq; nodes maps event id to its rendered element.
  let seed = null;
  const convo = {
    id: null, chat: null, events: [], byId: new Map(), nodes: new Map(), expanded: new Set(),
    dirty: new Set(), chatDirty: false, frame: 0, stick: true,
    connection: null, online: false, everOnline: false, leaving: false,
    files: [], uploadsOff: false, sending: false,
  };
  let draftStorage;
  try { draftStorage = sessionStorage; } catch {}
  const drafts = new window.PocketDevDrafts(draftStorage);
  const pendingSends = new Set();
  const removingQueued = new Set();
  const queueEdits = new Map();
  let queueKey = '';
  function persistQueueEdit(id) {
    try {
      const edit = queueEdits.get(id);
      const key = `pd.chat.queue-edit.${id}`;
      if (edit) draftStorage.setItem(key, JSON.stringify({ ...edit, saving: false }));
      else draftStorage.removeItem(key);
    } catch {}
  }
  function restoreQueueEdit(id) {
    if (!queueEdits.has(id)) {
      try {
        const saved = JSON.parse(draftStorage.getItem(`pd.chat.queue-edit.${id}`));
        if (saved && typeof saved.eventId === 'string' && typeof saved.text === 'string' && typeof saved.expectedText === 'string' && Array.isArray(saved.files) && saved.files.every((f) => typeof f.path === 'string' && typeof f.name === 'string')) {
          queueEdits.set(id, { ...saved, saving: false });
        }
      } catch {}
    }
    return queueEdits.get(id);
  }
  function saveDraft(id = convo.id, text = ui.input.value, files = convo.files) {
    if (!id) return;
    const edit = queueEdits.get(id);
    if (edit) { edit.text = text; persistQueueEdit(id); return; }
    drafts.save(id, text, files);
  }

  function resetLog() {
    convo.events = [];
    convo.byId.clear();
    convo.nodes.clear();
    convo.dirty.clear();
    ui.log.replaceChildren();
  }

  function enterConvo(id) {
    const draft = restoreQueueEdit(id) || drafts.get(id);
    Object.assign(convo, { id, chat: seed?.id === id ? seed : null, stick: true, online: false, everOnline: false, leaving: false, files: draft.files, sending: pendingSends.has(id) });
    convo.expanded = new Set();
    seed = null;
    resetLog();
    ui.input.value = draft.text;
    queueKey = '';
    ui.queue.hidden = true;
    ui.queue.replaceChildren();
    ui.notice.hidden = true;
    growInput();
    renderFiles();
    cardKey = null;
    ui.card.hidden = true;
    ui.title.textContent = convo.chat?.title || '';
    ui.sub.replaceChildren();
    chipsKey = '';
    ui.chips.replaceChildren();
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
    saveDraft();
    disconnect();
    convo.id = null;
    convo.chat = null;
    cancelAnimationFrame(convo.frame);
    convo.frame = 0;
  }

  function connect() {
    const id = convo.id;
    convo.connection = new window.PocketDevConnection({
      url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/${encodeURIComponent(id)}`,
      waitForHello: true,
      beforeConnect: async (signal) => {
        if (convo.everOnline) {
          try {
            const chats = await api('GET', '/api/chat', undefined, undefined, { signal });
            if (!chats.some((c) => c.id === id)) { chatGone(); return false; }
          }
          catch (err) { if (err.status === 404) { chatGone(); return false; } throw err; }
        }
        return convo.id === id;
      },
      onState(state) {
        convo.online = state === 'connected';
        if (convo.online) convo.everOnline = true;
        renderConn();
      },
      onMessage,
      onClose(e) { if (e.code === 4404) { chatGone(); return false; } },
    });
  }

  function disconnect() {
    convo.connection?.dispose();
    convo.connection = null;
    convo.online = false;
  }

  function chatGone() {
    disconnect();
    if (convo.leaving || !convoIdOf(stack)) return;
    convo.leaving = true;
    const depth = stack.length - stack.findIndex((l) => l.layer === 'convo');
    history.go(-depth);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveDraft();
    else if (listVisible()) refreshList();
  });
  window.addEventListener('pagehide', () => saveDraft());

  function onMessage(msg) {
    if (msg.t === 'hello') {
      resetLog();
      for (const ev of msg.events) upsert(ev);
      setChat(msg.chat);
      reconcileQueueEdit();
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
    renderQueue();
    renderWork();
    if (stick) scrollToBottom();
    renderLatest();
  }

  // Helper agents and the todo list, pinned above the composer so they stay in view while the log scrolls.
  const HELPERS = new Set(['Agent', 'Task']);
  // A background agent's call finishes at once; the SDK's task messages say whether the agent itself is still working.
  // Agents resumed or started before the SDK sent task messages have no agentStatus; a helper that did something in the
  // last minute and a half is still working.
  const ACTIVE_MS = 90_000;
  const helperState = (ev) => ev.agentStatus ?? (ev.status !== 'running' && ev.activeAt && Date.now() - ev.activeAt < ACTIVE_MS ? 'running' : ev.status);
  const MARK = { completed: '✓', in_progress: '▶', pending: '○' };
  let workOpen = false;
  let workKey = '';
  function renderWork() {
    const events = convo.events;
    // One row per agent. A resumed agent shows up as a SendMessage call carrying the same task id as the Agent call that
    // started it, so rows are merged by task id: the newest call gives the state and the first named call gives the label.
    const byAgent = new Map();
    for (const e of events) {
      if (e.type !== 'tool-run' || !(HELPERS.has(e.name) || (e.agentStatus && e.name === 'SendMessage'))) continue;
      const key = e.taskId || e.id;
      const prev = byAgent.get(key);
      const label = (prev?.named && prev.label) || (HELPERS.has(e.name) ? e.summary : '') || prev?.label || e.summary || e.name;
      byAgent.set(key, { ...e, label, named: !!(prev?.named || HELPERS.has(e.name)) });
    }
    const helpers = [...byAgent.values()];
    const running = helpers.filter((e) => helperState(e) === 'running');
    const todos = [...events].reverse().find((e) => e.type === 'tool-run' && e.name === 'TodoWrite')?.todos ?? [];
    const open = todos.filter((t) => t.status !== 'completed');
    const show = running.length > 0 || (open.length > 0 && isBusy(convo.chat || {}));
    const key = JSON.stringify([show, workOpen, helpers.map((e) => [e.id, helperState(e), e.steps, e.latest]), todos]);
    if (key === workKey) return;
    workKey = key;
    ui.work.hidden = !show;
    if (!show) return;
    const done = todos.length - open.length;
    const parts = [];
    if (running.length) parts.push(`${running.length} ${running.length === 1 ? 'agent' : 'agents'} running`);
    if (todos.length) parts.push(`${done}/${todos.length} tasks`);
    const head = el('button', 'chat-work-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(workOpen));
    head.append(running.length ? spinner() : el('span', 'chat-work-dot'), el('span', 'chat-work-title', parts.join(' · ')), el('span', 'chat-work-caret', workOpen ? '▾' : '▸'));
    head.onclick = () => {
      workOpen = !workOpen;
      renderWork();
    };
    keepFocus(head);
    const body = el('div', 'chat-work-body');
    body.hidden = !workOpen;
    for (const h of helpers.slice(-6)) {
      const state = helperState(h);
      const row = el('div', `chat-work-row chat-work-${state}`);
      row.append(state === 'running' ? spinner() : runIcon(state === 'completed' ? 'ok' : state === 'failed' ? 'error' : state), el('span', 'chat-work-name', h.label || h.summary || h.name));
      if (h.latest) row.append(el('span', 'chat-work-latest', `${h.steps ? `${h.steps} ${h.steps === 1 ? 'step' : 'steps'} · ` : ''}${h.latest}`));
      body.append(row);
    }
    for (const t of todos) {
      const row = el('div', `chat-work-row chat-todo-${t.status}`);
      row.append(el('span', 'chat-todo-mark', MARK[t.status] || '○'), el('span', 'chat-work-name', t.text));
      body.append(row);
    }
    ui.work.replaceChildren(head, body);
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

  // A picture a tool returned, saved by the server. Tapping it opens the full size in a new tab.
  function toolImage(name) {
    const link = el('a', 'chat-tool-img-link');
    link.href = `/api/chat/${convo.id}/image/${name}`;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = el('img', 'chat-tool-img');
    img.src = link.href;
    img.loading = 'lazy';
    img.alt = 'Image from the tool';
    link.append(img);
    return link;
  }

  function renderQueue() {
    renderComposer();
    const waiting = convo.events.filter((ev) => ev.type === 'user-text' && ev.queued && !ev.removed && !ev.notSent);
    const tool = TOOLS[convo.chat?.tool] || 'Agent';
    const editing = queueEdits.get(convo.id);
    const key = JSON.stringify([convo.id, tool, convo.online, supportsQueueEdit(), editing?.eventId, waiting.map((ev) => [ev.id, ev.text, ev.attachments, removingQueued.has(ev.id)])]);
    if (key === queueKey) return;
    queueKey = key;
    ui.queue.hidden = !waiting.length;
    ui.queue.setAttribute('aria-label', `${tool} queued messages`);
    const scroll = ui.queue.scrollTop;
    ui.queue.replaceChildren(...waiting.map((ev, index) => {
      const row = el('div', 'chat-queue-row');
      row.setAttribute('role', 'listitem');
      const label = el('span', 'chat-queue-label', waiting.length > 1 ? `Queued ${index + 1}/${waiting.length}` : 'Queued');
      const files = ev.attachments || [];
      const text = ev.text || files.map(baseName).join(', ') || 'Attached file';
      const preview = el('span', 'chat-queue-preview', `${text}${ev.text && files.length ? ` · ${files.length} attached` : ''}`);
      preview.title = preview.textContent;
      const remove = button('chat-queue-remove', 'Remove', () => removeQueued(ev.id));
      remove.setAttribute('aria-label', `Remove queued message ${index + 1}`);
      remove.disabled = !convo.online || removingQueued.has(ev.id);
      const edit = button('chat-queue-edit-button', editing?.eventId === ev.id ? 'Editing' : 'Edit', () => editQueued(ev.id));
      edit.setAttribute('aria-label', `Edit queued message ${index + 1}`);
      edit.disabled = !convo.online || removingQueued.has(ev.id) || !!editing;
      row.append(label, preview, edit, remove);
      return row;
    }));
    ui.queue.scrollTop = scroll;
  }

  function editQueued(eventId) {
    if (!convo.online || queueEdits.has(convo.id) || removingQueued.has(eventId)) return;
    if (!supportsQueueEdit()) return notice(QUEUE_UPDATE_MESSAGE, { persistent: true });
    if (convo.sending || convo.files.some((f) => !f.path)) return notice('Wait for sending or uploading to finish before editing.');
    const ev = convo.events.find((ev) => ev.id === eventId && ev.queued && !ev.removed && !ev.notSent);
    if (!ev) return notice('That message is not waiting any more.');
    saveDraft();
    const edit = { eventId, text: ev.text, expectedText: ev.text, files: (ev.attachments || []).map((path) => ({ path, name: baseName(path) })), saving: false };
    queueEdits.set(convo.id, edit);
    persistQueueEdit(convo.id);
    ui.input.value = edit.text;
    convo.files = edit.files;
    growInput();
    renderFiles();
    renderQueue();
    ui.input.focus();
  }

  function supportsQueueEdit() {
    return convo.chat?.capabilities?.queueEdit === true;
  }

  function reconcileQueueEdit() {
    if (supportsQueueEdit() && ui.notice?.textContent === QUEUE_UPDATE_MESSAGE) ui.notice.hidden = true;
    const edit = queueEdits.get(convo.id);
    if (!edit) return;
    // A fresh snapshot can recover drafts that older clients wrongly marked
    // unavailable after receiving a generic missing-route 404.
    if (convo.events.some((ev) => ev.id === edit.eventId && ev.queued && !ev.removed && !ev.notSent)) edit.unavailable = false;
    edit.serverUpdateRequired = !supportsQueueEdit();
    persistQueueEdit(convo.id);
  }

  function finishQueueEdit(id, edit, keep = false) {
    if (queueEdits.get(id) !== edit) return;
    queueEdits.delete(id);
    persistQueueEdit(id);
    let draft = drafts.get(id);
    if (keep) {
      const files = [...draft.files];
      for (const file of edit.files) if (!files.some((f) => f.path === file.path)) files.push(file);
      draft = drafts.save(id, [draft.text, edit.text].filter(Boolean).join('\n\n'), files);
    }
    if (convo.id !== id) return;
    ui.input.value = draft.text;
    convo.files = draft.files;
    growInput();
    renderFiles();
    renderQueue();
  }

  async function saveQueuedEdit() {
    const id = convo.id, edit = queueEdits.get(id);
    if (!edit || edit.saving || !convo.online) return;
    saveDraft();
    const waiting = !edit.unavailable && convo.events.find((ev) => ev.id === edit.eventId && ev.queued && !ev.removed && !ev.notSent);
    if (!waiting) return finishQueueEdit(id, edit, true);
    if (!supportsQueueEdit() || edit.serverUpdateRequired) return notice(QUEUE_UPDATE_MESSAGE, { persistent: true });
    const text = edit.text;
    if (!text.trim() && !edit.files.length) return;
    edit.saving = true;
    renderComposer();
    try {
      const chat = await sendWithTimeout(`/api/chat/${id}/queue`, { eventId: edit.eventId, text, expectedText: edit.expectedText }, 'PATCH');
      if (chat?.id !== id) throw new Error('The server did not confirm the edit. Your changes are still here.');
      // Keep any text typed while the request was in flight.
      if (convo.id === id) saveDraft();
      if (edit.text === text) finishQueueEdit(id, edit);
      else { edit.expectedText = text; persistQueueEdit(id); }
      if (convo.id === id) setChat(chat);
    } catch (err) {
      const unsupported = err.status === 404 && ['Not found', 'HTTP 404'].includes(err.message);
      if (err.status === 404 && (err.code === 'QUEUE_MESSAGE_GONE' || err.message.startsWith('That message is not waiting any more'))) edit.unavailable = true;
      if (unsupported) edit.serverUpdateRequired = true;
      persistQueueEdit(id);
      if (convo.id === id) notice(unsupported ? QUEUE_UPDATE_MESSAGE : err.name === 'AbortError' || err instanceof TypeError ? 'Could not confirm the edit. Your changes are still here; you can retry.' : err.message, { persistent: unsupported });
    } finally {
      edit.saving = false;
      if (convo.id === id) renderComposer();
    }
  }

  async function removeQueued(eventId) {
    if (!convo.online || removingQueued.has(eventId)) return;
    const id = convo.id;
    removingQueued.add(eventId);
    renderQueue();
    try {
      const chat = await sendWithTimeout(`/api/chat/${id}/queue`, { eventId }, 'DELETE');
      if (convo.id === id) setChat(chat);
    } catch (err) {
      if (convo.id === id) notice(err.message);
    } finally {
      removingQueued.delete(eventId);
      if (convo.id === id) renderQueue();
    }
  }

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

  // The picture a person attached, small, with a tap to open the full size. If it is gone, the file name shows instead.
  function attachedImage(ev, index) {
    const href = `/api/chat/${convo.id}/attachment/${ev.id}.${index}`;
    const link = el('a', 'chat-user-img-link');
    link.href = `${href}?full=1`;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = el('img', 'chat-user-img');
    img.src = href;
    img.loading = 'lazy';
    img.alt = baseName(ev.attachments[index]);
    img.onerror = () => link.replaceWith(el('span', 'chat-user-file', `📎 ${baseName(ev.attachments[index])}`));
    link.append(img);
    return link;
  }

  const RENDER = {
    'user-text': (ev) => {
      if (ev.removed || ev.queued) {
        const gone = el('div');
        gone.hidden = true;
        return gone;
      }
      const node = el('div', 'chat-user');
      if (ev.text) node.append(el('div', 'chat-user-text', ev.text));
      if (ev.attachments?.length) {
        const files = el('div', 'chat-user-files');
        ev.attachments.forEach((p, i) => files.append(IMAGE_EXT.test(p) ? attachedImage(ev, i) : el('span', 'chat-user-file', `📎 ${baseName(p)}`)));
        node.append(files);
      }
      if (ev.notSent) {
        node.append(el('div', 'chat-queued-tag chat-queued-lost', 'Not sent: the turn failed or the server restarted'));
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
      if (ev.model) {
        const model = el('div', 'chat-model', shortModel(ev.model));
        model.title = ev.model;
        node.append(model);
      }
      return node;
    },
    thinking: (ev) => fold(ev, 'chat-thinking', [el('span', 'chat-fold-name', 'Thinking…'), ...(ev.streaming ? [spinner()] : [])],
      () => el('div', 'chat-thinking-text', ev.text || '')),
    'tool-run': (ev) => fold(ev, 'chat-tool',
      [el('span', 'chat-fold-name', ev.name), el('span', 'chat-fold-summary', ev.summary || ''), helperState(ev) === 'running' ? spinner() : runIcon(ev.status)],
      () => {
        const body = el('div', 'chat-fold-body');
        if (ev.input) body.append(el('div', 'chat-io-label', 'Input'), el('pre', 'chat-io chat-pre', ev.input));
        if (ev.output || ev.status === 'running') body.append(el('div', 'chat-io-label', 'Output'), el('pre', 'chat-io chat-pre', ev.output || '…'));
        if (ev.images?.length) body.append(el('div', 'chat-io-label', ev.images.length > 1 ? 'Images' : 'Image'), ...ev.images.map(toolImage));
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
    renderChips();
    ui.input.placeholder = `Message ${TOOLS[c.tool] || c.tool}`;
    renderComposer();
    renderStatusLine();
    renderWork();
    const pick = stack.find((l) => l.layer === 'pick' && l.scope === 'chat');
    const target = pick && pickTarget(pick);
    if (target && pickKeyOf(target) !== pickKey) renderPicker(pick);
    if (hasLayer(stack, 'settings') && ui.settingsSheet.dataset.chat !== c.id) renderSettings();
  }

  // Rebuilding chips under a finger swallows the tap, so only rebuild when a value changed.
  let chipsKey = '';
  function renderChips() {
    const c = convo.chat;
    const schema = schemaOf(c.tool);
    const key = JSON.stringify([c.id, c.tool, c.settings, schema.length]);
    if (key === chipsKey) return;
    chipsKey = key;
    ui.chips.replaceChildren(...schema.map((s) => settingChip(s, valueOf(c.settings, s), () => {
      if (top() === 'convo') push({ layer: 'pick', key: s.key, scope: 'chat' });
    })));
    fadeChips();
  }
  function fadeChips() {
    const { scrollLeft, scrollWidth, clientWidth } = ui.chips;
    ui.chips.classList.toggle('more-l', scrollLeft > 2);
    ui.chips.classList.toggle('more-r', scrollWidth - scrollLeft - clientWidth > 2);
  }
  ui.chips.addEventListener('scroll', fadeChips, { passive: true });
  new ResizeObserver(fadeChips).observe(ui.chips);

  async function stopTurn() {
    try {
      setChat(await api('POST', `/api/chat/${convo.id}/interrupt`));
    } catch (err) {
      notice(err.message);
    }
  }
  // The text and Stop button are built once so the one-second tick never replaces a button under the finger.
  const statusText = el('span', 'chat-status-text');
  const statusStop = button('chat-status-stop', 'Stop', stopTurn);
  keepFocus(statusStop);
  let statusMode = null;

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
      text = `${TOOLS[c.tool]} is working… ${c.runningSince ? ticking(Date.now() - c.runningSince) : ''}${c.queued ? ` · ${c.queued} queued` : ''}`.trim();
    }
    ui.statusline.hidden = !text;
    ui.statusline.className = `chat-statusline${cls}`;
    if (!text) {
      statusMode = null;
      return;
    }
    statusText.textContent = text;
    // Stop shows whenever a turn is in progress, including while it waits for you, so it is never missing.
    const stoppable = !!c && isBusy(c);
    const mode = `${cls ? 'wait' : c?.waking ? 'wake' : 'busy'}${stoppable ? '+stop' : ''}`;
    if (mode === statusMode) return;
    statusMode = mode;
    ui.statusline.replaceChildren(...(cls ? [statusText] : [spinner(), statusText]), ...(stoppable ? [statusStop] : []));
  }

  setInterval(() => {
    if (convo.id && convo.chat?.runningSince && !document.hidden) renderStatusLine();
  }, 1000);
  // An agent that goes quiet stops counting as running without any event arriving, so look again now and then.
  setInterval(() => {
    if (convo.id && !document.hidden) renderWork();
  }, 15_000);

  function renderConn() {
    ui.conn.hidden = convo.online;
    ui.conn.textContent = navigator.onLine === false ? 'Offline · your draft is saved' : convo.everOnline ? 'Reconnecting… your draft is saved' : 'Connecting…';
    ui.card.hidden = !convo.online || !pendingEvent();
    statusStop.disabled = !convo.online;
    renderQueue();
    renderComposer();
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
  ui.menu.onclick = () => {
    if (top() === 'convo') push({ layer: 'settings' });
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
    ui.card.hidden = !convo.online || !ev;
    if (key === cardKey) return;
    cardKey = key;
    ui.card.replaceChildren(...(ev ? [ev.type === 'question' ? questionCard(ev) : permissionCard(ev)] : []));
  }

  async function answer(card, body) {
    if (!convo.online) return;
    const id = convo.id;
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      const chat = await sendWithTimeout(`/api/chat/${id}/answer`, body);
      if (convo.id === id) setChat(chat);
    } catch (err) {
      if (convo.id !== id) return;
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
    const decide = (o) => () => {
      if (o.id === 'deny' && reason.hidden) {
        reason.hidden = false;
        reason.focus();
        return;
      }
      const message = o.id === 'deny' ? reason.value.trim() : '';
      answer(card, { requestId: ev.requestId, decision: o.id, ...(message ? { message } : {}) });
      closeKeyboard();
    };
    const opt = (o, cls) => {
      const b = button(cls, o.label, decide(o));
      b.dataset.decision = o.id;
      if (o.id === 'deny') keepFocus(b);
      return b;
    };
    // Remembering options sit together under the rule they save; the one-shot answers share the bottom row.
    const opts = ev.options?.length ? ev.options : FALLBACK_OPTIONS;
    const remember = opts.filter((o) => o.id !== 'allow' && o.id !== 'deny');
    const actions = el('div', 'chat-card-actions');
    if (remember.length) {
      if (ev.rule) {
        const rule = el('div', 'chat-card-rule');
        rule.append(el('span', 'chat-card-rule-k', 'Remembers'), el('code', 'chat-card-rule-v', ev.rule));
        actions.append(rule);
      }
      const row = el('div', `chat-card-row chat-card-remember${remember.length > 1 ? ' chat-card-two' : ''}`);
      row.append(...remember.map((o) => opt(o, 'chat-secondary chat-remember')));
      actions.append(row);
    }
    const final = el('div', 'chat-card-row chat-card-final');
    final.append(...opts.filter((o) => o.id === 'deny').map((o) => opt(o, 'chat-deny')), ...opts.filter((o) => o.id === 'allow').map((o) => opt(o, 'chat-primary')));
    actions.append(reason, final);
    reason.onkeydown = (e) => {
      if (e.key === 'Enter') actions.querySelector('.chat-deny')?.click();
    };
    card.append(scroll, actions);
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

  let noticeTimer = 0;
  function notice(text, { persistent = false } = {}) {
    ui.notice.textContent = text;
    ui.notice.hidden = false;
    clearTimeout(noticeTimer);
    if (!persistent) noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 5000);
  }

  function growInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, MAX_INPUT_PX)}px`;
    ui.input.style.overflowY = ui.input.scrollHeight > MAX_INPUT_PX ? 'auto' : 'hidden';
  }

  function renderComposer() {
    const edit = queueEdits.get(convo.id);
    const waiting = edit && !edit.unavailable && convo.events.some((ev) => ev.id === edit.eventId && ev.queued && !ev.removed && !ev.notSent);
    const updateRequired = waiting && (!supportsQueueEdit() || edit.serverUpdateRequired);
    const editBar = q('.chat-queue-edit');
    editBar.hidden = !edit;
    if (edit) q('.chat-queue-edit-label').textContent = updateRequired ? 'Update Pocket Dev to save this edit' : waiting ? `Editing queued message${edit.files.length ? ` · ${edit.files.length} attached` : ''}` : 'No longer queued. Keep your edit as a draft.';
    q('.chat-queue-cancel').disabled = !!edit?.saving;
    const busy = convo.chat && isBusy(convo.chat);
    const uploading = convo.files.some((f) => !f.path);
    const hasInput = !!ui.input.value.trim() || convo.files.length > 0;
    // While the agent works, text in the box is queued. Stop lives in the status line, so there is never a second one here.
    ui.send.textContent = edit ? (edit.saving ? 'Saving…' : waiting ? 'Save' : 'Keep draft') : busy ? 'Queue' : 'Send';
    ui.send.classList.remove('chat-stop');
    ui.send.disabled = !convo.online || convo.sending || uploading || !hasInput || !!edit?.saving || !!updateRequired;
    ui.input.setAttribute('aria-label', edit ? 'Edit queued message' : 'Message');
    ui.attach.disabled = !!edit || !convo.online || convo.uploadsOff;
    ui.attach.title = convo.uploadsOff ? 'Attachments are not available on this server' : 'Attach a file';
  }

  function renderFiles() {
    ui.files.hidden = queueEdits.has(convo.id) || !convo.files.length;
    ui.files.replaceChildren(...convo.files.map((f) => {
      const chip = el('span', `chat-file${f.path ? '' : ' chat-file-up'}`);
      chip.append(el('span', 'chat-file-name', f.path ? f.name : `${f.name} (uploading…)`));
      const x = button('chat-file-x', '✕', () => {
        convo.files = convo.files.filter((g) => g !== f);
        saveDraft();
        renderFiles();
      });
      x.setAttribute('aria-label', `Remove ${f.name}`);
      x.hidden = queueEdits.has(convo.id);
      chip.append(x);
      return chip;
    }));
    renderComposer();
  }

  ui.input.addEventListener('input', () => {
    saveDraft();
    growInput();
    renderComposer();
  });
  keepFocus(ui.send);
  q('.chat-queue-cancel').onclick = () => {
    const edit = queueEdits.get(convo.id);
    if (edit && !edit.saving) finishQueueEdit(convo.id, edit);
  };
  ui.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (queueEdits.has(convo.id)) return saveQueuedEdit();
    if (!convo.id || !convo.online || convo.sending || convo.files.some((f) => !f.path)) return;
    const id = convo.id;
    const text = ui.input.value.trim();
    const attachments = convo.files.filter((f) => f.path).map((f) => f.path);
    if (!text && !attachments.length) return;
    saveDraft();
    const sent = drafts.submission(id);
    convo.sending = true;
    pendingSends.add(id);
    renderComposer();
    try {
      const chat = await sendWithTimeout(`/api/chat/${id}/message`, { text, clientMessageId: sent.clientMessageId, ...(attachments.length ? { attachments } : {}) });
      if (chat?.id !== id) throw new Error('The server did not confirm this message. Your draft is saved.');
      // A response can arrive after the user switches chats or keeps typing.
      // Clear only the draft that was actually submitted.
      if (convo.id === id) saveDraft();
      const draft = drafts.acknowledge(id, sent);
      if (convo.id !== id) return;
      ui.input.value = draft.text;
      convo.files = draft.files;
      growInput();
      renderFiles();
      convo.stick = true;
      setChat(chat);
      closeKeyboard();
    } catch (err) {
      if (convo.id === id) notice(err.name === 'AbortError' || err instanceof TypeError ? 'Could not confirm sending. Your draft is saved; retrying will not send it twice.' : err.message);
    } finally {
      pendingSends.delete(id);
      if (convo.id === id) { convo.sending = false; renderComposer(); }
    }
  });

  ui.attach.onclick = () => ui.fileInput.click();
  ui.fileInput.onchange = async () => {
    if (queueEdits.has(convo.id)) { ui.fileInput.value = ''; return; }
    const picked = [...ui.fileInput.files];
    const id = convo.id;
    const files = convo.files;
    ui.fileInput.value = '';
    for (const file of picked) {
      const f = { name: file.name, path: null };
      files.push(f);
      if (convo.id === id && convo.files === files) renderFiles();
      try {
        f.path = (await api('POST', '/api/upload', file, { 'x-filename': encodeURIComponent(file.name) })).path;
      } catch (err) {
        const index = files.indexOf(f);
        if (index !== -1) files.splice(index, 1);
        if (convo.id !== id || convo.files !== files) continue;
        if (err.status === 404) {
          convo.uploadsOff = true;
          convo.files = convo.files.filter((g) => g.path);
          saveDraft();
          renderFiles();
          notice('This server cannot receive attachments yet.');
          return;
        }
        notice(`Could not upload ${file.name}: ${err.message}`);
      }
      if (convo.id === id && convo.files === files) { saveDraft(); renderFiles(); }
      else {
        const draft = drafts.get(id);
        if (draft?.files === files) saveDraft(id, draft.text, files);
      }
    }
  };

  window.pocketDevChat = {
    open(chatId) {
      if (chatId) return showChat({ id: chatId });
      if (!stack.length) push({ layer: 'list' });
    },
    current: () => convoIdOf(stack),
    async startFromSession({ tool, id, cwd, title }) {
      const chat = await api('POST', '/api/chat', { tool, cwd, resume: { sessionId: id }, ...(title && { title: title.slice(0, 200) }) });
      showChat(chat);
      return chat;
    },
  };

  // Covers a reload and a typed or linked #chat / #chat=<id>. Own history entries carry the stack across a reload;
  // with the shared overlay stack the hash is read once, stripped, and a reload restores from sessionStorage.
  function openFromHash() {
    const m = location.hash.match(/^#chat(?:=([\w-]+))?$/);
    const layers = m && [{ layer: 'list' }, ...(m[1] ? [{ layer: 'convo', id: m[1] }] : [])];
    if (sharedOverlays) {
      if (!m) return;
      history.replaceState(history.state, '', location.pathname + location.search);
      if (stack.length) replace(layers);
      else push(...layers);
      return;
    }
    if (!m || (stack.length && hashFor(stack) === location.hash)) return;
    const saved = history.state?.pdChat;
    if (Array.isArray(saved) && hashFor(saved) === location.hash) return apply(saved);
    history.replaceState(null, '', location.pathname + location.search);
    if (stack.length) apply([]);
    push(...layers);
  }
  window.addEventListener('hashchange', openFromHash);
  const restored = sharedOverlays && !location.hash.startsWith('#chat') && savedStack();
  if (restored?.length) push(...restored);
  else openFromHash();
})();
