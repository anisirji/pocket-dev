(() => {
  const AUTO_MS = 3000;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const { overlays } = window.pocketDev;

  // The picture is read-only: it shows what is on the Mac's screen and sends nothing back.
  const state = { open: false, busy: false, auto: true, zoom: false, url: null, timer: 0 };
  let ui = null;

  function build() {
    const root = el('div', 'screen-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Mac screen');
    const bar = el('div', 'screen-bar');
    const title = el('h2', null, 'Mac screen');
    const refresh = el('button', 'screen-btn', 'Refresh');
    const auto = el('button', 'screen-btn');
    const zoom = el('button', 'screen-btn');
    const close = el('button', 'screen-btn', 'Close');
    for (const b of [refresh, auto, zoom, close]) b.type = 'button';
    refresh.onclick = capture;
    auto.onclick = () => { state.auto = !state.auto; schedule(); paint(); };
    zoom.onclick = () => { state.zoom = !state.zoom; paint(); };
    close.onclick = () => overlays.close('screen');
    bar.append(title, refresh, auto, zoom, close);
    const scroll = el('div', 'screen-scroll');
    const img = el('img', 'screen-img');
    img.alt = 'The Mac screen';
    const error = el('p', 'screen-error');
    error.hidden = true;
    scroll.append(error, img);
    const note = el('p', 'screen-note');
    root.append(bar, scroll, note);
    document.body.appendChild(root);
    return { root, auto, zoom, scroll, img, error, note };
  }

  function paint() {
    ui.auto.textContent = state.auto ? 'Auto: on' : 'Auto: off';
    ui.zoom.textContent = state.zoom ? 'Fit' : 'Zoom';
    ui.img.classList.toggle('zoom', state.zoom);
  }

  async function capture() {
    if (state.busy || !state.open) return;
    state.busy = true;
    try {
      const res = await fetch('/api/screen', { headers: { 'x-pocket-dev': '1' }, cache: 'no-store' });
      if (res.status === 401) return location.replace('/login.html');
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      ui.img.src = url;
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = url;
      ui.error.hidden = true;
      ui.note.textContent = `Updated ${new Date().toLocaleTimeString()}. If you only see the wallpaper, allow Screen Recording for node on the Mac (Admin page → Permissions).`;
    } catch (err) {
      ui.error.textContent = err.message;
      ui.error.hidden = false;
    } finally {
      state.busy = false;
    }
  }

  function schedule() {
    clearInterval(state.timer);
    if (state.auto) state.timer = setInterval(() => { if (!document.hidden) capture(); }, AUTO_MS);
  }

  function closeSheet() {
    clearInterval(state.timer);
    state.open = false;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = null;
    ui.root.hidden = true;
  }

  window.openScreenSheet = () => {
    if (state.open) return;
    document.activeElement?.blur();
    ui ??= build();
    ui.root.hidden = false;
    ui.img.removeAttribute('src');
    ui.note.textContent = '';
    state.open = true;
    overlays.open('screen', closeSheet);
    paint();
    capture();
    schedule();
  };
})();
