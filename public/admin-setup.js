(() => {
  const $ = (id) => document.getElementById(id);
  const make = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; };
  let connectionQr, connectionState;
  let api, permissions, paused, source, active = false, generation = 0, step = 1, plan, job;
  const button = (label, run, primary = false) => { const node = make('button', label); node.type = 'button'; node.className = `btn${primary ? ' btn-primary' : ''}`; node.onclick = () => Promise.resolve(run()).catch((error) => { $('setupStatus').textContent = error.message; }); return node; };
  function show(title, why, actions) {
    connectionQr?.hide(); connectionQr = null;
    $('setupStep').textContent = `${step} of 4`; $('setupTitle').textContent = title; $('setupWhy').textContent = why; $('setupStatus').textContent = ''; $('setupContent').replaceChildren(); $('setupActions').replaceChildren(...actions);
    if (!$('setup').open) $('setup').showModal();
  }
  function cleanup() { connectionQr?.hide(); connectionQr = null; active = false; generation++; source?.close(); source = null; $('setupContent').replaceChildren(); }
  async function pause() { cleanup(); await api('POST', '/api/permissions/setup', { status: 'skipped' }); $('setup').close(); paused?.(); }
  async function saveStep(value) { step = value; await api('POST', '/api/setup/progress', { step }); }
  function welcome() {
    generation++; source?.close(); source = null;
    step = 1;
    show('Welcome to Pocket Dev', 'AI Chat, shared AI and your development workspace. Check this computer, choose optional tools, connect your phone and review permissions.', [button('Skip for now', pause), button('Continue', tools, true)]);
  }
  async function tools() {
    source?.close(); source = null; const run = ++generation; await saveStep(2); if (!active || run !== generation) return;
    show('Tools on this computer', 'Install only the tools you want. Sign-ins stay in each tool’s own flow. Opening this screen installs nothing.', [button('Pause setup', pause), button('Back', welcome)]);
    $('setupStatus').textContent = 'Checking installed tools…';
    plan = await api('GET', '/api/setup/plan'); if (!active || run !== generation) return;
    job = plan.job; renderTools();
    source = new EventSource('/api/setup/actions/events');
    source.onmessage = async ({ data }) => {
      if (!active || step !== 2 || run !== generation) return;
      let update; try { update = JSON.parse(data); } catch { return; }
      const previous = job?.state, previousId = job?.id; job = update.job;
      if (previous !== job?.state && ['ready', 'failed', 'interrupted'].includes(job?.state)) {
        try { const fresh = await api('GET', '/api/setup/plan'); if (!active || run !== generation) return; plan = fresh; } catch {}
      }
      if (previous !== job?.state || previousId !== job?.id) renderTools();
      else { const output = $('setupContent').querySelector('.setup-output'); if (output) output.textContent = job?.output || job?.message; }
    };
    source.onerror = () => { if (active && step === 2) $('setupStatus').textContent = 'The setup connection was interrupted. Reopen this step to check progress; installation is not restarted automatically.'; };
  }
  function renderTools() {
    const busy = ['running', 'checking'].includes(job?.state), content = $('setupContent'); content.replaceChildren();
    for (const tool of plan.tools) {
      const row = make('section'); row.className = 'setup-tool'; const text = make('div'); text.append(make('strong', tool.title), make('small', tool.installed ? `${tool.version || 'Installed'} · ${tool.loggedIn ? 'Signed in' : tool.login ? 'Sign-in may be needed' : 'Ready'}` : `${tool.level} · Not installed`)); row.append(text);
      if (!tool.installed && tool.install.action === 'run') {
        const install = button(job?.tool === tool.id && ['failed', 'interrupted'].includes(job.state) ? 'Retry install' : 'Install', async () => {
          install.disabled = true;
          try { const result = await api('POST', '/api/setup/actions', { tool: tool.id, confirmed: true, requestId: crypto.randomUUID() }); job = result.job; renderTools(); }
          catch (error) { install.disabled = false; throw error; }
        }); install.disabled = busy; row.append(install);
      }
      const command = tool.installed && tool.login && !tool.loggedIn ? tool.login : !tool.installed ? tool.install.command || tool.install.steps?.join('\n') || tool.install.reason : null;
      if (command) { const details = make('details'); details.append(make('summary', tool.installed ? 'Sign in on this computer' : tool.install.action === 'run' ? 'Installation command' : 'Setup instructions'), make('pre', command)); row.append(details); }
      content.append(row);
    }
    if (job) { const output = make('pre', job.output || job.message); output.className = 'setup-output'; output.setAttribute('aria-label', 'Installation progress'); content.append(make('p', job.message), output); }
    const next = button('Continue', connection, true); next.disabled = busy;
    $('setupActions').replaceChildren(button('Pause setup', pause), button('Back', async () => { await saveStep(1); if (active) welcome(); }), button('Check again', tools), next);
    $('setupStatus').textContent = busy ? job.message : 'Optional tools can be installed or signed in later.';
  }
  async function connection() {
    source?.close(); source = null; const run = ++generation; await saveStep(3); if (!active || run !== generation) return;
    show('Connect your phone', 'Use the same Wi-Fi as this computer. Internet access and startup options remain available in Admin after setup.', [button('Back', tools), button('Continue', finish, true)]);
    const status = connectionState = await api('GET', '/api/state'); if (!active || run !== generation) return;
    const content = $('setupContent'), qr = make('div'); qr.hidden = true;
    const qrButton = button('Show login QR', () => {}); content.append(qrButton, qr);
    connectionQr = window.PocketConnectionQr.mount(qr, {
      button: qrButton, image: true,
      request: async (connection) => {
        if (!connectionState.access.connected) {
          await api('PUT', '/api/access', { connected: true });
          connectionState.access.connected = true;
        }
        return api('POST', '/api/qr', { kind: 'login', connection });
      },
    });
    connectionQr.update(window.PocketConnectionQr.options(status));
    if (!status.passwordFromEnv) {
      const password = make('input'), confirm = make('input'); password.type = confirm.type = 'password'; password.autocomplete = confirm.autocomplete = 'new-password'; password.placeholder = 'New password (optional)'; confirm.placeholder = 'Confirm password'; password.setAttribute('aria-label', 'New setup password'); confirm.setAttribute('aria-label', 'Confirm setup password');
      content.append(make('h4', 'Password'), make('p', 'Keep the current password or choose a new one. Existing devices stay signed in.'), password, confirm, button('Set password', async () => {
        if (password.value.length < 6 || password.value !== confirm.value) throw new Error('Use at least six characters and matching passwords.');
        await api('POST', '/api/password', { next: password.value, logoutAll: false }); password.value = confirm.value = ''; $('setupStatus').textContent = 'Password saved.';
      }));
    }
  }
  async function finish() { await saveStep(4); if (!active) return; cleanup(); permissions(); }
  window.PocketAdminSetup = {
    active: () => active, pause,
    updateConnections(state, online = true) {
      if (!active || step !== 3 || !connectionQr || !state) return;
      connectionState = state; connectionQr.update(window.PocketConnectionQr.options(state), online);
    },
    open(options) { cleanup(); api = options.api; permissions = options.permissions; paused = options.paused; active = true;
      if (options.step === 2) tools().catch((error) => { $('setupStatus').textContent = error.message; });
      else if (options.step === 3) connection().catch((error) => { $('setupStatus').textContent = error.message; });
      else if (options.step === 4) finish().catch((error) => { $('setupStatus').textContent = error.message; });
      else welcome();
    },
  };
  $('setup').addEventListener('close', () => { if (active) cleanup(); });
  document.addEventListener('visibilitychange', () => {
    if (!active || step !== 2) return;
    if (document.hidden) { generation++; source?.close(); source = null; }
    else tools().catch((error) => { $('setupStatus').textContent = error.message; });
  });
  window.addEventListener('pagehide', cleanup);
})();
