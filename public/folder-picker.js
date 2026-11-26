(() => {
  let nextId = 0;
  const SORT_KEY = 'pocketdev.folderSort', RECENT_KEY = 'pd.folderRecents';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const basename = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  const recentFolders = () => {
    const value = read(RECENT_KEY, []);
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.path === 'string' && typeof entry.name === 'string').slice(0, 10) : [];
  };
  const remember = (path, home) => {
    if (path === home) return;
    save(RECENT_KEY, [{ path, name: basename(path) }, ...recentFolders().filter((entry) => entry.path !== path)].slice(0, 10));
  };
  const node = (tag, cls, text) => {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (text, run, cls = '') => {
    const element = node('button', `fp-button ${cls}`, text);
    element.type = 'button'; element.onclick = run;
    return element;
  };
  function create({ api, onSelect, onCancel = () => {}, onClose = () => {}, selectLabel = 'Select folder', title = 'Select folder', overlays: overlaySource = () => window.pocketDev?.overlays }) {
    const element = node('dialog', 'fp-browser');
    element.hidden = true;
    element.setAttribute('aria-label', title);
    const heading = node('h2', 'fp-heading', title); heading.tabIndex = -1;
    const header = node('header', 'fp-head'), computer = node('span', 'fp-computer'); header.append(heading, computer);
    const toolbar = node('div', 'fp-toolbar');
    let current = null, metadata = null, browsingPath = '', sequence = 0, history = [], timer, opener, selecting = false, landing = false, recents = [], home = '', overlayManager, ownHistory = false;
    const overlayName = `folder-picker-${++nextId}`;
    const back = button('←', () => {
      const previous = history.pop();
      if (previous) { clearTimeout(timer); search.value = ''; toggleMenu(false); load(previous.path, { landing: previous.landing }); }
    }, 'fp-nav'); back.setAttribute('aria-label', 'Back');
    const up = button('↑', () => { if (current?.parent) navigate(current.parent); }, 'fp-nav'); up.setAttribute('aria-label', 'Up');
    const location = node('select', 'fp-location'); location.setAttribute('aria-label', 'Location');
    const options = button('⋯', () => toggleMenu(), 'fp-options'); options.setAttribute('aria-label', 'Folder options'); options.setAttribute('aria-expanded', 'false');
    toolbar.append(back, up, location, options);
    const crumbs = node('nav', 'fp-crumbs'); crumbs.setAttribute('aria-label', 'Folder location');
    const search = node('input', 'fp-search'); search.type = 'search'; search.placeholder = 'Search folders…'; search.setAttribute('aria-label', 'Search folders');
    search.autocomplete = 'off'; search.autocapitalize = 'off'; search.spellcheck = false;
    const searchWrap = node('div', 'fp-search-wrap'); searchWrap.append(search);
    const status = node('p', 'fp-status'); status.setAttribute('role', 'status');
    const list = node('div', 'fp-list'); list.setAttribute('aria-label', 'Folders');
    const footer = node('footer', 'fp-footer');
    const choose = button(selectLabel, () => landing ? showBrowse() : selectCurrent(), 'fp-primary');
    const cancel = button('Cancel', () => cancelPicker()); footer.append(cancel, choose);
    const menu = node('div', 'fp-menu'); menu.hidden = true; menu.id = `${overlayName}-options`; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'Folder options'); options.setAttribute('aria-controls', menu.id);
    const sortLabel = node('label', 'fp-option-label', 'Sort by');
    const sort = node('select', 'fp-sort'); sort.setAttribute('aria-label', 'Sort folders by');
    for (const [value, text] of [['name:asc', 'Name, A to Z'], ['name:desc', 'Name, Z to A'], ['modified:desc', 'Modified, newest first'], ['modified:asc', 'Modified, oldest first'], ['created:desc', 'Created, newest first'], ['created:asc', 'Created, oldest first']]) {
      const option = node('option', '', text); option.value = value; sort.append(option);
    }
    const savedSort = read(SORT_KEY, {});
    sort.value = `${['name', 'modified', 'created'].includes(savedSort?.sort) ? savedSort.sort : 'name'}:${savedSort?.order === 'desc' ? 'desc' : 'asc'}`;
    sortLabel.append(sort);
    const hiddenLabel = node('label', 'fp-hidden');
    const hidden = node('input'); hidden.type = 'checkbox'; hiddenLabel.append(hidden, node('span', '', 'Show hidden folders'));
    const newFolder = button('New folder', () => openNew('folder'), 'fp-menu-item');
    const newFile = button('New file', () => openNew('file'), 'fp-menu-item');
    const copy = button('Copy path', () => copyPath(), 'fp-menu-item');
    const go = button('Go to path', () => { toggleMenu(false); newForm.hidden = true; pathForm.hidden = false; searchWrap.hidden = true; crumbs.hidden = true; pathInput.value = current?.path || browsingPath; pathInput.focus(); pathInput.select?.(); }, 'fp-menu-item');
    const refresh = button('Refresh', () => { toggleMenu(false); reload(); }, 'fp-menu-item');
    menu.append(newFolder, newFile, sortLabel, hiddenLabel, copy, go, refresh);
    const newForm = node('form', 'fp-newform'); newForm.hidden = true;
    const newLabel = node('label', 'fp-inline-label', 'New folder name');
    const newName = node('input', 'fp-newname'); newName.setAttribute('aria-label', 'New item name'); newName.autocomplete = 'off'; newName.autocapitalize = 'off'; newName.spellcheck = false;
    newLabel.append(newName);
    const make = button('Create', () => submitNew(), 'fp-primary');
    const dismissNew = button('Cancel', () => { newForm.hidden = true; search.focus(); });
    newForm.append(newLabel, dismissNew, make);
    let newKind = 'folder';
    newForm.onsubmit = (event) => { event.preventDefault(); submitNew(); };
    const pathForm = node('form', 'fp-pathform'); pathForm.hidden = true;
    const pathInput = node('input'); pathInput.setAttribute('aria-label', 'Go to path'); pathInput.placeholder = 'Folder path, e.g. ~/Projects'; pathInput.autocomplete = 'off'; pathInput.autocapitalize = 'off'; pathInput.spellcheck = false;
    const pathGo = button('Go', () => submitPath(), 'fp-primary'); pathForm.append(pathInput, pathGo);
    pathForm.onsubmit = (event) => { event.preventDefault(); submitPath(); };
    element.append(header, toolbar, crumbs, searchWrap, newForm, pathForm, status, list, footer, menu);
    function toggleMenu(show = menu.hidden) {
      menu.hidden = !show; options.setAttribute('aria-expanded', String(show));
      if (show) menu.querySelector?.('button:not(:disabled), select, input')?.focus();
    }
    function sync() {
      back.disabled = !history.length || selecting;
      up.disabled = !current?.parent || landing || selecting;
      location.disabled = !current || selecting;
      choose.disabled = !current || selecting;
      choose.textContent = landing ? 'Browse all folders' : selectLabel;
      copy.disabled = newFolder.disabled = newFile.disabled = !current || landing || selecting;
    }
    const shortPath = (path) => home && (path === home || path.startsWith(home + '/') || path.startsWith(home + '\\')) ? '~' + path.slice(home.length) : path;
    function row(entry, run, recent = false) {
      const result = button('', run, 'fp-row');
      const icon = node('span', 'fp-folder-icon'); icon.setAttribute('aria-hidden', 'true');
      const text = node('span', 'fp-folder-text'); text.append(node('span', 'fp-folder-name', entry.name));
      if (recent) text.append(node('small', 'fp-recent-path', shortPath(entry.path)));
      const chevron = node('span', 'fp-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
      result.append(icon, text, chevron); result.setAttribute('aria-label', `${recent ? 'Open recent project' : 'Open folder'} ${entry.name}`);
      return result;
    }
    function renderLanding() {
      crumbs.hidden = true;
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const shown = recents.filter((entry) => `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(query));
      list.append(node('h3', 'fp-section-label', 'Recent projects'));
      if (!shown.length) list.append(node('p', 'fp-empty', query ? 'No matching recent projects.' : 'Your selected projects will appear here.'));
      for (const entry of shown) list.append(row(entry, async () => { if (await load(entry.path, { remember: true })) await selectCurrent(); }, true));
      const places = (metadata?.shortcuts || []).filter((entry) => ['Home', 'Desktop', 'Documents', 'Downloads'].includes(entry.name) && entry.name.toLocaleLowerCase().includes(query));
      if (places.length) list.append(node('h3', 'fp-section-label', 'Locations'), ...places.map((entry) => row(entry, () => navigate(entry.path))));
      status.textContent = ''; sync();
    }
    function renderLocations(data) {
      const entries = [...(recents.length ? [{ name: 'Recent projects', path: '@recent' }] : []), ...data.shortcuts];
      if (!entries.some((entry) => entry.path === data.path)) entries.unshift({ name: basename(data.path), path: data.path });
      location.replaceChildren(...entries.map((entry) => { const option = node('option', '', entry.name); option.value = entry.path; return option; }));
      location.value = landing ? '@recent' : data.path;
    }
    async function load(path, { remember: push = false, query = '', landing: showLanding = false } = {}) {
      const previous = current && { path: current.path, landing };
      const request = ++sequence; browsingPath = path || ''; current = null; sync();
      element.setAttribute('aria-busy', 'true'); status.textContent = 'Loading folders…'; list.replaceChildren();
      try {
        const [sortKey, order] = sort.value.split(':');
        const params = new URLSearchParams({ ...(path && { path }), ...(hidden.checked && { hidden: '1' }), ...(query && { q: query }), sort: sortKey, order });
        const data = await api('GET', `/api/folders/browse?${params}`);
        if (request !== sequence || element.hidden) return false;
        if (push && previous && (previous.path !== data.path || previous.landing !== showLanding)) history.push(previous);
        current = metadata = data; browsingPath = data.path;
        home = data.shortcuts.find((entry) => entry.name === 'Home')?.path || home;
        const seen = new Set(); recents = [...recentFolders(), ...(data.recent || [])].filter((entry) => entry && typeof entry.path === 'string' && typeof entry.name === 'string' && entry.path !== home && !seen.has(entry.path) && seen.add(entry.path)).slice(0, 10);
        landing = showLanding && recents.length > 0;
        renderLocations(data);
        crumbs.hidden = landing || !pathForm.hidden;
        const homeAt = data.breadcrumbs.findIndex((entry) => entry.path === home);
        const trail = homeAt < 0 ? data.breadcrumbs : data.breadcrumbs.slice(homeAt).map((entry, i) => i ? entry : { ...entry, name: '~' });
        const visibleTrail = trail.length > 4 ? [trail[0], null, ...trail.slice(-2)] : trail;
        crumbs.replaceChildren(...visibleTrail.map((entry) => {
          if (!entry) {
            const ancestors = node('select', 'fp-ancestors'); ancestors.setAttribute('aria-label', 'Go to ancestor folder');
            const placeholder = node('option', '', '…'); placeholder.value = ''; ancestors.append(placeholder);
            for (const ancestor of trail.slice(1, -2)) { const option = node('option', '', ancestor.name); option.value = ancestor.path; ancestors.append(option); }
            ancestors.onchange = () => { if (ancestors.value) navigate(ancestors.value); }; return ancestors;
          }
          const crumb = button(entry.name, () => navigate(entry.path)); crumb.title = entry.path;
          if (entry.path === data.path) crumb.setAttribute('aria-current', 'location');
          return crumb;
        }));
        if (landing) renderLanding();
        else {
          list.replaceChildren(...data.entries.map((entry) => row(entry, () => navigate(entry.path))));
          status.textContent = data.truncated ? 'Showing 2,000 folders. Search to narrow the list.' : !data.entries.length ? query ? 'No matching folders. Try another name.' : 'No subfolders. You can select this folder.' : '';
        }
        list.scrollTop = 0; return true;
      } catch (err) {
        if (request !== sequence || element.hidden) return false;
        if (push && previous) history.push(previous);
        landing = false; status.textContent = err.message;
        list.replaceChildren(button('Try again', () => load(path, { query })), button('Go to Home', () => navigate('')));
        if (recents.some((entry) => entry.path === path)) list.append(button('Remove from recent projects', () => {
          save(RECENT_KEY, recentFolders().filter((entry) => entry.path !== path)); return load(home, { landing: true });
        }));
        return false;
      } finally { if (request === sequence) { element.setAttribute('aria-busy', 'false'); sync(); } }
    }
    async function navigate(path, push = true) {
      const focusList = list.contains?.(document.activeElement);
      clearTimeout(timer); search.value = ''; toggleMenu(false);
      const loaded = await load(path, { remember: push });
      if (loaded && focusList) (list.querySelector?.('.fp-row') || choose).focus();
      return loaded;
    }
    function showBrowse() { search.value = ''; return load(home || browsingPath, { remember: true }); }
    function reload() { clearTimeout(timer); return load(browsingPath, { query: search.value.trim(), landing }); }
    async function selectCurrent() {
      if (!current || selecting) return;
      const selected = current.path; selecting = true; sync();
      try {
        if (await onSelect(selected) !== false) { remember(selected, home); close(); }
        else if (!status.textContent) status.textContent = 'This folder could not be opened. Try again.';
      } catch (err) { status.textContent = err.message; }
      finally { selecting = false; sync(); }
    }
    function openNew(kind) { if (!current) return; newKind = kind; toggleMenu(false); pathForm.hidden = true; searchWrap.hidden = false; crumbs.hidden = false; newForm.hidden = false; newLabel.textContent = `New ${kind} name`; newLabel.append(newName); newName.focus(); }
    async function submitNew() {
      const name = newName.value.trim(); if (!current || make.disabled) return;
      if (!name) { status.textContent = 'Enter a name.'; newName.focus(); return; }
      const parent = current.path; make.disabled = true;
      try {
        const made = await api('POST', '/api/folders/create', { parent, name, kind: newKind });
        if (element.hidden) return;
        newName.value = ''; newForm.hidden = true;
        if (newKind === 'folder') await navigate(made.path);
        else { await load(parent); status.textContent = `Created file ${made.name}`; }
      } catch (err) { status.textContent = err.message; newName.focus(); }
      finally { make.disabled = false; }
    }
    async function submitPath() {
      const path = pathInput.value.trim(); if (!path) return;
      if (await navigate(path)) { pathForm.hidden = true; searchWrap.hidden = false; crumbs.hidden = false; search.focus(); }
    }
    async function copyPath() {
      if (!current) return; const path = current.path; toggleMenu(false);
      try {
        let copied = false;
        try { if (window.navigator?.clipboard) { await window.navigator.clipboard.writeText(path); copied = true; } } catch {}
        if (!copied) {
          const text = node('textarea'); text.value = path; text.style.position = 'fixed'; text.style.opacity = '0'; element.append(text); text.select();
          try { if (!document.execCommand('copy')) throw new Error('Copy failed'); } finally { text.remove(); }
        }
        status.textContent = 'Path copied.';
      } catch { status.textContent = 'Could not copy the path. Use Go to path to select and copy it.'; }
      options.focus();
    }
    location.onchange = () => location.value === '@recent' ? load(home, { remember: true, landing: true }) : navigate(location.value);
    sort.onchange = () => { const [key, order] = sort.value.split(':'); save(SORT_KEY, { sort: key, order }); reload(); };
    hidden.onchange = reload;
    search.oninput = () => {
      clearTimeout(timer);
      if (landing) return renderLanding();
      ++sequence; current = null; sync();
      timer = setTimeout(() => load(browsingPath, { query: search.value.trim() }), 180);
    };
    element.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault(); dismiss();
      } else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); clearTimeout(timer); if (!landing) load(browsingPath, { query: search.value.trim() }); }
      else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); back.onclick(); }
      else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); up.onclick(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target.closest?.('.fp-row')) {
        const rows = [...list.querySelectorAll('.fp-row')], at = rows.indexOf(event.target.closest('.fp-row'));
        event.preventDefault(); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
    };
    function dismiss() {
      if (!menu.hidden) { toggleMenu(false); options.focus(); }
      else if (!newForm.hidden || !pathForm.hidden) { newForm.hidden = pathForm.hidden = true; searchWrap.hidden = false; crumbs.hidden = landing; search.focus(); }
      else cancelPicker();
    }
    element.oncancel = (event) => { event.preventDefault(); dismiss(); };
    element.addEventListener?.('click', (event) => { if (!menu.hidden && !menu.contains(event.target) && !options.contains(event.target)) toggleMenu(false); });
    function hide() {
      if (element.hidden) return;
      ++sequence; clearTimeout(timer); current = null;
      toggleMenu(false); element.hidden = true; element.setAttribute('aria-busy', 'false');
      if (element.open) element.close();
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
      window.removeEventListener?.('resize', fit);
      if (ownHistory) { window.removeEventListener('popstate', onPop); ownHistory = false; }
      onClose(); opener?.focus();
    }
    function onPop() { hide(); }
    function fit() {
      if (!window.visualViewport) return;
      element.style.setProperty('--fp-viewport-height', `${window.visualViewport.height}px`);
      element.style.setProperty('--fp-viewport-top', `${window.visualViewport.offsetTop}px`);
      element.classList.toggle('fp-short', window.visualViewport.height < 500);
    }
    function close() {
      if (element.hidden) return;
      if (overlayManager) overlayManager.close(overlayName);
      else { const back = ownHistory && window.history.state?.fpPicker === overlayName; hide(); if (back) window.history.back(); }
    }
    function cancelPicker() { close(); onCancel(); }
    return { element, close, open(path, from) {
      const wasOpen = !element.hidden;
      computer.textContent = window.PocketMachine?.say?.('This Mac') || '';
      computer.title = computer.textContent; computer.hidden = !computer.textContent;
      opener = from ?? document.activeElement; history = []; search.value = ''; current = null; selecting = false;
      newForm.hidden = pathForm.hidden = true; searchWrap.hidden = false; newName.value = '';
      element.hidden = false;
      if (!wasOpen) {
        fit();
        window.visualViewport?.addEventListener('resize', fit);
        window.visualViewport?.addEventListener('scroll', fit);
        window.addEventListener?.('resize', fit);
        element.showModal?.();
        overlayManager = typeof overlaySource === 'function' ? overlaySource() : overlaySource;
        if (overlayManager) overlayManager.open(overlayName, hide);
        else if (window.history?.pushState) { window.history.pushState({ ...window.history.state, fpPicker: overlayName }, ''); ownHistory = true; window.addEventListener('popstate', onPop); }
      }
      const result = load(path || '', { landing: !path }); heading.focus(); return result;
    } };
  }
  function field(input, { api, label = 'Folder', onSelect = () => {} } = {}) {
    const element = node('div', 'fp-field');
    input.id ||= `fp-path-${++nextId}`; input.setAttribute('aria-label', label); input.placeholder = 'Choose a folder';
    const caption = node('label', 'fp-label', label); caption.setAttribute('for', input.id);
    const controls = node('div', 'fp-controls'); let browse;
    const browser = create({ api, title: label === 'Repository' ? 'Select repository' : 'Select folder', selectLabel: label === 'Repository' ? 'Select repository' : 'Select folder',
      onClose: () => browse?.setAttribute('aria-expanded', 'false'), onSelect: async (path) => {
        input.value = path; input.dispatchEvent(new Event('input', { bubbles: true })); return onSelect(path);
      } });
    browser.element.id = `fp-browser-${++nextId}`;
    browse = button('Browse folders', () => { if (!browser.element.hidden) return browser.close(); browse.setAttribute('aria-expanded', 'true'); return browser.open(input.value, browse); });
    browse.setAttribute('aria-expanded', 'false'); browse.setAttribute('aria-controls', browser.element.id);
    controls.append(input, browse); element.append(caption, controls, browser.element); return element;
  }
  window.PocketDevFolderPicker = { create, field };
})();
