(() => {
  const { overlays } = window.pocketDev;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  let ui, open = false, session = null, generation = 0, timer, supportTimer, controller, imageUrl, latestFrame, previousFocus;

  async function request(path, body, extra = {}) {
    const res = await fetch(`/api/camera${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'x-pocket-dev': '1', ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }), ...extra,
    });
    if (res.status === 401) location.replace('/login.html');
    if (res.status === 202) throw new Error((await res.json()).message || 'Camera start proposed. After approval, tap Start camera again.');
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    return res;
  }
  const release = (id) => request('/stop', { id }, { keepalive: true }).catch(() => {});
  function error(message) { ui.error.textContent = message; ui.error.hidden = !message; }
  function clearImage() {
    latestFrame = null;
    ui.snapshot.disabled = true;
    ui.image.hidden = true;
    ui.image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
  }
  function stop(message = 'Camera stopped.') {
    const focusStart = ui && [ui.stop, ui.snapshot].includes(document.activeElement);
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    if (session) release(session);
    session = null;
    if (!ui) return;
    clearImage();
    ui.select.disabled = !ui.select.options.length;
    ui.start.disabled = !ui.select.options.length;
    ui.start.textContent = 'Start camera';
    ui.stop.disabled = true;
    ui.status.textContent = message;
    if (focusStart && open && !ui.start.disabled) ui.start.focus();
  }
  async function frame(run) {
    if (run !== generation || !session || !open) return;
    controller = new AbortController();
    try {
      const res = await request(`/frame?id=${encodeURIComponent(session)}`, undefined, { signal: controller.signal });
      const blob = await res.blob();
      if (run !== generation) return;
      const old = imageUrl;
      latestFrame = blob;
      imageUrl = URL.createObjectURL(blob);
      ui.image.src = imageUrl;
      ui.image.hidden = false;
      ui.snapshot.disabled = false;
      if (old) URL.revokeObjectURL(old);
      ui.status.textContent = 'Live · Camera is on';
      timer = setTimeout(() => frame(run), 200);
    } catch (err) {
      if (run !== generation) return;
      stop();
      error(err.message);
    }
  }
  function snapshot() {
    if (!open || !session || !latestFrame) return;
    // A separate URL lets the download finish while preview frames continue to change.
    const url = URL.createObjectURL(latestFrame);
    const link = el('a');
    link.href = url;
    link.download = `pocket-dev-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function start() {
    if (!open || document.hidden) return;
    stop('Starting camera. Check the computer for a permission prompt.');
    error('');
    const run = generation;
    controller = new AbortController();
    ui.start.disabled = ui.select.disabled = true;
    ui.stop.disabled = false;
    ui.start.textContent = 'Starting…';
    ui.stop.focus();
    try {
      const data = await (await request('/start', { camera: ui.select.value }, { signal: controller.signal })).json();
      if (run !== generation) { release(data.id); return; }
      session = data.id;
      ui.start.textContent = 'Camera on';
      frame(run);
    } catch (err) {
      if (run !== generation) return;
      stop(); error(err.message);
    }
  }
  function paintSupport(data) {
    ui.setup.hidden = data.available;
    ui.install.disabled = data.state === 'installing' || !data.canInstall;
    ui.install.hidden = !data.canInstall;
    ui.install.textContent = data.state === 'installing' ? 'Installing…' : data.state === 'error' ? 'Retry installation' : 'Install camera support';
    ui.setupMessage.textContent = data.message;
    ui.progress.hidden = data.state !== 'installing';
    if (data.state === 'installing' && data.totalBytes) {
      ui.progress.value = data.receivedBytes / data.totalBytes;
      ui.setupMessage.textContent += ` ${Math.round(data.receivedBytes / data.totalBytes * 100)}%`;
    } else ui.progress.removeAttribute('value');
    ui.status.textContent = data.state === 'installing' ? 'Installing camera support on the computer…' : 'Camera support is needed before starting the camera.';
  }
  async function loadSupport(run) {
    clearTimeout(supportTimer);
    try {
      const data = await (await request('/support')).json();
      if (run !== generation || !open) return;
      paintSupport(data);
      if (data.state === 'installing') { supportTimer = setTimeout(() => loadSupport(run), 1000); return; }
      if (!data.available) return;
      ui.status.textContent = 'Looking for cameras on the computer…';
      const devices = await (await request('')).json();
      if (run !== generation || !open) return;
      ui.select.replaceChildren();
      for (const camera of devices.cameras) {
        const option = el('option', null, camera.name); option.value = camera.id; ui.select.append(option);
      }
      stop(devices.cameras.length ? 'Choose a camera, then tap Start camera.' : 'No cameras found. Connect a camera and reopen this view.');
    } catch (err) {
      if (run !== generation || !open) return;
      stop('Camera unavailable.'); error(err.message);
    }
  }
  async function installSupport() {
    const run = generation;
    error('');
    ui.install.disabled = true;
    ui.install.textContent = 'Installing…';
    ui.close.focus();
    try {
      await request('/install', {});
      if (run !== generation || !open) return;
      await loadSupport(run);
    } catch (err) {
      if (run !== generation || !open) return;
      ui.install.disabled = false;
      ui.install.textContent = 'Retry installation';
      error(err.message);
    }
  }
  function build() {
    const root = el('section', 'camera-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Device camera');
    const bar = el('div', 'camera-bar');
    const close = el('button', 'camera-btn', 'Close');
    close.type = 'button';
    close.onclick = () => overlays.close('camera');
    bar.append(el('h2', null, 'Device camera'), close);
    const controls = el('div', 'camera-controls');
    const select = el('select', 'camera-select');
    select.setAttribute('aria-label', 'Camera on the computer');
    const startBtn = el('button', 'camera-btn start', 'Start camera');
    const stopBtn = el('button', 'camera-btn', 'Stop');
    const snapshotBtn = el('button', 'camera-btn', 'Snapshot');
    startBtn.type = stopBtn.type = snapshotBtn.type = 'button';
    startBtn.onclick = start;
    stopBtn.onclick = () => stop();
    snapshotBtn.onclick = snapshot;
    snapshotBtn.disabled = true;
    controls.append(select, startBtn, stopBtn, snapshotBtn);
    const setup = el('div', 'camera-setup');
    setup.hidden = true;
    const setupMessage = el('p');
    setupMessage.setAttribute('role', 'status');
    const install = el('button', 'camera-btn start', 'Install camera support');
    install.type = 'button'; install.onclick = installSupport;
    const progress = el('progress');
    progress.max = 1; progress.hidden = true;
    progress.setAttribute('aria-label', 'Camera support download');
    setup.append(setupMessage, el('p', 'camera-setup-note', 'Downloads a camera helper to this computer. No administrator access required.'), progress, install);
    const status = el('p', 'camera-status');
    status.setAttribute('role', 'status');
    const err = el('p', 'camera-error');
    err.setAttribute('role', 'alert'); err.hidden = true;
    const preview = el('div', 'camera-preview');
    const image = el('img', 'camera-image');
    image.alt = 'Live view from the computer camera'; image.hidden = true;
    preview.append(image);
    root.append(bar, setup, controls, status, err, preview, el('p', 'camera-note', 'Video only. Snapshot saves the current image to your device. Closing this view or leaving the page stops this preview.'));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); overlays.close('camera'); }
      if (event.key !== 'Tab') return;
      const buttons = [...root.querySelectorAll('button, select')].filter((n) => !n.disabled && n.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.append(root);
    return { root, select, start: startBtn, stop: stopBtn, snapshot: snapshotBtn, status, error: err, image, close, setup, setupMessage, install, progress };
  }
  window.openCameraSheet = async () => {
    if (open) return;
    previousFocus = document.activeElement;
    previousFocus?.blur();
    ui ??= build();
    ui.root.hidden = false;
    open = true;
    ui.select.replaceChildren();
    ui.setup.hidden = true;
    stop('Looking for cameras on the computer…');
    error('');
    const run = generation;
    overlays.open('camera', () => {
      clearTimeout(supportTimer);
      open = false; stop(); ui.root.hidden = true; previousFocus?.focus();
    });
    ui.close.focus();
    await loadSupport(run);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && open && !ui.stop.disabled) stop('Preview paused. Tap Start camera to resume.'); });
  window.addEventListener('pagehide', () => { if (open) stop(); });
})();
