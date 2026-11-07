(() => {
  const TOOLS = { claude: 'Claude', codex: 'Codex' };
  const FILTERS = [['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex']];
  const LIVE_WARNING = 'This conversation may still be open on your laptop. Close it there first, or both will write to it.';

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
      <p class="hist-warn" hidden></p>
      <button class="hist-continue">Continue on phone</button>
    </div>`;
  document.body.appendChild(sheet);
  const q = (sel) => sheet.querySelector(sel);
  const ui = {
    back: q('.hist-back'), heading: q('.hist-heading'), refresh: q('.hist-refresh'), close: q('.hist-close'),
    chips: q('.hist-chips'), list: q('.hist-list'), detail: q('.hist-detail'), foot: q('.hist-foot'),
    warn: q('.hist-warn'), go: q('.hist-continue'),
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
    if (item.live) top.append(el('span', 'hist-live', 'open on laptop?'));
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
        status(ui.list, `No conversations found in ${where} on this Mac.`);
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
    ui.warn.hidden = !item.live;
    ui.warn.textContent = LIVE_WARNING;
    try {
      const data = await api('GET', `/api/history/${item.tool}/${encodeURIComponent(item.id)}`);
      if (seq !== detailSeq) return;
      current = { ...item, ...data };
      ui.warn.hidden = !current.live;
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

  function openDetail(item) {
    current = item;
    overlays.open('resume-detail', () => setMode('list'));
    ui.go.disabled = false;
    ui.go.textContent = 'Continue on phone';
    setMode('detail');
    loadDetail(item);
  }

  const leave = () => overlays.close('resume');

  function toast(text) {
    const node = el('div', 'hist-toast', text);
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 6000);
  }

  ui.go.onclick = async () => {
    if (!current) return;
    ui.go.disabled = true;
    ui.go.textContent = 'Starting…';
    try {
      const view = await api('POST', `/api/history/${current.tool}/${encodeURIComponent(current.id)}/resume`);
      leave();
      window.pocketDev.openSession(view);
      document.activeElement?.blur();
      if (view.note) toast(view.note);
    } catch (err) {
      ui.go.disabled = false;
      ui.go.textContent = 'Continue on phone';
      toast(`Could not resume: ${err.message}`);
    }
  };

  ui.back.onclick = () => overlays.close('resume-detail');
  ui.close.onclick = leave;
  ui.refresh.onclick = loadList;
  document.getElementById('resumeBtn').addEventListener('click', open);
})();
