(() => {
  const REFRESH_MS = 10_000;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const { api } = window;
  const { overlays } = window.pocketDev;

  const formatMem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
  const usageLine = (app) => `${formatMem(app.memMB)} · ${app.cpu}% CPU`;
  const PROTECTED_TEXT = {
    system: (app) => `${app.name} is part of macOS, so Pocket Dev won't quit it.`,
    'hosts-pocket-dev': (app) => `Pocket Dev runs inside ${app.name}, so quitting it would cut off this page.`,
  };

  function icon(app, big) {
    const node = el('span', `apps-icon${big ? ' big' : ''}`, (app.name.trim()[0] || '?').toUpperCase());
    let hash = 0;
    for (const ch of app.bundleId || app.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    node.style.background = `hsl(${hash % 360} 45% 36%)`;
    return node;
  }

  function lock() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'apps-lock');
    svg.setAttribute('aria-label', 'Protected');
    svg.innerHTML = '<rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/>';
    return svg;
  }

  // view is 'closed' | 'list' | 'detail'; every other field describes the open view.
  const state = { view: 'closed', apps: [], listError: null, notice: null, app: null, windows: null, busy: null, timer: 0 };
  let ui = null;

  function buildSheet() {
    const root = el('div', 'apps-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Open apps');
    const bar = el('div', 'apps-bar');
    const back = el('button', 'apps-btn', '‹ Back');
    const title = el('h2', null, 'Open apps');
    const refresh = el('button', 'apps-btn', 'Refresh');
    const close = el('button', 'apps-btn', 'Close');
    back.onclick = () => overlays.close('apps-detail');
    refresh.onclick = () => (state.view === 'detail' ? loadWindows() : loadList());
    close.onclick = () => overlays.close('apps');
    bar.append(back, title, refresh, close);
    const scroll = el('div', 'apps-scroll');
    const actions = el('div', 'apps-actions');
    root.append(bar, scroll, actions);
    document.body.appendChild(root);
    return { root, back, title, scroll, actions };
  }

  function render() {
    if (state.view === 'closed') {
      ui?.root.remove();
      ui = null;
      return;
    }
    ui ??= buildSheet();
    ui.back.hidden = state.view !== 'detail';
    ui.title.textContent = state.view === 'detail' ? state.app.name : 'Open apps';
    if (state.view === 'list') renderList();
    else renderDetail();
  }

  function banner(notice) {
    return el('div', `apps-banner ${notice.kind}`, notice.text);
  }

  function renderList() {
    const items = [];
    if (state.notice) items.push(banner(state.notice));
    if (state.listError) items.push(banner({ kind: 'error', text: state.listError }));
    if (!state.apps.length && !state.listError) items.push(el('p', 'apps-note', 'Loading…'));
    for (const app of state.apps) {
      const card = el('button', `apps-card${app.protected ? ' locked' : ''}`);
      const text = el('span', 'apps-text');
      text.append(el('div', 'apps-name', app.name), el('div', 'apps-meta', usageLine(app)));
      card.append(icon(app), text);
      if (app.frontmost) card.append(el('span', 'apps-badge', 'front'));
      if (app.hidden) card.append(el('span', 'apps-badge muted', 'hidden'));
      if (app.protected) card.append(lock());
      card.onclick = () => openDetail(app);
      items.push(card);
    }
    ui.scroll.replaceChildren(...items);
    ui.actions.hidden = true;
  }

  function renderDetail() {
    const { app } = state;
    const live = state.apps.find((a) => a.pid === app.pid);
    const head = el('div', 'apps-head');
    const text = el('div', 'apps-text');
    text.append(el('div', 'apps-name', app.name), el('div', 'apps-meta', usageLine(live ?? app)), el('div', 'apps-id', `${app.bundleId ?? 'no bundle id'} · pid ${app.pid}`));
    head.append(icon(app, true), text);
    const items = [head];
    if (state.notice) items.push(banner(state.notice));
    if (!live && !state.busy && !state.listError) items.push(banner({ kind: 'warn', text: `${app.name} is no longer running.` }));
    if (app.protected) items.push(el('p', 'apps-note', PROTECTED_TEXT[app.protectedReason](app)));

    items.push(el('div', 'apps-section', 'Windows'));
    const { windows } = state;
    if (!windows) items.push(el('p', 'apps-note', 'Loading…'));
    else if (windows.error) items.push(banner({ kind: 'error', text: windows.error }));
    else if (windows.windowAccess !== 'ok') items.push(banner({ kind: 'warn', text: windows.help }));
    else if (!windows.windows.length) items.push(el('p', 'apps-note', 'No windows found. Windows on another Space may not be listed.'));
    else {
      const list = el('div', 'apps-windows');
      for (const w of windows.windows) {
        const row = el('div', 'apps-window');
        row.append(el('div', 'apps-window-title', w.title || 'Untitled window'));
        if (w.document) row.append(el('div', 'apps-window-doc', w.document));
        list.append(row);
      }
      items.push(list);
    }
    ui.scroll.replaceChildren(...items);

    ui.actions.hidden = app.protected || !live;
    const quit = el('button', 'apps-quit', state.busy === 'quit' ? 'Quitting…' : 'Quit');
    const force = el('button', 'apps-force', state.busy === 'force-quit' ? 'Force quitting…' : 'Force quit');
    quit.disabled = force.disabled = Boolean(state.busy);
    quit.onclick = () => act('quit');
    force.onclick = () => {
      if (confirm(`Force quit ${app.name}? Unsaved work in ${app.name} is lost.`)) act('force-quit');
    };
    ui.actions.replaceChildren(quit, force);
  }

  async function loadList() {
    try {
      const { apps } = await api('GET', '/api/apps');
      state.apps = apps;
      state.listError = null;
    } catch (err) {
      state.listError = `Could not list apps: ${err.message}`;
    }
    if (state.view !== 'closed') render();
  }

  async function loadWindows() {
    const { pid } = state.app;
    let windows;
    try {
      windows = await api('GET', `/api/apps/${pid}/windows`);
    } catch (err) {
      windows = { error: err.message };
    }
    if (state.view !== 'detail' || state.app.pid !== pid) return;
    state.windows = windows;
    render();
    loadList();
  }

  const OUTCOMES = {
    quit: {
      quit: (name) => ({ kind: 'ok', text: `${name} quit` }),
      'still-running': (name) => ({ kind: 'warn', text: `${name} didn't quit, it probably has unsaved changes. Use Force quit to close it anyway.` }),
    },
    'force-quit': {
      quit: (name) => ({ kind: 'ok', text: `${name} was force quit` }),
      'still-running': (name) => ({ kind: 'error', text: `${name} is still running after a force quit.` }),
    },
  };

  async function act(action) {
    const { app } = state;
    state.busy = action;
    state.notice = null;
    render();
    let notice;
    try {
      const { result } = await api('POST', `/api/apps/${app.pid}/${action}`);
      notice = OUTCOMES[action][result](app.name);
    } catch (err) {
      notice = { kind: 'error', text: err.message };
    }
    state.busy = null;
    if (state.view === 'closed') return;
    state.notice = notice;
    if (notice.kind === 'ok') state.apps = state.apps.filter((a) => a.pid !== app.pid);
    if (notice.kind === 'ok' && state.view === 'detail' && state.app.pid === app.pid) overlays.close('apps-detail');
    else render();
    loadList();
  }

  function show(view, app) {
    state.view = view;
    if (view === 'detail') Object.assign(state, { app, windows: null });
    render();
    if (view === 'detail') loadWindows();
  }

  // The list and the detail are two levels of the shared overlay stack, so back leaves the detail first.
  function openDetail(app) {
    state.notice = null;
    overlays.open('apps-detail', () => {
      if (state.notice?.kind !== 'ok') state.notice = null;
      show('list');
    });
    show('detail', app);
  }

  function closeSheet() {
    clearInterval(state.timer);
    Object.assign(state, { view: 'closed', apps: [], listError: null, notice: null, app: null, windows: null, busy: null });
    render();
  }

  window.openAppsSheet = () => {
    if (state.view !== 'closed') return;
    document.activeElement?.blur();
    overlays.open('apps', closeSheet);
    show('list');
    loadList();
    state.timer = setInterval(() => {
      if (!document.hidden && !state.busy) loadList();
    }, REFRESH_MS);
  };
})();
