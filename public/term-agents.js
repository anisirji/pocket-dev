// The helper agents of the Claude Code session in the open terminal tab, as a collapsible strip above the terminal. It
// looks like the agents panel in Chat and shows while an agent is running, and for a short while after the last one ends.
(() => {
  const POLL_MS = 5000;
  const REQUEST_MS = 8000;
  const LINGER_MS = 30_000;
  const SHOWN = 6;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const strip = el('section', 'chat-work term-agents');
  strip.id = 'termAgents';
  strip.hidden = true;
  strip.setAttribute('aria-label', 'Agents in this terminal');
  let open = false;
  let timer = null;
  let request = null;
  let lastRunningAt = 0;
  let agents = [];
  let paintedKey = '';
  let shownFor = null;

  const status = (a) => (a.status === 'running' ? 'running' : a.status === 'completed' ? 'completed' : 'failed');
  const icon = (a) => (a.status === 'running' ? el('span', 'chat-spin') : a.status === 'completed' ? el('span', 'chat-ok', '✓')
    : a.status === 'stopped' ? el('span', 'chat-stopped', 'stopped') : el('span', 'chat-bad', '✗'));

  function paint() {
    const running = agents.filter((a) => a.status === 'running');
    if (running.length) lastRunningAt = Date.now();
    const show = agents.length > 0 && (running.length > 0 || Date.now() - lastRunningAt < LINGER_MS);
    const key = JSON.stringify([show, open, agents.map((a) => [a.id, a.status, a.latest])]);
    if (key === paintedKey) return;
    paintedKey = key;
    strip.hidden = !show;
    if (!show) return;
    const title = running.length ? `${running.length} ${running.length === 1 ? 'agent' : 'agents'} running`
      : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} finished`;
    const head = el('button', 'chat-work-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(running.length ? el('span', 'chat-spin') : el('span', 'chat-work-dot'), el('span', 'chat-work-title', title), el('span', 'chat-work-caret', open ? '▾' : '▸'));
    head.onclick = () => { open = !open; paintedKey = ''; paint(); };
    const body = el('div', 'chat-work-body');
    body.hidden = !open;
    for (const a of agents.slice(-SHOWN)) {
      const row = el('div', `chat-work-row chat-work-${status(a)}`);
      row.append(icon(a), el('span', 'chat-work-name', a.label));
      if (a.latest) row.append(el('span', 'chat-work-latest', a.latest));
      body.append(row);
    }
    strip.replaceChildren(head, body);
  }

  function clear() {
    agents = [];
    lastRunningAt = 0;
    paint();
  }

  async function poll() {
    clearTimeout(timer);
    const terminalId = window.pocketDev?.activeSession?.();
    if (terminalId !== shownFor) { shownFor = terminalId ?? null; clear(); }
    const visible = !document.hidden && window.pocketDev?.view?.() === 'terminal' && terminalId;
    if (!visible) {
      if (!document.hidden) clear();
    } else {
      const controller = new AbortController();
      const mine = request = controller;
      const abort = setTimeout(() => controller.abort(), REQUEST_MS);
      try {
        const res = await fetch(`/api/history/agents?terminalId=${encodeURIComponent(terminalId)}`, { cache: 'no-store', signal: controller.signal });
        if (request === mine) {
          if (res.ok && window.pocketDev?.activeSession?.() === terminalId) agents = (await res.json()).agents || [];
          else agents = [];
          paint();
        }
      } catch {
        // A lost connection keeps what is shown; the next poll tries again.
      } finally {
        clearTimeout(abort);
      }
    }
    if (!document.hidden) timer = setTimeout(poll, POLL_MS);
  }

  function start() {
    const terms = document.getElementById('terms');
    if (!terms) return;
    terms.before(strip);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else poll(); });
    window.addEventListener('pageshow', poll);
    poll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
