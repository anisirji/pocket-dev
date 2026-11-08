(() => {
  let nextId = 0;
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

  function create({ api, onSelect, onCancel = () => {}, onClose = () => {}, selectLabel = 'Select this folder', title = 'Choose a folder on your Mac' }) {
    const element = node('section', 'fp-browser');
    element.hidden = true;
    element.setAttribute('aria-label', title);
    const heading = node('strong', 'fp-heading', title);
    heading.tabIndex = -1;
    const locations = node('div', 'fp-locations');
    locations.setAttribute('aria-label', 'Locations');
    const toolbar = node('div', 'fp-toolbar');
    const back = button('Back', () => { if (history.length) navigate(history.pop(), false); });
    const up = button('Up', () => { if (current?.parent) navigate(current.parent); });
    const hiddenLabel = node('label', 'fp-hidden');
    const hidden = node('input'); hidden.type = 'checkbox';
    hiddenLabel.append(hidden, node('span', '', 'Hidden folders'));
    toolbar.append(back, up, hiddenLabel);
    const crumbs = node('nav', 'fp-crumbs'); crumbs.setAttribute('aria-label', 'Folder location');
    const search = node('input', 'fp-search');
    search.type = 'search'; search.placeholder = 'Find a folder here'; search.setAttribute('aria-label', 'Find a folder here');
    const status = node('p', 'fp-status'); status.setAttribute('role', 'status');
    const list = node('div', 'fp-list'); list.setAttribute('aria-label', 'Folders');
    const footer = node('div', 'fp-footer');
    const selected = node('span', 'fp-selected');
    const choose = button(selectLabel, async () => {
      if (!current || choose.disabled) return;
      choose.disabled = true;
      try { if (await onSelect(current.path) !== false) close(); }
      catch (err) { status.textContent = err.message; }
      finally { choose.disabled = !current; }
    }, 'fp-primary');
    const cancel = button('Cancel', () => { close(); onCancel(); });
    footer.append(selected, cancel, choose);
    element.append(heading, locations, toolbar, crumbs, search, status, list, footer);
    let current = null, sequence = 0, history = [], timer, opener = null, browsingPath = '';
    const sync = () => {
      back.disabled = !history.length;
      up.disabled = !current?.parent;
      choose.disabled = !current;
    };
    async function load(path, { remember = false, query = '' } = {}) {
      browsingPath = path || '';
      const request = ++sequence;
      const previous = current;
      current = null; sync();
      element.setAttribute('aria-busy', 'true');
      status.textContent = 'Loading folders…';
      list.replaceChildren();
      try {
        const params = new URLSearchParams({ ...(path && { path }), ...(hidden.checked && { hidden: '1' }), ...(query && { q: query }) });
        const data = await api('GET', `/api/folders/browse?${params}`);
        if (request !== sequence || element.hidden) return;
        if (remember && previous && previous.path !== data.path) history.push(previous.path);
        current = data;
        selected.textContent = data.path;
        selected.title = data.path;
        crumbs.replaceChildren(...data.breadcrumbs.map((entry) => {
          const crumb = button(entry.name, () => navigate(entry.path));
          if (entry.path === data.path) crumb.setAttribute('aria-current', 'location');
          return crumb;
        }));
        locations.replaceChildren(...data.shortcuts.map((entry) => button(entry.name, () => navigate(entry.path))));
        list.replaceChildren(...data.entries.map((entry) => {
          const row = button('', () => navigate(entry.path), 'fp-row');
          row.append(node('span', 'fp-folder-icon', '▱'), node('span', 'fp-folder-name', entry.name), node('span', 'fp-chevron', '›'));
          row.children[0].setAttribute('aria-hidden', 'true'); row.children[2].setAttribute('aria-hidden', 'true');
          row.setAttribute('aria-label', `Open folder ${entry.name}`);
          return row;
        }));
        status.textContent = data.truncated ? 'Showing the first 2,000 folders. Search to narrow the list.'
          : data.entries.length ? `${data.entries.length} folder${data.entries.length === 1 ? '' : 's'}`
            : query ? 'No matching folders. Try another name.' : 'No subfolders. You can select this folder.';
        list.scrollTop = 0;
      } catch (err) {
        if (request !== sequence || element.hidden) return;
        status.textContent = err.message;
        if (remember && previous) history.push(previous.path);
        // Keep navigation shortcuts after an inaccessible or deleted folder; selection remains disabled.
        const retry = button('Try again', () => load(path, { query }));
        const home = button('Go to Home', () => navigate(''));
        list.replaceChildren(retry, home);
      } finally {
        if (request === sequence) { element.setAttribute('aria-busy', 'false'); sync(); }
      }
    }
    function navigate(path, remember = true) {
      clearTimeout(timer); search.value = '';
      return load(path, { remember });
    }
    hidden.onchange = () => { clearTimeout(timer); load(browsingPath, { query: search.value.trim() }); };
    search.oninput = () => {
      clearTimeout(timer);
      const path = browsingPath;
      ++sequence; current = null; sync();
      timer = setTimeout(() => load(path, { query: search.value.trim() }), 180);
    };
    element.onkeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); onCancel(); }
      if (event.key === 'Enter' && event.target === search) { event.preventDefault(); clearTimeout(timer); load(browsingPath, { query: search.value.trim() }); }
    };
    function close() {
      ++sequence; clearTimeout(timer); element.hidden = true; current = null;
      element.setAttribute('aria-busy', 'false'); onClose();
      opener?.focus();
    }
    return { element, close, open(path, from) {
      opener = from ?? document.activeElement; history = []; search.value = ''; current = null;
      element.hidden = false;
      const result = navigate(path || '');
      heading.focus();
      return result;
    } };
  }

  function field(input, { api, label = 'Folder', onSelect = () => {} } = {}) {
    const element = node('div', 'fp-field');
    input.id ||= `fp-path-${++nextId}`;
    input.setAttribute('aria-label', label);
    input.placeholder = 'Choose a folder';
    const caption = node('label', 'fp-label', label); caption.setAttribute('for', input.id);
    const controls = node('div', 'fp-controls');
    let browse;
    const browser = create({ api, title: `Choose ${label.toLowerCase()} on your Mac`, onClose: () => browse?.setAttribute('aria-expanded', 'false'), onSelect: (path) => {
      input.value = path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return onSelect(path);
    } });
    browser.element.id = `fp-browser-${++nextId}`;
    browse = button('Browse folders', () => {
      if (!browser.element.hidden) { browser.close(); browse.setAttribute('aria-expanded', 'false'); return; }
      browse.setAttribute('aria-expanded', 'true');
      return browser.open(input.value, browse);
    });
    browse.setAttribute('aria-expanded', 'false');
    browse.setAttribute('aria-controls', browser.element.id);
    controls.append(input, browse);
    element.append(caption, controls, browser.element);
    return element;
  }
  window.PocketDevFolderPicker = { create, field };
})();
