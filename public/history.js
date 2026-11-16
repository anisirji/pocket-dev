(() => {
  const TOOLS = { claude: 'Claude', codex: 'Codex' };
  const FILTERS = [['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex']];
  const OPEN_BADGE = { mac: 'open on Mac', 'pocket-dev': 'open in Pocket Dev' };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const { api } = window;
  const { overlays } = window.pocketDev;

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  const msgs = (n) => `${n} msg${n === 1 ? '' : 's'}`;
  const shortPath = (p) => (p.length > 36 ? `…/${p.split('/').slice(-2).join('/')}` : p);
  const badge = (tool) => el('span', `hist-badge ${tool}`, TOOLS[tool]);

  // Text with ``` fences becomes alternating plain runs and <pre> blocks.
  function richText(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (!part) return;
      frag.appendChild(i % 2 ? el('pre', 'hist-code', part.replace(/\n$/, '')) : el('span', null, part));
    });
    return frag;
  }

  const sheet = el('div', 'hist');
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="hist-head">
      <button class="hist-icon hist-back" aria-label="Back">‹</button>
      <div class="hist-heading"></div>
      <button class="hist-icon hist-refresh" aria-label="Refresh"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
      <button class="hist-icon hist-close" aria-label="Close">✕</button>
    </div>
    <div class="hist-chips"></div>
    <div class="hist-list hist-scroll"></div>
    <div class="hist-detail hist-scroll" hidden></div>
    <div class="hist-foot" hidden>
      <p class="hist-warn" role="alert" hidden></p>
      <button class="hist-fix" hidden></button>
      <div class="hist-actions">
        <button class="hist-continue hist-in-terminal">Continue in terminal</button>
        <button class="hist-continue hist-in-chat">Continue in chat</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  const q = (sel) => sheet.querySelector(sel);
  const ui = {
    back: q('.hist-back'), heading: q('.hist-heading'), refresh: q('.hist-refresh'), close: q('.hist-close'),
    chips: q('.hist-chips'), list: q('.hist-list'), detail: q('.hist-detail'), foot: q('.hist-foot'),
    warn: q('.hist-warn'), fix: q('.hist-fix'), actions: q('.hist-actions'), go: q('.hist-in-terminal'), chat: q('.hist-in-chat'),
  };

  let filter = 'all';
  let listSeq = 0;
  let current = null;
  let detailSeq = 0;

  function setMode(mode) {
    const detail = mode === 'detail';
    ui.back.hidden = !detail;
    ui.refresh.hidden = detail;
    ui.chips.hidden = detail;
    ui.list.hidden = detail;
    ui.detail.hidden = !detail;
    ui.foot.hidden = !detail;
    ui.heading.replaceChildren(detail && current ? headingFor(current) : el('h2', null, 'Resume'));
  }

  function headingFor(item) {
    const wrap = el('div', 'hist-heading-item');
    wrap.append(badge(item.tool), el('span', 'hist-project', item.project || item.id.slice(0, 8)));
    return wrap;
  }

  function renderChips() {
    ui.chips.replaceChildren(...FILTERS.map(([key, label]) => {
      const chip = el('button', `hist-chip${key === filter ? ' on' : ''}`, label);
      chip.onclick = () => {
        if (filter === key) return;
        filter = key;
        renderChips();
        loadList();
      };
      return chip;
    }));
  }

  function status(container, text, retry) {
    const box = el('div', 'hist-status', text);
    if (retry) {
      const btn = el('button', 'hist-retry', 'Try again');
      btn.onclick = retry;
      box.append(btn);
    }
    container.replaceChildren(box);
  }

  function card(item) {
    const node = el('button', 'hist-card');
    const top = el('div', 'hist-card-top');
    top.append(badge(item.tool), el('span', 'hist-project', item.project || '—'));
    if (item.live) top.append(el('span', 'hist-live', OPEN_BADGE[item.openIn] ?? 'open on Mac?'));
    node.append(top, el('div', 'hist-title', item.title), el('div', 'hist-meta', `${ago(item.lastActive)} · ${msgs(item.messageCount)}`));
    node.onclick = () => openDetail(item);
    return node;
  }

  async function loadList() {
    const seq = ++listSeq;
    if (!ui.list.querySelector('.hist-card')) status(ui.list, 'Loading conversations…');
    ui.refresh.classList.add('spin');
    try {
      const items = await api('GET', `/api/history?limit=30&tool=${filter}`);
      if (seq !== listSeq) return;
      if (!items.length) {
        const where = filter === 'all' ? '~/.claude or ~/.codex' : filter === 'claude' ? '~/.claude' : '~/.codex';
        status(ui.list, `No conversations found in ${where} on this device.`);
      } else {
        ui.list.replaceChildren(...items.map(card));
      }
    } catch (err) {
      if (seq === listSeq) status(ui.list, `Could not load conversations: ${err.message}`, loadList);
    } finally {
      if (seq === listSeq) ui.refresh.classList.remove('spin');
    }
  }

  function bubble(m) {
    const node = el('div', `hist-msg ${m.role}`);
    node.append(m.role === 'tool' ? document.createTextNode(m.text) : richText(m.text));
    return node;
  }

  async function loadDetail(item) {
    const seq = ++detailSeq;
    status(ui.detail, 'Loading conversation…');
    try {
      const data = await api('GET', `/api/history/${item.tool}/${encodeURIComponent(item.id)}`);
      if (seq !== detailSeq) return;
      current = { ...item, ...data };
      const title = el('div', 'hist-detail-title', current.title);
      const meta = el('div', 'hist-meta', [current.cwd && shortPath(current.cwd), ago(current.lastActive), msgs(current.messageCount)].filter(Boolean).join(' · '));
      const shown = current.messages.filter((m) => m.role !== 'tool').length;
      const older = current.messageCount > shown ? [el('div', 'hist-older', `Latest ${shown} of ${msgs(current.messageCount)}`)] : [];
      ui.detail.replaceChildren(title, meta, ...older, ...current.messages.map(bubble));
      ui.detail.scrollTop = ui.detail.scrollHeight;
    } catch (err) {
      if (seq === detailSeq) status(ui.detail, `Could not open this conversation: ${err.message}`, () => loadDetail(item));
    }
  }

  // The list and the detail are two overlay levels, so Android's back gesture steps from the detail to the list and
  // then out of the sheet.
  function open() {
    document.activeElement?.blur();
    if (!sheet.hidden) return;
    overlays.open('resume', () => {
      sheet.hidden = true;
      detailSeq++;
    });
    sheet.hidden = false;
    current = null;
    setMode('list');
    renderChips();
    loadList();
  }

  // A live conversation has a writer somewhere else. Opening it here closes that copy first, so only one program ever
  // writes the conversation's file. The list's badge already says where it is open.
  function setLabels() {
    ui.go.textContent = 'Open here in terminal';
    ui.chat.textContent = 'Open here in chat';
  }

  function clearFailure() {
    ui.warn.hidden = ui.fix.hidden = true;
    ui.fix.onclick = null;
  }

  function lock(button, text) {
    ui.go.disabled = ui.chat.disabled = ui.fix.disabled = true;
    button.textContent = text;
  }

  function unlock() {
    ui.go.disabled = ui.chat.disabled = ui.fix.disabled = false;
    setLabels();
  }

  function openDetail(item) {
    current = item;
    overlays.open('resume-detail', () => setMode('list'));
    clearFailure();
    unlock();
    setMode('detail');
    loadDetail(item);
  }

  const leave = () => overlays.close('resume');

  function toast(text) {
    const node = el('div', 'hist-toast', text);
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 6000);
  }

  // Both buttons leave the sheet for the new terminal or chat; `start` resolves to a toast note or nothing.
  // `leaveFirst` closes the sheet before `start`, for a start that opens its own overlays: closing the sheet later
  // would close them too. `done` is said first in the toast, for a take over that closed another copy.
  async function continueWith(button, start, leaveFirst = false, done = '') {
    if (!current) return;
    clearFailure();
    lock(button, done ? 'Continuing…' : 'Starting…');
    if (leaveFirst) leave();
    try {
      const note = await start(current);
      if (!leaveFirst) leave();
      document.activeElement?.blur();
      if (done || note) toast([done, note].filter(Boolean).join(' '));
    } catch (err) {
      unlock();
      toast(`${done ? `${done} ` : ''}Could not resume: ${err.message}`);
    }
  }

  // The take over route answers 409 with a reason (`code`) the sheet acts on, so it is read here rather than through
  // api(), which keeps only the message.
  async function takeoverRequest(item, body) {
    const res = await fetch(`/api/history/${item.tool}/${encodeURIComponent(item.id)}/takeover`, {
      method: 'POST', headers: { 'x-pocket-dev': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || data.blocked || data.pending) {
      location.replace('/login.html');
      throw new Error(data.error || 'Not logged in');
    }
    return { ok: res.ok, data };
  }

  const START = {
    async terminal(item) {
      const view = await api('POST', `/api/history/${item.tool}/${encodeURIComponent(item.id)}/resume`);
      window.pocketDev.openSession(view);
      return view.note;
    },
    async chat(item) {
      if (!item.cwd) throw new Error('this conversation has no folder on record');
      await window.pocketDevChat.startFromSession({ tool: item.tool, id: item.id, cwd: item.cwd, title: item.title });
    },
  };
  const buttonFor = (where) => (where === 'chat' ? ui.chat : ui.go);
  const continueIn = (where, done) => continueWith(buttonFor(where), START[where], where === 'chat', done);

  // A fix the server's answer allows: force quit a program that ignored the request to stop, or continue without a take
  // over when no program could be found. Each warns before it acts.
  function offerFix(label, warning, action) {
    ui.fix.textContent = label;
    ui.fix.hidden = false;
    ui.fix.onclick = () => { if (confirm(warning)) action(); };
  }

  async function takeOver(where, body = {}) {
    const button = buttonFor(where);
    clearFailure();
    lock(button, 'Stopping…');
    let r;
    try {
      r = await takeoverRequest(current, body);
    } catch (err) {
      r = { ok: false, data: { error: err.message } };
    }
    if (r.ok) {
      // Nothing else has it open now, so if continuing fails, trying again just continues.
      current = { ...current, live: false, copies: [] };
      const closed = r.data.stopped.map((s) => s.label).join(', ');
      return continueIn(where, closed && `Closed ${closed}.`);
    }
    unlock();
    if (r.data.code === 'busy' && !body.confirmBusy) {
      if (confirm(r.data.error)) takeOver(where, { ...body, confirmBusy: true });
      return;
    }
    ui.warn.textContent = r.data.error || 'Could not open this conversation here.';
    ui.warn.hidden = false;
    if (r.data.code === 'still-running' && r.data.canForce) {
      offerFix(`Force quit and open here in ${where}`, 'Force quit ends it at once. Anything it has not saved, including a reply it is writing, is lost.',
        () => takeOver(where, { ...body, confirmBusy: true, force: true }));
    } else if (r.data.code === 'not-found') {
      offerFix(`Open here in ${where} anyway`, 'If it is still open on the Mac, both copies write to this conversation and can damage it.',
        () => continueIn(where));
    }
  }

  // A live conversation is closed where it is open, then opened here. The server asks for one yes, and only when that
  // copy is in the middle of a reply.
  function choose(where) {
    if (!current) return;
    if (!current.live) return continueIn(where);
    takeOver(where);
  }

  ui.go.onclick = () => choose('terminal');
  ui.chat.onclick = () => choose('chat');
  ui.back.onclick = () => overlays.close('resume-detail');
  ui.close.onclick = leave;
  ui.refresh.onclick = loadList;
  document.getElementById('resumeBtn').addEventListener('click', open);

  // "Continue on Mac" in the More menu: closes Pocket Dev's copy of the chat or terminal on screen, then shows the command
  // that resumes it on the Mac. The command is plain text to select; nothing is copied to the clipboard.
  function showMacCommand(r) {
    const card = el('div', 'hist-mac');
    const box = el('div', 'hist-mac-box');
    const lines = [r.cwd && `cd ${r.cwd}`, r.command].filter(Boolean).join('\n');
    const closed = r.stopped.map((s) => s.label).join(', ');
    const done = () => { card.remove(); overlays.close('mac-command'); };
    box.append(
      el('strong', null, 'Ready on your Mac'),
      el('p', null, `${closed ? `Closed ${closed}. ` : ''}Open a terminal on your Mac and run:`),
      el('pre', 'hist-mac-cmd', lines),
      el('p', 'hist-mac-hint', 'Touch the command to select it. Opening this conversation here again closes the Mac copy.'),
    );
    const ok = el('button', 'hist-continue', 'Done');
    ok.onclick = done;
    box.append(ok);
    card.append(box);
    card.onclick = (e) => { if (e.target === card) done(); };
    document.body.appendChild(card);
    overlays.open('mac-command', () => card.remove());
  }

  async function continueOnMac(confirmBusy = false) {
    const view = window.pocketDev.view();
    const chat = view === 'chat' ? window.pocketDevChat.currentSession() : null;
    const body = view === 'terminal' ? { terminalId: window.pocketDev.activeSession() } : chat;
    if (!body?.terminalId && !body?.id) return toast(view === 'chat' ? 'Send a message first, then continue on your Mac.' : 'Open a chat or terminal first.');
    const res = await fetch('/api/history/mac', {
      method: 'POST', headers: { 'x-pocket-dev': '1', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(confirmBusy && { confirmBusy }) }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({})) ?? {};
    if (res?.status === 401 || data.blocked || data.pending) return location.replace('/login.html');
    if (res?.ok) return showMacCommand(data);
    if (data.code === 'busy' && !confirmBusy) return confirm(data.error) && continueOnMac(true);
    toast(data.error || 'Could not continue on your Mac.');
  }
  document.getElementById('macBtn').addEventListener('click', () => continueOnMac());
})();
