(() => {
  const REFRESH_MS = 10_000;
  const MIN_DEVICES = 1;
  const MAX_DEVICES = 20;
  const LOGOUT_SELF = 'Log out this device? You will need the password or a QR code to log back in.';

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const { api } = window;
  const { overlays, power, powerOptions } = window.pocketDev;

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const sheet = el('div', 'st-sheet');
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Settings');
  sheet.innerHTML = `
    <header class="st-head">
      <h2>Settings</h2>
      <span class="st-batt"></span>
      <button class="st-close" aria-label="Close settings">✕</button>
    </header>
    <div class="st-body">
      <section>
        <button class="st-link" data-act="room"><span>Connected computers</span><span class="st-apps-count st-room-sum"></span><span class="st-chev" aria-hidden="true">›</span></button>
        <p class="st-err" data-for="room"></p>
      </section>
      <section data-mount="connection" hidden></section>
      <section data-mount="service"></section>
      <section data-mount="collaborators"></section>
      <section data-mount="tools"></section>
      <section>
        <h3>Devices</h3>
        <p class="st-summary"></p>
        <div class="st-waiting"></div>
        <ul class="st-devices"></ul>
        <div class="st-approve"></div>
        <p class="st-err" data-for="devices"></p>
      </section>
      <section>
        <h3>Power</h3>
        <div class="st-power"></div>
      </section>
      <section>
        <button class="st-link" data-act="apps"><span>Open apps</span><span class="st-apps-count"></span><span class="st-chev" aria-hidden="true">›</span></button>
        <p class="st-err" data-for="apps"></p>
      </section>
      <section>
        <button class="st-link" data-act="health"><span>Device health</span><span class="st-chev" aria-hidden="true">›</span></button>
      </section>
      <section>
        <button class="st-link" data-act="screen"><span>Device screen</span><span class="st-chev" aria-hidden="true">›</span></button>
      </section>
      <section>
        <button class="st-link" data-act="camera"><span>Device camera</span><span class="st-chev" aria-hidden="true">›</span></button>
      </section>
      <section>
        <h3>Device limit</h3>
        <div class="st-row">
          <div class="st-stepper">
            <button type="button" data-step="-1" aria-label="Fewer devices">−</button>
            <output aria-live="polite"></output>
            <button type="button" data-step="1" aria-label="More devices">+</button>
          </div>
          <button class="st-primary" data-act="limit">Save</button>
          <span class="st-ok" data-for="limit"></span>
        </div>
        <p class="st-note" data-note="limit"></p>
        <p class="st-err" data-for="limit"></p>
      </section>
      <section>
        <h3>Password</h3>
        <form class="st-form" data-form="password">
          <input type="password" name="current" autocomplete="current-password" placeholder="Current password" required>
          <input type="password" name="next" autocomplete="new-password" placeholder="New password (6+ characters)" minlength="6" required>
          <input type="password" name="confirm" autocomplete="new-password" placeholder="Repeat new password" required>
          <label class="st-check"><input type="checkbox" name="logoutOthers"> Log out all other devices</label>
          <button class="st-primary">Change password</button>
          <p class="st-ok" data-for="password"></p>
          <p class="st-err" data-for="password"></p>
        </form>
      </section>
      <section>
        <h3>Log in another phone</h3>
        <p class="st-note">Scan the code with the other phone's camera. It logs in without the password, works once, and expires in 10 minutes.</p>
        <button class="st-btn" data-act="qr">Show login QR</button>
        <div class="st-connection-qr" hidden></div>
        <p class="st-err" data-for="qr"></p>
      </section>
      <section>
        <button class="st-btn st-danger" data-act="logout">Log out this device</button>
      </section>
    </div>`;
  document.body.appendChild(sheet);

  const $ = (sel) => sheet.querySelector(sel);
  const msg = (kind, name, text) => { $(`.st-${kind}[data-for="${name}"]`).textContent = text; };

  let settings = null;
  let limit = 2;
  let editingId = null;
  let timer = 0;
  let currentPage = 'home';
  let suppressRender = false, previousFocus;
  const frames = [], positions = new Map();
  const routes = new Map([
    ['apps', () => window.openAppsSheet()], ['health', () => window.openHealthSheet()],
    ['screen', () => window.openScreenSheet()], ['camera', () => window.openCameraSheet()],
  ]);
  const body = $('.st-body');
  const originalSections = [...body.children];
  const pages = [
    ['computers', 'Connected computers', 'Your computers and shared connections', '▣'],
    ['connection', 'Connection', 'Wi-Fi & Internet', '↔'],
    ['tools', 'AI Tools', 'Setup, sharing & authorized computers', '✦'],
    ['controls', 'Computer controls', 'Power, applications, health, screen & camera', '⌘'],
    ['security', 'Security & Devices', 'Logins, approvals, device limit & password', '◇'],
    ['service', 'Service & Updates', 'Startup, updates & restart', '↻'],
  ];
  for (const section of originalSections) {
    const mount = section.dataset.mount;
    section.dataset.settingsPage = mount === 'connection' ? 'connection' : mount === 'service' ? 'service' : mount === 'tools' ? 'tools'
      : section.querySelector('.st-summary, .st-stepper, [data-form="password"], [data-act="qr"]') ? 'security' : 'controls';
    if (mount === 'collaborators' || section.querySelector('[data-act="room"], [data-act="logout"]')) section.remove();
  }
  $('.st-body h3').textContent = 'Logged-in devices';
  $('[data-act="apps"] span').textContent = 'Applications';
  $('[data-act="screen"] span').textContent = 'Screen';
  for (const input of sheet.querySelectorAll('.st-form input:not([type="checkbox"])')) input.setAttribute('aria-label', input.placeholder);

  const shell = el('div', 'st-window');
  const nav = el('nav', 'st-nav'); nav.setAttribute('aria-label', 'Settings categories');
  const navTitle = el('h1', 'st-nav-title', 'Settings');
  const computerInfo = el('div', 'st-computer-info');
  computerInfo.append(el('strong', null, 'This computer'), el('p', 'st-note', 'Checking connection…'));
  nav.append(navTitle, computerInfo);
  for (const [key, name, description, icon] of pages) {
    const button = el('button', 'st-category'); button.type = 'button'; button.dataset.category = key;
    const mark = el('span', 'st-category-icon', icon); mark.setAttribute('aria-hidden', 'true');
    const text = el('span', 'st-category-text'); text.append(el('span', null, name), el('small', null, description));
    button.append(mark, text, el('span', 'st-chev', '›')); button.onclick = () => showPage(key); nav.append(button);
  }
  const logoutSection = originalSections.at(-1); logoutSection.className = 'st-logout'; nav.append(logoutSection);
  const credit = el('footer', 'st-credit'); credit.append('Written by ');
  const author = el('a', null, 'theani.me'); author.href = 'https://theani.me'; author.target = '_blank'; author.rel = 'noopener noreferrer'; credit.append(author); nav.append(credit);
  const content = el('main', 'st-content');
  const head = $('.st-head');
  const back = el('button', 'st-back', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Back to settings');
  back.onclick = () => goBack(); head.prepend(back);
  const help = el('button', 'pd-guide-button', '?'); help.type = 'button'; help.hidden = true; head.querySelector('h2').after(help);
  const panelMount = el('div', 'st-panel-mount'); panelMount.hidden = true;
  const welcome = el('div', 'st-welcome'); welcome.append(el('h2', null, 'Your Pocket Dev'), el('p', null, 'Choose a category to manage your computers, tools and connection.'));
  content.append(head, welcome, body, panelMount); shell.append(nav, content); sheet.replaceChildren(shell);
  head.querySelector('h2').tabIndex = -1;
  const top = () => frames.at(-1);
  const visible = (node) => !sheet.hidden && !document.hidden && !!node?.getClientRects().length;
  const scrollNodes = (frame) => frame?.panel ? [frame.panel, ...frame.panel.querySelectorAll('.rs-body, .apps-scroll, .health-scroll, .screen-scroll')] : frame ? [body] : [nav, body];
  function remember() {
    const nodes = scrollNodes(top());
    positions.set(top()?.name || 'home', nodes.map((node) => [node, node.scrollTop]));
    if (top()) top().focus = document.activeElement;
  }
  function restore() {
    const frame = top(), name = frame?.name || 'home';
    requestAnimationFrame(() => {
      if ((top()?.name || 'home') !== name || sheet.hidden) return;
      for (const [node, value] of positions.get(name) || []) if (node.isConnected) node.scrollTop = value;
      if (frame?.focus?.getClientRects().length) frame.focus.focus({ preventScroll: true });
    });
  }
  function renderRoute() {
    if (suppressRender || sheet.hidden) return;
    const frame = top(); currentPage = frame?.category || 'home'; sheet.dataset.page = currentPage;
    if (currentPage !== 'security') loginQr.hide();
    const panel = frame?.panel;
    for (const node of panelMount.children) node.hidden = node !== panel;
    panelMount.hidden = !panel; body.hidden = currentPage === 'home' || !!panel;
    welcome.hidden = currentPage !== 'home';
    for (const section of body.children) section.hidden = section.dataset.settingsPage !== currentPage;
    for (const button of nav.querySelectorAll('[data-category]')) {
      if (button.dataset.category === currentPage) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    head.querySelector('h2').textContent = frame?.title || 'Settings'; back.hidden = !frame;
    const guide = Object.hasOwn(window.PocketGuides?.definitions || {}, frame?.name || '') ? frame.name : frame?.category;
    help.hidden = !Object.hasOwn(window.PocketGuides?.definitions || {}, guide || '');
    if (!help.hidden) { help.setAttribute('aria-label', `Help with ${window.PocketGuides.definitions[guide].title}`); help.onclick = () => window.PocketGuides.open(guide); }
    back.setAttribute('aria-label', frames.length > 1 ? 'Back' : 'Back to settings');
    if (currentPage !== 'controls' || panel) { $('.st-power').replaceChildren(); $('.st-batt').replaceChildren(); }
    else mountPower();
    if (frame && !frame.loaded && !panel) { frame.loaded = true; frame.ready = loadCategory(frame); }
    restore();
  }
  function pushFrame(frame) {
    remember();
    if (!frame.panel && !positions.has(frame.name)) positions.set(frame.name, [[body, 0]]);
    frames.push(frame);
    overlays.open(frame.name, () => {
      const index = frames.indexOf(frame); if (index < 0) return;
      frames.splice(index, 1); frame.observer?.disconnect(); frame.exit?.(); positions.delete(frame.name); renderRoute();
    });
    renderRoute();
    requestAnimationFrame(() => { if (top() === frame) head.querySelector('h2').focus({ preventScroll: true }); });
  }
  function showPage(page) {
    if (sheet.hidden) return;
    if (page === currentPage && frames.length === 1) return;
    suppressRender = true;
    if (frames.length) overlays.close(frames[0].name);
    suppressRender = false;
    if (page === 'home') return renderRoute();
    const title = pages.find(([key]) => key === page)?.[1]; if (!title) return;
    pushFrame({ name: page === 'computers' ? 'computers' : `settings-${page}`, category: page, title });
  }
  function goBack() { if (top()) overlays.close(top().name); else overlays.close('settings'); }
  async function loadCategory(frame) {
    const active = () => frames.includes(frame) && !sheet.hidden;
    const mount = $(`[data-mount="${frame.category}"]`);
    try {
      if (frame.category === 'computers') {
        const module = await import('/connected-computers.js'); if (active()) await module.openConnectedComputers();
      } else if (frame.category === 'connection') window.pocketDevNetwork?.mount(mount);
      else if (frame.category === 'service') {
        const module = await import('/service.js'); if (active()) await module.renderServiceSection(mount, api);
      } else if (frame.category === 'tools') {
        const module = await import('/setup-tools.js'); if (active()) await module.renderToolsSection(mount, api);
      } else if (frame.category === 'security') {
        $('.st-summary').textContent = 'Reading logged-in devices…';
        if (!settings) for (const button of sheet.querySelectorAll('[data-step], [data-act=limit]')) button.disabled = true;
        await refresh();
      }
      else if (frame.category === 'controls') refreshApps();
    } catch (err) {
      if (active()) {
        const error = el('p', 'st-err', err.message); (mount || body).append(error);
        frame.loaded = false;
      }
    }
  }
  // Existing panels retain their own controls and cleanup; this shell supplies their container and navigation.
  function presentPanel(root, name, cleanup) {
    if (sheet.hidden || document.querySelector('.pw-screen')) return false;
    let frame = top();
    const isCategory = name === 'computers' && frame?.name === 'computers';
    if (!isCategory) frame = { name, category: currentPage, title: root.querySelector('h2')?.textContent || name };
    const originalRole = root.getAttribute('role'), originalModal = root.getAttribute('aria-modal');
    const originalControls = [...root.querySelectorAll('header h2, [class$="-bar"] h2, header button, [class$="-bar"] button')].map((node) => [node, node.hidden, node.style.display]);
    const originalToolbarHidden = root.firstElementChild?.hidden;
    root.setAttribute('role', 'region'); root.removeAttribute('aria-modal');
    root.dataset.settingsPanel = name; panelMount.append(root);
    root.querySelectorAll('header h2, [class$="-bar"] h2').forEach((node) => node.hidden = true);
    const toolbar = root.firstElementChild;
    for (const button of toolbar?.querySelectorAll('button') || []) {
      if (/^(Close|[‹←]|.*Back)/.test(button.textContent) || button.classList.contains('rs-back')) button.hidden = true;
    }
    if (toolbar && ![...toolbar.children].some((node) => !node.hidden)) toolbar.hidden = true;
    frame.panel = root;
    frame.exit = () => {
      cleanup(); root.remove(); delete root.dataset.settingsPanel;
      if (originalRole === null) root.removeAttribute('role'); else root.setAttribute('role', originalRole);
      if (originalModal === null) root.removeAttribute('aria-modal'); else root.setAttribute('aria-modal', originalModal);
      for (const [node, hidden, display] of originalControls) { node.hidden = hidden; node.style.display = display; }
      if (toolbar) toolbar.hidden = originalToolbarHidden;
      // Health, screen and camera cache their DOM for later entry points outside Settings.
      if (!['apps', 'computers'].includes(name)) { root.hidden = true; document.body.append(root); }
    };
    frame.observer = new MutationObserver(() => {
      if (!frames.includes(frame)) return;
      const title = root.querySelector('h2')?.textContent; if (title) frame.title = title;
      if (top()?.panel === root) head.querySelector('h2').textContent = frame.title;
      // A detail can re-show its original Back button; navigation stays in the shared header.
      root.querySelectorAll('.apps-bar > button:first-child').forEach((node) => node.style.display = 'none');
    });
    frame.observer.observe(root, { subtree: true, childList: true, characterData: true });
    if (isCategory) renderRoute(); else pushFrame(frame);
    return true;
  }
  function pushView(name, title, cleanup, render, data) {
    if (sheet.hidden || !top() || document.querySelector('.pw-screen')) return false;
    const frame = { name, title, category: currentPage, panel: top().panel, exit: cleanup, loaded: true, data };
    pushFrame(frame); render?.(); return true;
  }
  function confirmAction(message, action = 'Continue') {
    if (sheet.hidden || document.querySelector('.pw-screen')) return Promise.resolve(window.confirm(message));
    return new Promise((resolve) => {
      const dialog = el('dialog', 'st-confirm');
      const heading = el('h2', null, 'Are you sure?'); heading.id = 'st-confirm-title';
      dialog.setAttribute('aria-labelledby', heading.id);
      const text = el('p', null, message), actions = el('div', 'st-confirm-actions');
      const cancel = el('button', 'st-btn', 'Cancel'), accept = el('button', 'st-primary', action);
      let settled = false;
      const finish = (answer) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(answer); };
      const key = `settings-confirm`;
      overlays.open(key, () => finish(false));
      const answer = (value) => { finish(value); overlays.close(key); };
      cancel.onclick = () => answer(false); accept.onclick = () => answer(true);
      dialog.oncancel = (event) => { event.preventDefault(); answer(false); };
      actions.append(cancel, accept); dialog.append(heading, text, actions); shell.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  renderRoute();

  function renderDevices() {
    const { devices, currentDeviceId } = settings;
    const online = devices.filter((d) => d.online).length;
    $('.st-summary').textContent = `${devices.length} logged in · ${online} online now`;
    $('.st-devices').replaceChildren(...devices.map((d) => deviceItem(d, d.id === currentDeviceId)));
    renderWaiting();
  }

  // Logins waiting for approval. The server lists them only when this device lets phones approve and this device may.
  function renderWaiting() {
    $('.st-waiting').replaceChildren(...(settings.waiting ?? []).map((d) => {
      const card = el('li', 'st-device st-pending');
      const top = el('div', 'st-dev-top');
      top.append(el('span', 'st-name', d.name), el('span', 'st-badge', 'Waiting'));
      const actions = el('div', 'st-actions');
      const approve = el('button', 'st-primary', 'Approve');
      approve.onclick = () => decide(d, 'approve');
      const deny = el('button', 'st-btn st-danger', 'Deny');
      deny.onclick = () => decide(d, 'deny');
      actions.append(approve, deny);
      card.append(top, el('div', 'st-code', d.code), el('p', 'st-note', 'Approve only if this matches the code on the other device.'),
        el('div', 'st-meta', [d.kind !== d.name && d.kind, d.ip, `asked ${ago(d.createdAt)}`].filter(Boolean).join(' · ')), actions);
      return card;
    }));
    const box = $('.st-approve');
    if (!settings.approveFromDevices) return box.replaceChildren();
    const off = el('button', 'st-btn', 'Turn off approving from phones');
    off.onclick = async () => {
      if (!await confirmAction('Turn off approving logins from phones? Only the device itself can turn it back on.')) return;
      try {
        await api('PUT', '/api/settings/approve-from-devices', { on: false });
        await refresh();
      } catch (err) {
        msg('err', 'devices', err.message);
      }
    };
    box.replaceChildren(el('p', 'st-note', 'Logged-in phones can approve waiting logins. If a phone is lost, log it out from this device’s Admin page or run Lockdown there.'), off);
  }

  async function decide(d, action) {
    if (action === 'deny' && !await confirmAction(`Deny ${d.name} (code ${d.code})? It goes back to the login page.`)) return;
    try {
      await api('POST', `/api/devices/${d.id}/${action}`);
      msg('err', 'devices', '');
      await refresh();
    } catch (err) {
      msg('err', 'devices', err.message);
    }
  }

  // The server tells every open page when a login starts waiting; each terminal socket hears it, so one code shows once.
  const notice = el('aside', 'st-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  document.getElementById('clientError').after(notice);
  let noticedCode = '';
  window.addEventListener('pd-computers-changed', ({ detail }) => {
    nav.querySelector('[data-category="computers"] small').textContent = window.PocketMachine.computerSummary(detail);
  });
  window.pocketDevSettings = {
    presentPanel, pushView, show: showPage, back: goBack, isVisible: visible, confirm: confirmAction,
    registerRoute: (name, resume) => routes.set(name, resume),
    open: (page = 'home') => { open(); if (page !== 'home') showPage(page); },
    waiting({ kind, code }) {
      if (code === noticedCode) return;
      noticedCode = code;
      const review = el('button', 'st-primary', 'Review');
      review.onclick = () => { notice.hidden = true; open(); showPage('security'); };
      const dismiss = el('button', 'st-btn', 'Dismiss');
      dismiss.onclick = () => { notice.hidden = true; };
      const actions = el('span', 'st-notice-actions');
      actions.append(review, dismiss);
      notice.replaceChildren(el('span', 'st-notice-text', `Someone is waiting to log in: ${kind}, code ${code}`), actions);
      notice.hidden = false;
    },
  };

  function deviceItem(d, isCurrent) {
    const li = el('li', `st-device${d.online ? ' online' : ''}`);
    const top = el('div', 'st-dev-top');
    if (d.id === editingId) {
      const form = el('form', 'st-rename');
      const input = el('input');
      input.value = d.name;
      input.maxLength = 40;
      input.setAttribute('aria-label', 'Device name');
      const save = el('button', 'st-primary', 'Save');
      const cancel = el('button', 'st-btn', 'Cancel');
      cancel.type = 'button';
      cancel.onclick = () => { editingId = null; renderDevices(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('PATCH', `/api/devices/${d.id}`, { name: input.value });
          editingId = null;
          msg('err', 'devices', '');
          await refresh();
        } catch (err) {
          msg('err', 'devices', err.message);
        }
      };
      form.append(input, save, cancel);
      li.append(form);
      requestAnimationFrame(() => input.focus());
    } else {
      top.append(el('span', 'st-name', d.name));
      if (isCurrent) top.append(el('span', 'st-badge', 'This device'));
      li.append(top);
    }
    const status = el('div', 'st-meta');
    if (d.online) {
      status.append(el('span', 'st-dot'), el('span', 'st-live', 'Online now'));
      if (d.connections) status.append(` · ${plural(d.connections, 'terminal')} open`);
    } else {
      status.textContent = `Last active ${ago(d.lastSeen)}`;
    }
    const where = el('div', 'st-meta', `${d.via === 'qr' ? 'QR code' : 'Password'} · ${d.ip} · added ${ago(d.createdAt)}`);
    li.append(status, where);
    if (d.id !== editingId) {
      const actions = el('div', 'st-actions');
      const rename = el('button', 'st-btn', 'Rename');
      rename.onclick = () => { editingId = d.id; renderDevices(); };
      const out = el('button', 'st-btn st-danger', 'Log out');
      out.onclick = () => logout(d, isCurrent);
      actions.append(rename, out);
      li.append(actions);
    }
    return li;
  }

  async function logout(d, isCurrent) {
    const question = isCurrent ? LOGOUT_SELF : `Log out ${d.name}? Its open terminals disconnect now.`;
    if (!await confirmAction(question, 'Log out')) return;
    try {
      await api('DELETE', `/api/devices/${d.id}`);
      if (isCurrent) { await window.clearPocketWorkspaceData?.(); return location.replace('/login.html'); }
      await refresh();
    } catch (err) {
      msg('err', 'devices', err.message);
    }
  }

  function renderLimit() {
    $('[data-act="limit"]').disabled = false;
    $('.st-stepper output').textContent = limit;
    $('[data-step="-1"]').disabled = limit <= MIN_DEVICES;
    $('[data-step="1"]').disabled = limit >= MAX_DEVICES;
    const count = settings.devices.length + (settings.collaboratorSessions || 0);
    const over = limit < count
      ? ` ${plural(count, 'device')} are logged in now, so new password logins stay blocked until you log some out.`
      : '';
    $('[data-note="limit"]').textContent = settings.roleAccessEnabled ? `The limit includes Admin devices and active collaborator sessions (${count} total). New invitations never log out an Admin. Lowering the limit does not end current sessions.` : `Password logins stop at this many devices. Lowering the limit logs nobody out; it only blocks new password logins.${over} QR logins always work and replace the device used least recently.`;
  }

  const loginQr = window.PocketConnectionQr.mount($('.st-connection-qr'), {
    button: $('[data-act="qr"]'), codeClass: 'st-qr',
    request: (connection) => api('POST', '/api/settings/qr-key', { connection }),
  });
  function renderAddress() { loginQr.update(window.PocketConnectionQr.options(settings)); }

  async function refreshApps() {
    try {
      const { apps } = await api('GET', '/api/apps');
      $('.st-apps-count:not(.st-room-sum)').textContent = ` · ${apps.length} running`;
      msg('err', 'apps', '');
    } catch (err) {
      $('.st-apps-count:not(.st-room-sum)').textContent = '';
      msg('err', 'apps', err.message);
    }
  }

  // Mounted while the sheet is open: both poll /api/power until they leave the page.
  async function mountPower() {
    const { renderPowerSection, renderBatteryBadge } = await power;
    if (sheet.hidden || currentPage !== 'controls' || top()?.panel || $('.st-power').childElementCount) return;
    renderPowerSection($('.st-power'), api, powerOptions);
    renderBatteryBadge($('.st-batt'), api);
  }

  $('[data-act="apps"]').addEventListener('click', () => window.openAppsSheet());
  $('[data-act="health"]').addEventListener('click', () => window.openHealthSheet());
  $('[data-act="screen"]').addEventListener('click', () => window.openScreenSheet());
  $('[data-act="camera"]').addEventListener('click', () => window.openCameraSheet());

  async function refresh() {
    try {
      const fresh = await api('GET', '/api/settings');
      if (sheet.hidden) return;
      const stepperUntouched = !settings || settings.maxDevices === limit;
      settings = fresh;
      if (stepperUntouched) limit = fresh.maxDevices;
      if (editingId === null) renderDevices();
      renderLimit();
      renderAddress();
      msg('err', 'devices', '');
    } catch (err) {
      msg('err', 'devices', err.message);
    }
  }

  sheet.querySelector('.st-stepper').addEventListener('click', (e) => {
    const step = Number(e.target.closest('[data-step]')?.dataset.step);
    if (!step) return;
    limit = Math.min(MAX_DEVICES, Math.max(MIN_DEVICES, limit + step));
    msg('ok', 'limit', '');
    renderLimit();
  });

  $('[data-act="limit"]').addEventListener('click', async () => {
    msg('err', 'limit', '');
    try {
      const { maxDevices } = await api('PUT', '/api/settings/max-devices', { maxDevices: limit });
      settings.maxDevices = limit = maxDevices;
      msg('ok', 'limit', 'Saved');
      renderLimit();
    } catch (err) {
      msg('err', 'limit', err.message);
    }
  });

  $('[data-form="password"]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const { current, next, confirm: again, logoutOthers } = form.elements;
    msg('ok', 'password', '');
    msg('err', 'password', '');
    if (next.value.length < 6) return msg('err', 'password', 'The new password needs at least 6 characters.');
    if (next.value !== again.value) return msg('err', 'password', 'The new passwords do not match.');
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const { loggedOut } = await api('POST', '/api/settings/password', { current: current.value, next: next.value, logoutOthers: logoutOthers.checked });
      form.reset();
      msg('ok', 'password', loggedOut ? `Password changed. Logged out ${plural(loggedOut, 'other device')}.` : 'Password changed.');
      await refresh();
    } catch (err) {
      msg('err', 'password', err.message);
    } finally {
      button.disabled = false;
    }
  });

  $('[data-act="logout"]').addEventListener('click', async () => {
    if (!await confirmAction(LOGOUT_SELF, 'Log out')) return;
    try { await api('POST', '/api/logout'); await window.clearPocketWorkspaceData?.(); location.replace('/login.html'); } catch (err) { window.alert(err.message); }
  });

  function hide() {
    sheet.hidden = true; document.body.classList.remove('pd-settings-open');
    document.dispatchEvent(new CustomEvent('pd-settings-visibility', { detail: false }));
    previousFocus?.focus?.();
    $('.st-power').replaceChildren();
    $('.st-batt').replaceChildren();
    clearInterval(timer);
    editingId = null;
    $('[data-form="password"]').reset();
    loginQr.update({ local: null, remote: null, remoteEnabled: false }, false);
  }

  $('.st-close').addEventListener('click', () => overlays.close('settings'));

  async function open() {
    if (!sheet.hidden) return;
    previousFocus = document.activeElement; previousFocus?.blur();
    overlays.open('settings', hide); settings = null; sheet.hidden = false; document.body.classList.add('pd-settings-open');
    document.dispatchEvent(new CustomEvent('pd-settings-visibility', { detail: true }));
    positions.clear(); renderRoute();
    head.querySelector('h2').focus();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden || sheet.hidden || top()?.panel) return;
      if (currentPage === 'security') refresh();
      if (currentPage === 'controls') refreshApps();
    }, REFRESH_MS);
    try {
      const state = await api('GET', '/api/connections'); if (sheet.hidden) return;
      const self = state.computers.find((computer) => computer.self);
      computerInfo.replaceChildren(el('strong', null, self?.name || 'This computer'), el('p', 'st-note', 'Connected · This computer'));
      nav.querySelector('[data-category="computers"] small').textContent = window.PocketMachine.computerSummary(state.computers);
    } catch {
      computerInfo.replaceChildren(el('strong', null, 'This computer'), el('p', 'st-note', 'Connection unavailable'));
    }
  }
  sheet.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || shell.querySelector('dialog[open]')) return;
    const nodes = [...sheet.querySelectorAll('button, input, select, a[href], [tabindex="0"]')].filter((node) => !node.disabled && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
  });
  document.addEventListener('keydown', (event) => {
    if (!sheet.hidden && event.key === 'Escape' && !event.defaultPrevented && !shell.querySelector('dialog[open], [popover]:popover-open') && (event.target === document.body || sheet.contains(event.target))) {
      event.preventDefault(); goBack();
    }
  });
  const fitViewport = () => {
    sheet.style.setProperty('--st-height', `${window.visualViewport?.height || innerHeight}px`);
    sheet.style.setProperty('--st-top', `${window.visualViewport?.offsetTop || 0}px`);
  };
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport); fitViewport();
  document.getElementById('settingsBtn').addEventListener('click', open);
  window.pocketDev.navigation?.register('settings', {
    snapshot() {
      if (sheet.hidden) return null;
      remember();
      return { category: currentPage, path: frames.slice(1).map(({ name, data }) => ({ name, data })),
        scroll: Object.fromEntries([...positions].map(([name, nodes]) => [name, nodes.map(([, value]) => value)])) };
    },
    async restore(saved) {
      if (!saved || !['home', ...pages.map(([key]) => key)].includes(saved.category)) return;
      open();
      showPage(saved.category);
      const categoryFrame = top();
      const active = () => !sheet.hidden && (categoryFrame ? frames.includes(categoryFrame) : !frames.length);
      await categoryFrame?.ready;
      for (const route of Array.isArray(saved.path) ? saved.path.slice(0, 8) : []) {
        if (!active()) return;
        const resume = routes.get(route.name), parent = top();
        if (!resume) break;
        await resume(route.data);
        if (top() === parent) break;
      }
      if (!active()) return;
      for (const frame of [null, ...frames]) {
        const values = saved.scroll?.[frame?.name || 'home'];
        if (Array.isArray(values)) positions.set(frame?.name || 'home', scrollNodes(frame).map((node, index) => [node, Number.isFinite(values[index]) ? Math.max(0, values[index]) : 0]));
      }
      restore();
    },
  });
  if (/^#camera(?:=[0-9a-f]{4,64})?$/.test(location.hash)) {
    window.addEventListener('DOMContentLoaded', () => {
      history.replaceState(history.state, '', location.pathname + location.search);
      window.pocketDevSettings.open('controls');
      window.openCameraSheet();
    }, { once: true });
  }
})();
