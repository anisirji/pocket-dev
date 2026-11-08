(() => {
  const ICONS = {
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    image: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9" r="1.7"/><path d="m20.5 15-4.6-4.6L6 20.3"/>',
    pdf: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>',
    video: '<rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3z"/>',
    audio: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    code: '<path d="m15.5 17.5 5.5-5.5-5.5-5.5M8.5 6.5 3 12l5.5 5.5"/>',
    text: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 15.5h6M9 18h3.5"/>',
    archive: '<rect x="3.5" y="3.5" width="17" height="5" rx="1.5"/><path d="M5 8.5v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10M10 12.5h4"/>',
    other: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
    up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
    sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    upload: '<path d="M12 16V4M6.5 9.5 12 4l5.5 5.5M4 20h16"/>',
    newfolder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM12 10.5v6M9 13.5h6"/>',
    download: '<path d="M12 4v12M6.5 10.5 12 16l5.5-5.5M4 20h16"/>',
    rename: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
    select: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12 3 3 5-6"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    pin: '<path d="M9 4h6l-1 6 3.5 3.5h-11L10 10zM12 13.5V20"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
    chev: '<path d="m9.5 6 6 6-6 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    home: '<path d="M4 11 12 4.5l8 6.5M6 9.5V19.5h4.5V14h3v5.5H18V9.5"/>',
    collapse: '<path d="m6 9 6 6 6-6"/>',
    expand: '<path d="m6 15 6-6 6 6"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  const h = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const iconButton = (icon, label, cls = 'fx-btn') => {
    const b = h('button', cls);
    b.type = 'button';
    b.innerHTML = svg(icon);
    b.setAttribute('aria-label', label);
    return b;
  };
  const labeled = (icon, label, cls) => {
    const b = h('button', cls);
    b.type = 'button';
    b.innerHTML = svg(icon);
    b.append(h('span', null, label));
    return b;
  };

  const store = {
    get(key, fallback) { try { return localStorage.getItem(`pd.files.${key}`) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`pd.files.${key}`, value); } catch {} },
  };

  // index.html's api() sends x-pocket-dev and handles a lost login.
  const api = (method, url, body) => window.api(method, url, body);
  const qs = (params) => new URLSearchParams(params).toString();
  const fileUrl = (p, inline) => `/api/files/download?${qs({ path: p, inline: inline ? 1 : 0 })}`;

  const ARCHIVES = new Set(['application/zip', 'application/gzip', 'application/x-tar', 'application/x-bzip2', 'application/x-xz', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-apple-diskimage']);
  const CODE_EXTS = new Set('js mjs cjs jsx ts tsx py rb go rs java kt kts swift c h cc cpp hpp m mm cs php pl lua r sql sh bash zsh fish json css scss sass less html htm xml yml yaml toml vue svelte diff patch'.split(' '));
  const isDirish = (e) => e.type === 'dir' || e.linkType === 'dir';
  function kindOf(e) {
    if (isDirish(e)) return 'folder';
    const m = e.mime || '';
    if (m.startsWith('image/')) return 'image';
    if (m === 'application/pdf') return 'pdf';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (ARCHIVES.has(m)) return 'archive';
    if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') {
      return CODE_EXTS.has(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()) ? 'code' : 'text';
    }
    return 'other';
  }
  const kindIcon = (kind, isLink) => {
    const tile = h('span', `fx-ico fx-k-${kind}`);
    tile.innerHTML = svg(kind) + (isLink ? svg('link').replace('<svg', '<svg class="fx-link"') : '');
    return tile;
  };

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }
  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 2 * 86400) return 'yesterday';
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  }
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  // Plain http on the LAN is not a secure context, so navigator.clipboard is missing there.
  function copyText(text) {
    if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
    const ta = h('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
  }

  const SORTS = { name: 'Name', mtime: 'Modified', size: 'Size' };
  const TEXT_PREVIEW_BYTES = 200 * 1024;
  const SNIFF_MAX = 1024 * 1024;
  const ZIP_WARN = 500 * 1024 * 1024;
  const LONG_PRESS_MS = 450;

  const state = {
    root: null,
    els: null,
    places: null,
    dir: null,
    sort: SORTS[store.get('sort')] ? store.get('sort') : 'name',
    showHidden: store.get('hidden') === '1',
    query: '',
    results: null,
    selecting: false,
    selected: new Set(),
    fresh: new Set(),
    uploads: [],
    uploadsOpen: true,
    open: false,
    trail: [],
    loadSeq: 0,
    error: null,
  };

  // Same contract as index.html's pocketDev.overlays on the integration branch: each open() owns one history entry, so
  // Android's back gesture closes the topmost overlay; close(name) closes it and everything above it.
  function localOverlays() {
    const PAGE = Math.random().toString(36).slice(2);
    const stack = [];
    let queue = Promise.resolve();
    let ownPop = null;
    const run = (step) => { queue = queue.then(step); };
    window.addEventListener('popstate', (e) => {
      if (ownPop) return ownPop();
      const depth = e.state?.pdFilesPage === PAGE ? e.state.pdOverlay : 0;
      while (stack.length > depth) stack.pop().onClose();
    });
    return {
      open(name, onClose) {
        stack.push({ name, onClose });
        const depth = stack.length;
        run(() => history.pushState({ pdFilesPage: PAGE, pdOverlay: depth }, ''));
      },
      close(name) {
        const i = stack.findLastIndex((o) => o.name === name);
        if (i === -1) return;
        const closed = stack.splice(i);
        for (const o of closed.reverse()) o.onClose();
        run(() => new Promise((resolve) => {
          const done = () => { clearTimeout(timer); ownPop = null; resolve(); };
          const timer = setTimeout(done, 1000);
          ownPop = done;
          history.go(-closed.length);
        }));
      },
    };
  }
  let overlays = null;

  function build() {
    const root = h('div', 'fx-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Files');
    const head = h('div', 'fx-head');
    const bar = h('div', 'fx-bar');
    const up = iconButton('up', 'Up one folder');
    const crumbs = h('nav', 'fx-crumbs');
    const more = iconButton('more', 'More');
    const close = iconButton('close', 'Close files');
    bar.append(up, crumbs, more, close);

    const searchRow = h('div', 'fx-searchrow');
    const search = h('label', 'fx-search');
    search.innerHTML = svg('search');
    const input = h('input');
    Object.assign(input, { type: 'search', placeholder: 'Search', enterKeyHint: 'search', autocomplete: 'off', spellcheck: false });
    input.setAttribute('autocapitalize', 'off');
    const clear = iconButton('close', 'Clear search', 'fx-clear');
    clear.hidden = true;
    search.append(input, clear);
    const sortBtn = h('button', 'fx-sortbtn');
    sortBtn.type = 'button';
    searchRow.append(search, sortBtn);
    const chips = h('div', 'fx-chips');
    head.append(bar, searchRow, chips);

    const list = h('div', 'fx-list');
    const bottom = h('div', 'fx-bottom');
    const fabs = h('div', 'fx-fabs');
    const mkdirBtn = iconButton('newfolder', 'New folder', 'fx-fab2');
    const uploadBtn = labeled('upload', 'Upload', 'fx-fab');
    fabs.append(mkdirBtn, uploadBtn);
    const selbar = h('div', 'fx-selbar');
    const selCancel = iconButton('close', 'Cancel selection');
    const selCount = h('button', 'fx-selcount');
    const selRename = iconButton('rename', 'Rename', 'fx-act fx-icon');
    const selZip = labeled('download', 'Zip', 'fx-act');
    const selTrash = labeled('trash', 'Trash', 'fx-act fx-danger');
    selbar.append(selCancel, selCount, selRename, selZip, selTrash);
    const uploads = h('div', 'fx-uploads');
    bottom.append(fabs, selbar, uploads);

    const picker = h('input');
    Object.assign(picker, { type: 'file', multiple: true, accept: '*/*', hidden: true });
    root.append(head, list, bottom, picker);
    document.body.append(root);

    up.onclick = () => { if (state.dir?.parent) navigate(state.dir.parent); };
    close.onclick = closeFiles;
    more.onclick = () => openMenu(more, moreItems());
    sortBtn.onclick = () => openMenu(sortBtn, Object.entries(SORTS).map(([key, label]) => ({
      label, icon: 'sort', checked: state.sort === key,
      run: () => { state.sort = key; store.set('sort', key); refresh(); },
    })));
    let debounce = 0;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      clear.hidden = !input.value;
      debounce = setTimeout(() => runSearch(input.value), 280);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(debounce);
      runSearch(input.value);
      input.blur();
    });
    clear.onclick = (e) => {
      e.preventDefault();
      input.value = '';
      clear.hidden = true;
      runSearch('');
    };
    uploadBtn.onclick = () => picker.click();
    picker.onchange = () => {
      addUploads([...picker.files]);
      picker.value = '';
    };
    mkdirBtn.onclick = newFolder;
    selCancel.onclick = () => overlays.close('files-select');
    selRename.onclick = () => {
      const [only] = state.selected;
      const entry = visibleEntries().find((e) => e.path === only);
      if (entry) renameEntry(entry);
    };
    selCount.onclick = () => {
      const all = visibleEntries();
      state.selected = state.selected.size === all.length ? new Set() : new Set(all.map((e) => e.path));
      renderList();
    };
    selZip.onclick = () => zipDownload([...state.selected]);
    selTrash.onclick = () => trashPaths([...state.selected]);
    new ResizeObserver(() => list.style.setProperty('--fx-pad', `${bottom.offsetHeight + 16}px`)).observe(bottom);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dialogEl) closeDialog();
      else if (previewEl) overlays.close('files-preview');
      else if (state.selecting) overlays.close('files-select');
    });

    state.root = root;
    state.els = { up, crumbs, more, input, clear, sortBtn, chips, list, fabs, selbar, selCount, selRename, selZip, selTrash, uploads, picker };
  }

  const readOnly = () => !!(state.dir?.readOnly || state.places?.readOnly || (state.places?.scoped && state.error));
  function moreItems() {
    const dir = state.dir?.path;
    const pinned = state.places?.pinned.some((p) => p.path === dir);
    const items = [
      ...(!readOnly() ? [{ label: 'New folder', icon: 'newfolder', run: newFolder }] : []),
      { label: 'Select', icon: 'select', run: () => enterSelect(null) },
      { label: 'Show hidden files', icon: 'eye', checked: state.showHidden, run: () => { state.showHidden = !state.showHidden; store.set('hidden', state.showHidden ? '1' : '0'); refresh(); } },
      ...(!state.places?.scoped ? [{ label: pinned ? 'Unpin folder' : 'Pin folder', icon: 'pin', run: () => setPinned(dir, !pinned) }] : []),
    ];
    const openTerminal = window.pocketDev?.openTerminalAt;
    if (typeof openTerminal === 'function') {
      items.push({ label: 'Open terminal here', icon: 'terminal', run: () => { closeFiles(); openTerminal(dir); } });
    }
    return items;
  }

  let menuEls = null;
  function openMenu(anchor, items) {
    closeMenu();
    const scrim = h('div', 'fx-scrim');
    const menu = h('div', 'fx-menu');
    for (const item of items) {
      const b = labeled(item.icon, item.label);
      if (item.checked) b.insertAdjacentHTML('beforeend', svg('check').replace('<svg', '<svg class="fx-tick"'));
      b.onclick = () => { closeMenu(); item.run(); };
      menu.append(b);
    }
    scrim.onclick = closeMenu;
    state.root.append(scrim, menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    menuEls = [scrim, menu];
  }
  function closeMenu() {
    menuEls?.forEach((n) => n.remove());
    menuEls = null;
  }

  let toastTimer = 0;
  function toast(text, bad = false) {
    document.querySelector('.fx-toast')?.remove();
    const t = h('div', `fx-toast${bad ? ' fx-bad' : ''}`, text);
    state.root.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), bad ? 4000 : 2200);
  }

  // Resolves to the entered text (or true for a confirm), or null when cancelled. submit may throw to keep it open.
  let dialogEl = null;
  function ask({ title, message, value, okLabel = 'OK', danger = false, select, submit }) {
    closeDialog();
    return new Promise((resolve) => {
      const wrap = h('div', 'fx-dialog');
      const card = h('form', 'fx-card');
      card.append(h('h3', null, title));
      if (message) card.append(h('p', null, message));
      const input = value != null ? h('input') : null;
      if (input) {
        Object.assign(input, { value, autocomplete: 'off', spellcheck: false });
        input.setAttribute('autocapitalize', 'off');
        card.append(input);
      }
      const err = h('div', 'fx-err');
      const acts = h('div', 'fx-cardacts');
      const cancel = h('button', 'fx-ghost', 'Cancel');
      cancel.type = 'button';
      const ok = h('button', `fx-primary${danger ? ' fx-danger' : ''}`, okLabel);
      acts.append(cancel, ok);
      card.append(err, acts);
      wrap.append(card);
      let settled = false;
      const done = (result, fromBack = false) => {
        if (settled) return;
        settled = true;
        wrap.remove();
        dialogEl = null;
        if (!fromBack) overlays.close('files-dialog');
        resolve(result);
      };
      cancel.onclick = () => done(null);
      wrap.onclick = (e) => { if (e.target === wrap) done(null); };
      card.onsubmit = async (e) => {
        e.preventDefault();
        const result = input ? input.value : true;
        ok.disabled = true;
        try {
          if (submit) await submit(result);
          done(result);
        } catch (error) {
          err.textContent = error.message;
          ok.disabled = false;
        }
      };
      wrap.cancel = () => done(null);
      state.root.append(wrap);
      dialogEl = wrap;
      overlays.open('files-dialog', () => done(null, true));
      if (input) {
        input.focus();
        input.setSelectionRange(0, select ?? value.length);
      } else ok.focus();
    });
  }
  const closeDialog = () => dialogEl?.cancel();

  async function loadPlaces() {
    state.places = await api('GET', '/api/files/places');
  }

  async function load(path, { keepScroll = false } = {}) {
    const seq = ++state.loadSeq;
    const { list } = state.els;
    const scroll = list.scrollTop;
    try {
      const dir = await api('GET', `/api/files/list?${qs({ path, sort: state.sort, showHidden: state.showHidden ? 1 : 0 })}`);
      if (seq !== state.loadSeq) return;
      if (dir.path !== state.dir?.path) {
        state.selected.clear();
        if (state.query) { state.query = ''; state.results = null; state.els.input.value = ''; state.els.clear.hidden = true; }
      }
      state.dir = dir;
      state.error = null;
    } catch (err) {
      if (seq !== state.loadSeq) return;
      state.dir = state.dir?.path === path ? state.dir : { path, parent: parentOf(path), breadcrumbs: [{ name: baseName(path), path }], entries: [] };
      state.error = err.message;
    }
    render();
    list.scrollTop = keepScroll ? scroll : 0;
    const fresh = list.querySelector('.fx-fresh');
    if (fresh) fresh.scrollIntoView({ block: 'nearest' });
  }
  const refresh = () => (state.query ? runSearch(state.query) : load(state.dir.path, { keepScroll: true }));

  // Each folder opened inside Files is an overlay, so back returns to the folder before it. The load waits a microtask
  // because close('files') runs every folder's onClose before the view's own, which sets state.open to false.
  function navigate(path) {
    state.trail.push(path);
    overlays.open('files-dir', () => {
      state.trail.pop();
      queueMicrotask(() => { if (state.open) load(state.trail.at(-1)); });
    });
    return load(path);
  }

  let searchSeq = 0;
  async function runSearch(text) {
    const q = text.trim();
    state.query = q;
    const seq = ++searchSeq;
    if (!q) {
      state.results = null;
      return render();
    }
    state.results = { pending: true, results: [] };
    renderList();
    try {
      const r = await api('GET', `/api/files/search?${qs({ path: state.dir.path, q, showHidden: state.showHidden ? 1 : 0 })}`);
      if (seq === searchSeq) state.results = r;
    } catch (err) {
      if (seq === searchSeq) state.results = { error: err.message, results: [] };
    }
    if (seq === searchSeq) renderList();
  }

  const visibleEntries = () => (state.results ? state.results.results : state.dir?.entries ?? []);

  function render() {
    closeMenu();
    renderHead();
    renderList();
    renderBottom();
  }

  function renderHead() {
    const { up, crumbs, chips, sortBtn, input } = state.els;
    const dir = state.dir;
    up.disabled = !dir?.parent;
    const isHome = (p) => !state.places?.scoped && p === state.places?.home;
    crumbs.replaceChildren(...(dir?.breadcrumbs ?? []).flatMap((c, i) => {
      const b = h('button', 'fx-crumb', isHome(c.path) ? 'Home' : c.name);
      b.type = 'button';
      b.onclick = () => { if (c.path !== dir.path) navigate(c.path); };
      return i ? [h('span', 'fx-sep', '›'), b] : [b];
    }));
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    sortBtn.innerHTML = svg('sort');
    sortBtn.append(SORTS[state.sort]);
    const last = dir?.breadcrumbs.at(-1);
    input.placeholder = `Search ${last ? (isHome(last.path) ? 'Home' : last.name) : ''}`;
    const atTop = !dir?.parent;
    chips.hidden = !atTop || !state.places;
    if (chips.hidden) return;
    const places = [...state.places.quick.map((p) => ({ ...p, pin: false })), ...state.places.pinned.filter((p) => !state.places.quick.some((q) => q.path === p.path)).map((p) => ({ ...p, pin: true }))];
    chips.replaceChildren(...places.filter((p) => p.path !== dir.path).map((p) => {
      const chip = labeled(p.pin ? 'pin' : p.name === 'Home' ? 'home' : 'folder', p.name, `fx-chip${p.pin ? ' fx-pin' : ''}`);
      chip.onclick = () => navigate(p.path);
      return chip;
    }));
  }

  function metaOf(e) {
    if (e.type === 'symlink' && !e.linkType) return 'Link outside the shared folders';
    const when = ago(e.mtime);
    const where = state.results && e.dir ? `in ${relativeDir(e.dir)} · ` : '';
    return isDirish(e) ? `${where}${when}` : `${where}${formatSize(e.size)} · ${when}`;
  }
  function relativeDir(dir) {
    const base = state.dir.path;
    if (dir === base) return 'this folder';
    return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
  }

  function row(e) {
    const kind = kindOf(e);
    const dead = e.type === 'symlink' && !e.linkType;
    const el = h('div', `fx-row${dead ? ' fx-dead' : ''}${state.selected.has(e.path) ? ' fx-sel' : ''}${state.fresh.has(e.path) ? ' fx-fresh' : ''}`);
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    if (state.selecting) {
      const box = h('span', 'fx-check');
      box.innerHTML = svg('check');
      el.append(box);
    }
    const txt = h('span', 'fx-txt');
    txt.append(h('span', 'fx-name', e.name), h('span', 'fx-meta', metaOf(e)));
    el.append(kindIcon(kind, e.type === 'symlink'), txt);
    if (kind === 'folder' && !state.selecting) el.insertAdjacentHTML('beforeend', svg('chev').replace('<svg', '<svg class="fx-chev"'));
    attachPress(el, e);
    return el;
  }

  // A held press enters select mode; Android also fires contextmenu on a long press, which would open the menu.
  function attachPress(el, e) {
    let timer = 0, startX = 0, startY = 0, held = false;
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerdown', (ev) => {
      held = false;
      startX = ev.clientX;
      startY = ev.clientY;
      timer = setTimeout(() => {
        held = true;
        if (state.selecting) toggleSelected(e);
        else enterSelect(e);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (ev) => {
      if (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    el.addEventListener('click', () => {
      if (held) return;
      if (state.selecting) toggleSelected(e);
      else activate(e);
    });
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.click(); });
  }

  function activate(e) {
    if (e.type === 'symlink' && !e.linkType) return toast('That link points outside the shared folders.', true);
    if (isDirish(e)) return navigate(e.path);
    openPreview(e);
  }

  function renderList() {
    const { list } = state.els;
    const nodes = [];
    if (state.results) {
      const r = state.results;
      if (r.pending) nodes.push(h('div', 'fx-note', 'Searching…'));
      else if (r.error) nodes.push(emptyState('search', r.error));
      else if (!r.results.length) nodes.push(emptyState('search', `Nothing named “${state.query}” in this folder or 4 levels below.`));
      else {
        nodes.push(h('div', 'fx-section', `${r.results.length}${r.partial ? '+' : ''} result${r.results.length === 1 ? '' : 's'}`));
        nodes.push(...r.results.map(row));
        if (r.partial) nodes.push(h('div', 'fx-note', 'Showing the first matches. Open a smaller folder to search it fully.'));
      }
    } else if (state.error) {
      const box = emptyState('folder', state.error);
      const retry = h('button', 'fx-ghost', 'Try again');
      retry.onclick = () => load(state.dir.path);
      box.append(retry);
      nodes.push(box);
    } else if (state.dir) {
      const entries = state.dir.entries;
      if (!entries.length) nodes.push(emptyState('folder', state.showHidden ? 'This folder is empty.' : 'This folder is empty, or has only hidden files.'));
      nodes.push(...entries.map(row));
      if (state.dir.truncated) nodes.push(h('div', 'fx-note', `Showing ${entries.length.toLocaleString()} of ${state.dir.total.toLocaleString()} items. Search to find the rest.`));
    }
    list.replaceChildren(...nodes);
    renderSelbar();
  }

  function emptyState(icon, text) {
    const box = h('div', 'fx-empty');
    box.innerHTML = svg(icon);
    box.append(h('div', null, text));
    return box;
  }

  function enterSelect(e) {
    if (!state.selecting) overlays.open('files-select', () => setSelecting(false));
    setSelecting(true);
    if (e) state.selected.add(e.path);
    renderList();
  }
  function setSelecting(on) {
    if (state.selecting === on) return;
    state.selecting = on;
    if (!on) state.selected.clear();
    if (state.els) { renderList(); renderBottom(); }
  }
  function toggleSelected(e) {
    if (state.selected.has(e.path)) state.selected.delete(e.path);
    else state.selected.add(e.path);
    renderList();
  }
  function renderSelbar() {
    const { selCount, selRename, selZip, selTrash } = state.els;
    const n = state.selected.size;
    selCount.textContent = n ? `${n} selected` : 'Tap to select';
    selZip.disabled = selTrash.disabled = !n;
    selRename.disabled = n !== 1;
    selRename.hidden = selTrash.hidden = readOnly();
  }

  function renderBottom() {
    const { fabs, selbar } = state.els;
    fabs.hidden = state.selecting || readOnly();
    selbar.hidden = !state.selecting;
    renderUploads();
  }

  async function newFolder() {
    const dir = state.dir.path;
    const name = await ask({
      title: 'New folder', value: 'New Folder', okLabel: 'Create',
      submit: (value) => api('POST', '/api/files/mkdir', { dir, name: value.trim() }),
    });
    if (name == null) return;
    flash([`${dir}/${name.trim()}`]);
    load(dir, { keepScroll: true });
  }

  async function renameEntry(e) {
    const dot = e.name.lastIndexOf('.');
    let renamed;
    const name = await ask({
      title: 'Rename', value: e.name, okLabel: 'Rename',
      select: !isDirish(e) && dot > 0 ? dot : e.name.length,
      submit: async (value) => { renamed = await api('POST', '/api/files/rename', { path: e.path, newName: value }); },
    });
    if (name == null) return;
    closeTransient();
    flash([renamed.path]);
    refresh();
  }

  async function trashPaths(paths) {
    const label = paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} items`;
    const scoped = state.places?.scoped;
    const ok = await ask({ title: scoped ? `Delete ${label}?` : `Move ${label} to the Trash?`, message: scoped ? 'Deletes the selected files from your project copy. The owner’s original files stay unchanged.' : 'It goes to the Trash on the Mac. To get it back, open the Trash in Finder.', okLabel: scoped ? 'Delete' : 'Move to Trash', danger: true });
    if (!ok) return;
    try {
      const { trashed, errors } = await api('POST', '/api/files/trash', { paths });
      if (errors.length) toast(errors[0].error, true);
      else toast(scoped ? `Deleted ${trashed.length} item${trashed.length === 1 ? '' : 's'}` : trashed.length === 1 ? 'Moved to the Trash' : `Moved ${trashed.length} items to the Trash`);
    } catch (err) {
      toast(err.message, true);
    }
    closeTransient();
    refresh();
  }

  async function zipDownload(paths) {
    const params = new URLSearchParams(paths.map((p) => ['path', p]));
    try {
      const check = await api('GET', `/api/files/zip?${params}&check=1`);
      if (!check.complete) throw new Error('Too many files to zip from here. Zip it on the Mac instead.');
      if (check.bytes > check.max) throw new Error(`That is ${formatSize(check.bytes)}; the zip limit is ${formatSize(check.max)}.`);
      if (check.bytes > ZIP_WARN) {
        const go = await ask({ title: `Zip ${formatSize(check.bytes)}?`, message: `${check.files.toLocaleString()} files. The zip streams while the Mac builds it, so it can take a while.`, okLabel: 'Download' });
        if (!go) return;
      }
    } catch (err) {
      return toast(err.message, true);
    }
    const a = h('a');
    a.href = `/api/files/zip?${params}`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    toast('Zip download started');
    closeTransient();
  }

  async function setPinned(path, pinned) {
    try {
      state.places = await api('PUT', '/api/files/pin', { path, pinned });
      toast(pinned ? 'Pinned to quick access' : 'Unpinned');
      renderHead();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function flash(paths) {
    for (const p of paths) state.fresh.add(p);
    setTimeout(() => { for (const p of paths) state.fresh.delete(p); }, 3000);
  }

  // The preview and select mode are the layers an action can finish; closing them also drops their history entries.
  function closeTransient() {
    if (previewEl) overlays.close('files-preview');
    if (state.selecting) overlays.close('files-select');
  }

  let previewEl = null;
  const PREVIEWS = {
    image: (e, body, fail) => {
      const img = h('img');
      img.alt = e.name;
      img.onerror = () => fail('This browser cannot show this image.');
      img.src = fileUrl(e.path, true);
      body.append(img);
    },
    video: (e, body, fail) => {
      const v = h('video');
      Object.assign(v, { controls: true, playsInline: true, preload: 'metadata', src: fileUrl(e.path, true) });
      v.onerror = () => fail('This browser cannot play this video.');
      body.append(v);
    },
    audio: (e, body, fail) => {
      const a = h('audio');
      Object.assign(a, { controls: true, preload: 'metadata', src: fileUrl(e.path, true) });
      a.onerror = () => fail('This browser cannot play this file.');
      body.append(a);
    },
    pdf: (e, body) => {
      const frame = h('iframe');
      frame.title = e.name;
      frame.src = fileUrl(e.path, true);
      // A browser without an inline PDF viewer leaves the frame blank, so the PDF is also offered in a tab.
      const open = h('a', null, 'Open PDF in a new tab');
      Object.assign(open, { href: fileUrl(e.path, true), target: '_blank', rel: 'noopener' });
      const note = h('div', 'fx-pinfo');
      note.append(open);
      body.append(frame, note);
    },
    code: (e, body, fail) => textPreview(e, body, fail),
    text: (e, body, fail) => textPreview(e, body, fail),
    other: (e, body, fail) => (e.size && e.size <= SNIFF_MAX ? textPreview(e, body, fail) : fail(null)),
    archive: (e, body, fail) => fail(null),
  };

  async function textPreview(e, body, fail) {
    if (!e.size) return fail('Empty file.');
    try {
      const res = await fetch(fileUrl(e.path, true), { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.includes(0)) return fail(null);
      const pre = h('pre', null, new TextDecoder().decode(bytes));
      body.append(pre);
      if (e.size > TEXT_PREVIEW_BYTES) body.append(h('div', 'fx-note', `Showing the first ${formatSize(TEXT_PREVIEW_BYTES)} of ${formatSize(e.size)}.`));
    } catch (err) {
      fail(err.message);
    }
  }

  function openPreview(e) {
    closePreview();
    overlays.open('files-preview', closePreview);
    const kind = kindOf(e);
    const sheet = h('div', 'fx-sheet');
    const panel = h('div', 'fx-panel');
    const head = h('div', 'fx-phead');
    const close = iconButton('close', 'Close preview');
    head.append(kindIcon(kind, e.type === 'symlink'), h('div', 'fx-ptitle', e.name), close);
    const body = h('div', 'fx-pbody');
    const info = h('div', 'fx-pinfo', `${formatSize(e.size)} · Modified ${new Date(e.mtime).toLocaleString()}`);
    info.append(h('code', null, e.path));
    const acts = h('div', 'fx-pacts');
    const download = h('a');
    download.innerHTML = svg('download');
    download.append(h('span', null, 'Download'));
    Object.assign(download, { href: fileUrl(e.path, false), download: e.name });
    const rename = labeled('rename', 'Rename');
    const trash = labeled('trash', 'Trash', 'fx-danger');
    rename.hidden = trash.hidden = readOnly();
    const copy = labeled('copy', 'Copy path');
    acts.append(download, rename, trash, copy);
    panel.append(head, body, info, acts);
    sheet.append(panel);
    sheet.onclick = (ev) => { if (ev.target === sheet) overlays.close('files-preview'); };
    close.onclick = () => overlays.close('files-preview');
    rename.onclick = () => renameEntry(e);
    trash.onclick = () => trashPaths([e.path]);
    copy.onclick = () => copyText(e.path).then(() => toast('Path copied'), () => toast('Could not copy', true));
    state.root.append(sheet);
    previewEl = sheet;
    const fail = (message) => {
      body.replaceChildren();
      const box = h('div', 'fx-pmsg');
      box.append(kindIcon(kind, false), h('div', null, message ?? 'No preview for this kind of file.'));
      body.append(box);
    };
    PREVIEWS[kind](e, body, fail);
  }
  function closePreview() {
    if (!previewEl) return;
    previewEl.querySelectorAll('video, audio').forEach((m) => m.pause());
    previewEl.remove();
    previewEl = null;
  }

  // Uploads run one at a time so each gets the phone's full bandwidth and its bar moves steadily.
  function addUploads(files) {
    if (!files.length) return;
    const max = state.places?.uploadMax ?? Infinity;
    for (const file of files) {
      const tooBig = file.size > max;
      state.uploads.push({
        file, dir: state.dir.path, loaded: 0,
        status: tooBig ? 'error' : 'queued',
        error: tooBig ? `Larger than ${formatSize(max)}` : null,
        xhr: null, result: null,
      });
    }
    state.uploadsOpen = true;
    pumpUploads();
    renderUploads();
  }

  function pumpUploads() {
    if (state.uploads.some((u) => u.status === 'uploading')) return;
    const u = state.uploads.find((x) => x.status === 'queued');
    if (!u) return;
    u.status = 'uploading';
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('POST', `/api/files/upload?${qs({ dir: u.dir, name: u.file.name })}`);
    xhr.setRequestHeader('x-pocket-dev', '1');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => { u.loaded = ev.loaded; renderUploads(); };
    const finish = (status, error) => {
      u.status = status;
      u.error = error;
      u.xhr = null;
      renderUploads();
      pumpUploads();
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) return location.replace('/login.html');
      if (xhr.status !== 201) return finish('error', data?.error || `HTTP ${xhr.status}`);
      u.result = data;
      u.loaded = u.file.size;
      flash([data.path]);
      finish('done', null);
      if (state.dir?.path === u.dir && !state.query) load(u.dir, { keepScroll: true });
    };
    xhr.onerror = () => finish('error', 'Network error');
    xhr.onabort = () => finish('canceled', null);
    xhr.send(u.file);
    renderUploads();
  }

  function cancelUpload(u) {
    if (u.status === 'uploading') u.xhr.abort();
    else if (u.status === 'queued') { u.status = 'canceled'; renderUploads(); }
  }

  const UPLOAD_STATUS = {
    queued: () => 'Waiting',
    uploading: (u) => `${formatSize(u.loaded)} of ${formatSize(u.file.size)} · ${Math.floor((100 * u.loaded) / (u.file.size || 1))}%`,
    done: (u) => (u.result.name === u.file.name ? 'Uploaded' : `Uploaded as ${u.result.name}`),
    error: (u) => u.error,
    canceled: () => 'Canceled',
  };

  function renderUploads() {
    const box = state.els?.uploads;
    if (!box) return;
    const ups = state.uploads;
    box.hidden = !ups.length || state.selecting;
    if (box.hidden) return;
    const active = ups.filter((u) => u.status === 'uploading' || u.status === 'queued');
    const done = ups.filter((u) => u.status === 'done').length;
    const head = h('div', 'fx-uphead');
    const title = h('button', 'fx-uptitle', active.length ? `Uploading ${ups.length - active.length + 1} of ${ups.length}` : `${done} of ${ups.length} uploaded`);
    title.type = 'button';
    if (active.length) {
      const total = active.reduce((s, u) => s + u.file.size, 0) || 1;
      const sent = active.reduce((s, u) => s + u.loaded, 0);
      title.append(h('small', null, `${Math.floor((100 * sent) / total)}% of ${formatSize(total)}`));
    }
    const toggle = iconButton(state.uploadsOpen ? 'collapse' : 'expand', state.uploadsOpen ? 'Hide uploads' : 'Show uploads');
    title.onclick = toggle.onclick = () => { state.uploadsOpen = !state.uploadsOpen; renderUploads(); };
    head.append(title, toggle);
    if (!active.length) {
      const clear = iconButton('close', 'Clear finished uploads');
      clear.onclick = () => { state.uploads = []; renderUploads(); };
      head.append(clear);
    }
    const nodes = [head];
    if (state.uploadsOpen) {
      const listEl = h('div', 'fx-uplist');
      listEl.append(...ups.map((u) => {
        const el = h('div', `fx-up fx-${u.status}`);
        const track = h('div', 'fx-bar-track');
        const fill = h('div', 'fx-bar-fill');
        fill.style.width = `${u.status === 'done' ? 100 : Math.floor((100 * u.loaded) / (u.file.size || 1))}%`;
        track.append(fill);
        el.append(h('div', 'fx-upname', u.file.name), track, h('div', 'fx-upstat', UPLOAD_STATUS[u.status](u)));
        if (u.status === 'uploading' || u.status === 'queued') {
          const x = iconButton('close', `Cancel ${u.file.name}`);
          x.onclick = () => cancelUpload(u);
          el.append(x);
        }
        return el;
      }));
      nodes.push(listEl);
    }
    box.replaceChildren(...nodes);
  }

  function onFilesClosed() {
    fileLinkRequest++;
    state.open = false;
    closePreview();
    closeMenu();
    state.root.hidden = true;
    state.root.classList.remove('fx-from-chat');
    state.selecting = false;
    state.selected.clear();
    state.trail = [];
  }

  const closeFiles = () => overlays.close('files');

  window.openFiles = async (path, { overChat = false } = {}) => {
    overlays ??= window.pocketDev?.overlays ?? localOverlays();
    if (!state.root) build();
    if (overChat) state.root.classList.add('fx-from-chat');
    if (state.open) return navigate(path || state.places?.home || '');
    state.open = true;
    state.root.hidden = false;
    overlays.open('files', onFilesClosed);
    try {
      if (!state.places) await loadPlaces();
    } catch (err) {
      toast(err.message, true);
    }
    const start = path || state.dir?.path || state.places?.home || '';
    state.trail = [start];
    await load(start);
  };

  let fileLinkRequest = 0;
  window.openFile = async (path) => {
    const request = ++fileLinkRequest;
    await window.openFiles(parentOf(path), { overChat: true });
    if (request !== fileLinkRequest || !state.open) return;
    const loadSeq = state.loadSeq;
    try {
      // HEAD also handles hidden files or entries beyond the list limit. The
      // server validates this path before returning any metadata or contents.
      const res = await fetch(fileUrl(path, true), { method: 'HEAD' });
      if (request !== fileLinkRequest || !state.open || loadSeq !== state.loadSeq) return;
      if (res.status === 401) return location.replace('/login.html');
      if (res.status === 400) return navigate(path); // Folder links open Files.
      if (!res.ok) throw new Error(res.status === 403 ? 'This file is outside your allowed folders.' : res.status === 404 ? 'This file no longer exists.' : `Could not open file (HTTP ${res.status}).`);
      const entry = {
        name: baseName(path), path, type: 'file',
        size: Number(res.headers.get('content-length')) || 0,
        mime: res.headers.get('content-type')?.split(';')[0] || '',
        mtime: Date.parse(res.headers.get('last-modified')) || Date.now(),
      };
      openPreview(entry);
    } catch (err) {
      if (request === fileLinkRequest && state.open) toast(err.message, true);
    }
  };
})();
