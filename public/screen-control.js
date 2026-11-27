(() => {
  const make = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; };
  window.PocketScreenControl = { mount({ image, toolbar, root, display, capture, changed }) {
    let socket, requestId, timer, heartbeat, generation = 0, active = false, sequence = 0, offset = 0, lastMove = 0, lastScroll = 0, disposed = false;
    const pointers = new Map(); let scrollGesture = false, centroid;
    const button = make('button', 'Control'); button.type = 'button'; button.className = 'screen-btn'; button.setAttribute('aria-pressed', 'false');
    toolbar.append(button);
    const note = make('p'); note.className = 'screen-control-note'; note.hidden = true; note.setAttribute('role', 'status');
    const form = make('form'); form.className = 'screen-control-input'; form.hidden = true;
    const input = make('input'); input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false; input.placeholder = 'Type on the Mac'; input.setAttribute('aria-label', 'Text to type on the Mac');
    const sendText = make('button', 'Send text'); sendText.type = 'submit';
    form.append(input, sendText);
    for (const [label, key, modifiers] of [['Tab', 'Tab', []], ['Enter', 'Enter', []], ['Esc', 'Escape', []], ['Switch app', 'Tab', ['command']]]) {
      const keyButton = make('button', label); keyButton.type = 'button'; keyButton.onclick = () => send({ kind: 'key', key, modifiers }); form.append(keyButton);
    }
    toolbar.after(note, form);
    const api = async (method, path, body, keepalive = false) => {
      const response = await fetch(`/api/screen/control${path}`, { method, cache: 'no-store', keepalive, headers: { 'x-pocket-dev': '1', ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Desktop control is unavailable.'); return data;
    };
    const message = (text) => { note.textContent = text; note.hidden = !text; };
    function reset(text) {
      generation++; clearTimeout(timer); clearInterval(heartbeat); const old = socket; socket = null; old?.close();
      active = false; pointers.clear(); scrollGesture = false; centroid = null; input.value = ''; form.hidden = true; image.removeAttribute('tabindex'); image.classList.remove('controlling');
      button.disabled = false; button.textContent = 'Control'; button.setAttribute('aria-pressed', 'false'); message(text || ''); changed(false);
    }
    function close() {
      const id = requestId; requestId = null; reset();
      if (id) api('DELETE', '', { requestId: id }, true).catch(() => {});
    }
    async function poll(run) {
      if (disposed || run !== generation || document.hidden || !requestId) return;
      try {
        const state = await api('GET', ''); if (run !== generation) return;
        if (state.requestId !== requestId || state.state === 'off') { requestId = null; reset('Control ended. Request it again to continue.'); return; }
        if (state.token && !socket) {
          const connection = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/screen-control?token=${state.token}`);
          connection.onmessage = ({ data }) => {
            if (socket !== connection) return;
            let event; try { event = JSON.parse(data); } catch { return close(); }
            if (event.t === 'ready') {
              offset = event.now - Date.now(); sequence = 0; active = true; button.disabled = false; button.textContent = 'Stop control'; button.setAttribute('aria-pressed', 'true'); form.hidden = false; image.tabIndex = 0; image.classList.add('controlling'); changed(true);
              message('Control is on. Tap to click, move the pointer, or use two fingers to scroll. macOS authorization dialogs require local interaction.');
              heartbeat = setInterval(() => { if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ t: 'ping' })); }, 2000);
            } else if (event.t === 'ack') capture();
            else if (event.t === 'stopped') { requestId = null; reset(event.message); }
          };
          connection.onclose = () => { if (socket === connection) { requestId = null; reset('The control connection closed. Request control again; inputs were not replayed.'); } };
          connection.onerror = () => { if (socket === connection) close(); };
        }
        if (!active) timer = setTimeout(() => poll(run), 1500);
      } catch (error) { close(); message(error.message); }
    }
    button.onclick = async () => {
      if (requestId || active) return close();
      const run = ++generation; button.disabled = true; message('Checking Mac control permissions…');
      try {
        const support = await api('GET', '/support'); if (run !== generation) return;
        if (!support.available) throw new Error(support.message);
        const pending = await api('POST', '', { display: display() });
        if (run !== generation || disposed || document.hidden) { api('DELETE', '', { requestId: pending.requestId }, true).catch(() => {}); return; }
        requestId = pending.requestId; button.disabled = false; button.textContent = 'Cancel request'; message(pending.remembered ? 'Using this computer’s saved control approval…' : 'Waiting for one-time approval in Pocket Dev Admin on the Mac.'); poll(run);
      } catch (error) { if (run === generation) { reset(error.message); } }
    };
    function send(event) {
      if (!active || document.hidden || socket?.readyState !== WebSocket.OPEN) return;
      if (event.kind === 'move' && performance.now() - lastMove < 70) return;
      if (event.kind === 'move') lastMove = performance.now();
      if (event.kind === 'scroll' && performance.now() - lastScroll < 50) return;
      if (event.kind === 'scroll') lastScroll = performance.now();
      socket.send(JSON.stringify({ t: 'input', seq: ++sequence, at: Date.now() + offset, event }));
    }
    form.onsubmit = (event) => { event.preventDefault(); if (input.value) { send({ kind: 'text', text: input.value }); input.value = ''; } };
    const point = (event) => { const rect = image.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
    image.addEventListener('pointerdown', (event) => { if (!active || ![0, 2].includes(event.button)) return; event.preventDefault(); image.focus({ preventScroll: true }); image.setPointerCapture(event.pointerId); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY }); if (pointers.size > 1) { scrollGesture = true; centroid = null; } });
    image.addEventListener('pointermove', (event) => {
      if (!active) return;
      const pointer = pointers.get(event.pointerId); if (pointer) { pointer.x = event.clientX; pointer.y = event.clientY; }
      if (pointers.size === 2) {
        const points = [...pointers.values()], next = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        if (centroid) send({ kind: 'scroll', ...point(event), dx: Math.max(-600, Math.min(600, (centroid.x - next.x) * 2)), dy: Math.max(-600, Math.min(600, (centroid.y - next.y) * 2)) }); centroid = next;
      } else if (!scrollGesture) send({ kind: 'move', ...point(event) });
    });
    image.addEventListener('pointerup', (event) => { const pointer = pointers.get(event.pointerId); if (active && pointer && !scrollGesture && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 8) send({ kind: 'click', ...point(event), button: event.button === 2 ? 'right' : 'left' }); pointers.delete(event.pointerId); if (!pointers.size) { scrollGesture = false; centroid = null; } });
    image.addEventListener('pointercancel', () => { pointers.clear(); scrollGesture = false; centroid = null; });
    image.addEventListener('wheel', (event) => { if (!active) return; event.preventDefault(); send({ kind: 'scroll', ...point(event), dx: Math.max(-600, Math.min(600, event.deltaX)), dy: Math.max(-600, Math.min(600, event.deltaY)) }); }, { passive: false });
    image.addEventListener('contextmenu', (event) => { if (active) event.preventDefault(); });
    image.addEventListener('keydown', (event) => {
      if (!active || event.isComposing) return;
      const modifiers = [['shiftKey', 'shift'], ['ctrlKey', 'control'], ['altKey', 'alt'], ['metaKey', 'command']].filter(([key]) => event[key]).map(([, value]) => value);
      let command;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) command = { kind: 'text', text: event.key };
      else { const key = /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key; if (/^[A-Z0-9]$/.test(key) || ['Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(key)) command = { kind: 'key', key, modifiers }; }
      if (command) { event.preventDefault(); event.stopPropagation(); send(command); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && (active || requestId)) close(); });
    window.addEventListener('pagehide', close);
    return { close, active: () => active, dispose() { disposed = true; close(); } };
  } };
})();
