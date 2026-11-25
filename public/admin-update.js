// The Admin page's update banner. It stays at the top on every load while a newer Pocket Dev is on npm, with an Update
// button that installs it on this computer and restarts the background service. Opening the page asks the server for a
// fresh look when the last one is over an hour old.
(() => {
  const baseTitle = document.title;
  const SVG = 'http://www.w3.org/2000/svg';
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const BUSY = new Set(['checking', 'installing', 'restarting']);
  let view = null;
  let polling = 0;
  let waitedFrom = null;

  const banner = make('section', 'upd');
  banner.id = 'updateBanner';
  banner.setAttribute('aria-label', 'Pocket Dev update');
  banner.hidden = true;
  const head = make('div', 'upd-head');
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'upd-icon' })) svg.setAttribute(k, v);
  const circle = document.createElementNS(SVG, 'circle'); circle.setAttribute('cx', 12); circle.setAttribute('cy', 12); circle.setAttribute('r', 9);
  const arrow = document.createElementNS(SVG, 'path'); arrow.setAttribute('d', 'M12 16V8M8.5 11.5 12 8l3.5 3.5');
  svg.append(circle, arrow);
  const text = make('div', 'upd-text');
  const title = make('b', 'upd-title');
  const sub = make('small', 'upd-sub');
  text.append(title, sub);
  const actions = make('div', 'upd-actions');
  const updateBtn = make('button', 'btn upd-btn', 'Update');
  updateBtn.type = 'button';
  const notes = make('a', 'upd-link', 'What is new');
  notes.target = '_blank'; notes.rel = 'noopener noreferrer';
  actions.append(updateBtn, notes);
  head.append(svg, text, actions);
  const log = make('pre', 'upd-log');
  log.hidden = true;
  const help = make('p', 'upd-help');
  help.hidden = true;
  banner.append(head, log, help);
  document.querySelector('header.top')?.after(banner);

  const dialog = document.createElement('dialog');
  dialog.className = 'upd-dialog';
  const dTitle = make('h2', 'upd-d-title', 'Update Pocket Dev?');
  const dBody = make('p', 'upd-d-body');
  const dCancel = make('button', 'btn', 'Cancel'); dCancel.type = 'button';
  const dGo = make('button', 'btn upd-btn', 'Update now'); dGo.type = 'button';
  const dActions = make('div', 'upd-d-actions'); dActions.append(dCancel, dGo);
  dialog.append(dTitle, dBody, dActions);
  document.body.append(dialog);

  async function call(method, path) {
    const res = await fetch(path, { method, cache: 'no-store', headers: method === 'GET' ? {} : { 'x-pocket-admin': '1', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  function render() {
    const v = view;
    const busy = v && BUSY.has(v.phase);
    const show = v && (v.available || busy || v.phase === 'done' || v.phase === 'failed');
    banner.hidden = !show;
    document.title = show && v.available ? `• Update available · ${baseTitle}` : baseTitle;
    if (!show) return;
    title.textContent = v.available ? `Pocket Dev ${v.latest} is available` : (v.message || 'Pocket Dev update');
    sub.textContent = v.available ? `You have ${v.current}.` : '';
    notes.href = v.releasesUrl;
    updateBtn.hidden = !(v.available && v.phase !== 'restarting' && v.phase !== 'done');
    updateBtn.disabled = !v.canUpdate;
    updateBtn.textContent = v.phase === 'failed' ? 'Try again' : 'Update';
    updateBtn.title = v.reason || '';
    if (v.available && v.reason) sub.textContent = `You have ${v.current}. ${v.reason}`;
    if (busy || v.phase === 'done') sub.textContent = v.message || '';
    if (v.phase === 'failed') sub.textContent = v.error || 'The update did not finish.';
    log.hidden = !(v.output?.length && (busy || v.phase === 'failed' || v.phase === 'done'));
    log.textContent = (v.output || []).join('\n');
    help.hidden = !(v.denied && v.help);
    if (v.denied && v.help) help.textContent = v.help.join(' ');
  }

  async function refresh() {
    try {
      const { status, body } = await call('GET', '/api/update');
      if (status !== 200) return;
      view = body;
      if (waitedFrom && view.phase === 'idle' && view.current !== waitedFrom) { location.reload(); return; }
      if (view.phase === 'failed') waitedFrom = null;
      render();
      if (BUSY.has(view.phase) || waitedFrom) startPolling(); else stopPolling();
    } catch {
      // The server is restarting after an update: keep trying until it answers with the new version.
      if (waitedFrom) { startPolling(); return; }
    }
  }
  function startPolling() { if (!polling) polling = setInterval(refresh, 800); }
  function stopPolling() { clearInterval(polling); polling = 0; }

  updateBtn.onclick = () => {
    const v = view;
    if (!v?.canUpdate) return;
    dBody.textContent = `This installs Pocket Dev ${v.latest} on this computer with npm install -g, then restarts the background service. Terminals and chats on your phone reconnect after a few seconds. Nothing is deleted. You have ${v.current}.${v.windows ? ' On Windows, Pocket Dev stops while npm installs, because Windows cannot replace files in use: open terminals close, and it starts again by itself in about a minute.' : ''}`;
    dialog.showModal();
  };
  dCancel.onclick = () => dialog.close();
  dGo.onclick = async () => {
    dialog.close();
    waitedFrom = view.current;
    const { status, body } = await call('POST', '/api/update');
    if (status !== 202) { waitedFrom = null; view = { ...(view || {}), ...(body || {}), phase: 'failed', error: body.error || 'The update could not start.' }; render(); return; }
    view = body; render(); startPolling();
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden && !polling) void refresh(); }, 5 * 60_000);
  void refresh();
})();
