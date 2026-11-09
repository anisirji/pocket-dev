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
        <button class="st-link" data-act="room"><span>Room</span><span class="st-apps-count st-room-sum"></span><span class="st-chev" aria-hidden="true">›</span></button>
        <p class="st-err" data-for="room"></p>
      </section>
      <section data-mount="connection" hidden></section>
      <section data-mount="service"></section>
      <section data-mount="collaborators"></section>
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
        <button class="st-link" data-act="health"><span>Mac health</span><span class="st-chev" aria-hidden="true">›</span></button>
      </section>
      <section>
        <button class="st-link" data-act="screen"><span>Mac screen</span><span class="st-chev" aria-hidden="true">›</span></button>
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
        <p class="st-note st-addr"></p>
        <button class="st-btn" data-act="qr">Show login QR</button>
        <div class="st-qr" hidden></div>
        <button class="st-btn" data-act="copy-qr" hidden>Copy link</button>
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
  let collaborators;

  function renderDevices() {
    const { devices, currentDeviceId } = settings;
    const online = devices.filter((d) => d.online).length;
    $('.st-summary').textContent = `${devices.length} logged in · ${online} online now`;
    $('.st-devices').replaceChildren(...devices.map((d) => deviceItem(d, d.id === currentDeviceId)));
    renderWaiting();
  }

  // Logins waiting for approval. The server lists them only when the Mac lets phones approve and this device may.
  function renderWaiting() {
    $('.st-waiting').replaceChildren(...(settings.waiting ?? []).map((d) => {
      const card = el('li', 'st-device st-pending');
      const top = el('div', 'st-dev-top');
      top.append(el('span', 'st-name', d.kind ?? d.name), el('span', 'st-badge', 'Waiting'));
      const actions = el('div', 'st-actions');
      const approve = el('button', 'st-primary', 'Approve');
      approve.onclick = () => decide(d, 'approve');
      const deny = el('button', 'st-btn st-danger', 'Deny');
      deny.onclick = () => decide(d, 'deny');
      actions.append(approve, deny);
      card.append(top, el('div', 'st-code', d.code), el('p', 'st-note', 'Approve only if this matches the code on the other device.'),
        el('div', 'st-meta', `${d.ip} · asked ${ago(d.createdAt)}`), actions);
      return card;
    }));
    const box = $('.st-approve');
    if (!settings.approveFromDevices) return box.replaceChildren();
    const off = el('button', 'st-btn', 'Turn off approving from phones');
    off.onclick = async () => {
      if (!confirm('Turn off approving logins from phones? Only the Mac can turn it back on.')) return;
      try {
        await api('PUT', '/api/settings/approve-from-devices', { on: false });
        await refresh();
      } catch (err) {
        msg('err', 'devices', err.message);
      }
    };
    box.replaceChildren(el('p', 'st-note', 'Logged-in phones can approve waiting logins. If a phone is lost, log it out from the Mac or run Lockdown there.'), off);
  }

  async function decide(d, action) {
    if (action === 'deny' && !confirm(`Deny ${d.kind ?? d.name} (code ${d.code})? It goes back to the login page.`)) return;
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
  window.pocketDevSettings = {
    waiting({ kind, code }) {
      if (code === noticedCode) return;
      noticedCode = code;
      const review = el('button', 'st-primary', 'Review');
      review.onclick = () => { notice.hidden = true; open(); };
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
    if (!confirm(question)) return;
    try {
      await api('DELETE', `/api/devices/${d.id}`);
      if (isCurrent) return location.replace('/login.html');
      await refresh();
    } catch (err) {
      msg('err', 'devices', err.message);
    }
  }

  function renderLimit() {
    $('.st-stepper output').textContent = limit;
    $('[data-step="-1"]').disabled = limit <= MIN_DEVICES;
    $('[data-step="1"]').disabled = limit >= MAX_DEVICES;
    const count = settings.devices.length + (settings.collaboratorSessions || 0);
    const over = limit < count
      ? ` ${plural(count, 'device')} are logged in now, so new password logins stay blocked until you log some out.`
      : '';
    $('[data-note="limit"]').textContent = settings.roleAccessEnabled ? `The limit includes Admin devices and active collaborator sessions (${count} total). New invitations never log out an Admin. Lowering the limit does not end current sessions.` : `Password logins stop at this many devices. Lowering the limit logs nobody out; it only blocks new password logins.${over} QR logins always work and replace the device used least recently.`;
  }

  function renderAddress() {
    const { lan, local, remote, localNote } = settings.urls;
    if (settings.via === 'remote') {
      $('.st-addr').textContent = `Or open ${remote} on the other phone and type the password.`;
      return;
    }
    $('.st-addr').textContent = lan
      ? `Or open ${lan} on the other phone and type the password. ${local} also works (${localNote}).`
      : `The Mac has no network right now. ${local} works once it is back on Wi-Fi (${localNote}).`;
  }

  async function refreshApps() {
    try {
      const { apps } = await api('GET', '/api/apps');
      $('.st-apps-count').textContent = ` · ${apps.length} running`;
      msg('err', 'apps', '');
    } catch (err) {
      $('.st-apps-count').textContent = '';
      msg('err', 'apps', err.message);
    }
  }

  // Mounted while the sheet is open: both poll /api/power until they leave the page.
  async function mountPower() {
    const { renderPowerSection, renderBatteryBadge } = await power;
    if (sheet.hidden || $('.st-power').childElementCount) return;
    renderPowerSection($('.st-power'), api, powerOptions);
    renderBatteryBadge($('.st-batt'), api);
  }

  $('[data-act="apps"]').addEventListener('click', () => window.openAppsSheet());
  $('[data-act="health"]').addEventListener('click', () => window.openHealthSheet());
  $('[data-act="screen"]').addEventListener('click', () => window.openScreenSheet());

  async function refresh() {
    collaborators?.refresh();
    refreshApps();
    try {
      const fresh = await api('GET', '/api/settings');
      const stepperUntouched = !settings || settings.maxDevices === limit;
      settings = fresh;
      $('.st-head h2').textContent = fresh.roleAccessEnabled ? 'Settings · Admin' : 'Settings';
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

  $('[data-act="qr"]').addEventListener('click', async (e) => {
    msg('err', 'qr', '');
    try {
      const { svg, url } = await api('POST', '/api/settings/qr-key');
      const box = $('.st-qr');
      box.innerHTML = svg;
      box.hidden = false;
      const copy = $('[data-act="copy-qr"]');
      copy.hidden = false;
      copy.textContent = 'Copy link';
      copy.onclick = async () => { copy.textContent = (await window.copyText?.(url)) ? 'Copied' : 'Copy failed'; };
      e.target.textContent = 'New code';
    } catch (err) {
      msg('err', 'qr', err.message);
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
    if (!confirm(LOGOUT_SELF)) return;
    try { await api('POST', '/api/logout'); } catch {}
    location.replace('/login.html');
  });

  function hide() {
    sheet.hidden = true;
    $('.st-power').replaceChildren();
    $('.st-batt').replaceChildren();
    clearInterval(timer);
    editingId = null;
    $('.st-qr').hidden = true;
    $('.st-qr').replaceChildren();
    $('[data-act="copy-qr"]').hidden = true;
    $('[data-act="qr"]').textContent = 'Show login QR';
  }

  $('.st-close').addEventListener('click', () => overlays.close('settings'));

  async function open() {
    document.activeElement?.blur();
    if (!sheet.hidden) return;
    overlays.open('settings', hide);
    settings = null;
    sheet.hidden = false;
    sheet.querySelector('.st-body').scrollTop = 0;
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
    window.pocketDevNetwork?.mount($('[data-mount="connection"]'));
    import('/service.js').then((m) => m.renderServiceSection($('[data-mount="service"]'), api)).catch(() => {});
    import('/collaborators.js').then((m) => {
      collaborators ||= m.mountCollaborators($('[data-mount="collaborators"]'), { api });
      collaborators.refresh();
    }).catch((err) => { $('[data-mount="collaborators"]').textContent = `Could not load Collaborators: ${err.message}. Restart Pocket Dev and reload.`; });
    import('/room-screen.js').then((m) => m.roomSummary()).then((t) => { $('.st-room-sum').textContent = t; }).catch(() => {});
    mountPower();
    await refresh();
  }

  $('[data-act="room"]').addEventListener('click', () => {
    import('/room-screen.js').then((m) => m.openRoom()).catch((err) => msg('err', 'room', `Could not load Room: ${err.message}. Reload this page.`));
  });
  document.getElementById('settingsBtn').addEventListener('click', open);
})();
