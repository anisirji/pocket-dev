(() => {
  const AUTO_MS = 3000;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const { overlays } = window.pocketDev;

  // The picture is read-only: it shows what is on the device's screen and sends nothing back.
  const state = { open: false, busy: false, auto: true, zoom: false, url: null, blob: null, timer: 0, display: 1, quality: 'auto', adaptive: 'balanced', interval: AUTO_MS, run: 0, session: 0 };
  let controller, supportController, control;
  let ui = null;

  function build() {
    const root = el('div', 'screen-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Device screen');
    const bar = el('div', 'screen-bar');
    const title = el('h2', null, 'Device screen');
    const refresh = el('button', 'screen-btn', 'Refresh');
    const auto = el('button', 'screen-btn');
    const zoom = el('button', 'screen-btn');
    const snapshot = el('button', 'screen-btn', 'Snapshot'); snapshot.disabled = true;
    snapshot.onclick = () => { if (!state.blob) return; const url = URL.createObjectURL(state.blob), link = el('a'); link.href = url; link.download = `pocket-screen-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); };
    const display = el('select', 'screen-select'); display.setAttribute('aria-label', 'Display'); display.hidden = true;
    const quality = el('select', 'screen-select'); quality.setAttribute('aria-label', 'Screen quality');
    const options = el('div', 'screen-options'); options.id = 'screenOptions'; options.setAttribute('popover', '');
    const optionsButton = el('button', 'screen-btn', '⋯'); optionsButton.type = 'button'; optionsButton.setAttribute('aria-label', 'Screen options'); optionsButton.setAttribute('popovertarget', options.id);
    const displayLabel = el('label', '', 'Display'); displayLabel.hidden = true; displayLabel.append(display);
    const qualityLabel = el('label', '', 'Quality'); qualityLabel.append(quality); options.append(displayLabel, qualityLabel);
    for (const [value, label] of [['auto', 'Auto quality'], ['low', 'Low data'], ['balanced', 'Balanced'], ['high', 'High detail']]) { const option = el('option', '', label); option.value = value; quality.append(option); }
    const change = () => { controller?.abort(); state.run++; state.busy = false; capture(); };
    display.onchange = () => { control?.close(); state.display = Number(display.value); change(); };
    quality.onchange = () => { state.quality = quality.value; change(); };
    const close = el('button', 'screen-btn', 'Close');
    for (const b of [refresh, auto, zoom, snapshot, close]) b.type = 'button';
    refresh.onclick = capture;
    auto.onclick = () => { state.auto = !state.auto; schedule(); paint(); };
    zoom.onclick = () => { state.zoom = !state.zoom; paint(); };
    close.onclick = () => overlays.close('screen');
    bar.append(title, refresh, auto, zoom, snapshot, optionsButton, options, close);
    const scroll = el('div', 'screen-scroll');
    const img = el('img', 'screen-img');
    img.alt = 'The device screen';
    const error = el('p', 'screen-error');
    error.hidden = true;
    scroll.append(error, img);
    const note = el('p', 'screen-note');
    root.append(bar, scroll, note);
    document.body.appendChild(root);
    control = window.PocketScreenControl?.mount({ image: img, toolbar: bar, root, display: () => state.display, capture, changed: (active) => { state.interval = active ? 1000 : AUTO_MS; schedule(); } });
    return { root, auto, zoom, snapshot, display, displayLabel, quality, scroll, img, error, note };
  }

  function paint() {
    ui.auto.textContent = state.auto ? 'Auto: on' : 'Auto: off';
    ui.zoom.textContent = state.zoom ? 'Fit' : 'Zoom';
    ui.img.classList.toggle('zoom', state.zoom);
    ui.snapshot.disabled = !state.url;
  }

  async function capture() {
    if (state.busy || !state.open || document.hidden) return;
    clearTimeout(state.timer);
    const run = ++state.run, started = performance.now(); controller = new AbortController();
    state.busy = true;
    try {
      const slow = navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '');
      const quality = state.quality === 'auto' ? slow ? 'low' : state.adaptive : state.quality;
      const params = new URLSearchParams({ display: String(state.display), quality });
      const res = await fetch('/api/screen?' + params, { signal: controller.signal, headers: { 'x-pocket-dev': '1' }, cache: 'no-store' });
      if (res.status === 401) return location.replace('/login.html');
      if (res.status === 403) { state.auto = false; ui.img.removeAttribute('src'); if (state.url) URL.revokeObjectURL(state.url); state.url = null; state.blob = null; }
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const blob = await res.blob();
      if (!state.open || run !== state.run) return;
      const url = URL.createObjectURL(blob);
      ui.img.src = url;
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = url;
      state.blob = blob;
      const elapsed = performance.now() - started;
      state.adaptive = elapsed > 1500 ? 'low' : 'balanced'; state.interval = control?.active() ? Math.max(1000, elapsed) : elapsed > 5000 ? 6000 : AUTO_MS;
      ui.error.hidden = true;
      ui.note.textContent = `Updated ${new Date().toLocaleTimeString()}. If you only see the wallpaper, allow Screen Recording for node on the Mac (Admin page → Permissions; this is a macOS setting).`;
    } catch (err) {
      if (err.name === 'AbortError' || !state.open || run !== state.run) return;
      ui.error.textContent = err.message;
      ui.error.hidden = false;
    } finally {
      if (run === state.run) { state.busy = false; paint(); schedule(); }
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (state.open && state.auto && !document.hidden) state.timer = setTimeout(capture, state.interval);
  }

  function closeSheet() {
    control?.close();
    clearTimeout(state.timer); controller?.abort(); supportController?.abort(); state.run++; state.session++; state.busy = false;
    state.open = false;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = null;
    state.blob = null;
    ui.root.hidden = true;
    ui.img.removeAttribute('src'); paint();
  }
  document.addEventListener('visibilitychange', () => { if (!state.open) return; if (document.hidden) { controller?.abort(); clearTimeout(state.timer); } else capture(); });

  window.openScreenSheet = () => {
    if (state.open) return;
    document.activeElement?.blur();
    ui ??= build();
    ui.root.hidden = false;
    ui.img.removeAttribute('src');
    ui.note.textContent = '';
    state.open = true;
    state.session++;
    if (!window.pocketDevSettings?.presentPanel(ui.root, 'screen', closeSheet)) overlays.open('screen', closeSheet);
    paint();
    capture();
    schedule();
    const session = state.session; supportController = new AbortController();
    fetch('/api/screen/support', { signal: supportController.signal, cache: 'no-store' }).then(async (response) => { if (!response.ok) return; const support = await response.json(); if (!state.open || session !== state.session) return;
      ui.display.replaceChildren(...(support.displays || []).map((screen) => { const option = el('option', '', screen.name); option.value = screen.index; return option; }));
      if (support.displays?.length && !support.displays.some((display) => display.index === state.display)) { state.display = support.displays[0].index; controller?.abort(); state.run++; state.busy = false; capture(); }
      ui.display.hidden = ui.displayLabel.hidden = !support.monitorSelection; ui.display.value = String(state.display);
    }).catch(() => {});
  };
})();
