// Settings section and top-bar battery pill for keeping the Mac awake.
// `api(method, url, body)` is index.html's fetch helper: resolves to parsed JSON, throws Error(message).

const MODES = [
  { id: 'off', label: 'Off', hint: 'Your Mac sleeps on its normal schedule.' },
  { id: 'plugged', label: 'When plugged in', hint: 'Awake on the charger, normal sleep on battery.' },
  { id: 'always', label: 'Always', hint: 'Awake on battery too. Drains the battery.' },
];
const SECTION_POLL_MS = 15_000;
const BADGE_POLL_MS = 60_000;
const LOW_BATTERY = 20;

const CSS = `
  .pw { display: grid; gap: 10px; color: var(--text, #d7dce5); }
  .pw-title { margin: 0; font-size: 15px; font-weight: 600; }
  .pw-seg { display: flex; padding: 3px; gap: 3px; border-radius: 10px; background: var(--bg, #0b0e14); border: 1px solid var(--line, #252d3c); }
  .pw-seg button { flex: 1 1 auto; height: 36px; padding: 0 4px; border-radius: 7px; color: var(--muted, #7d8799); font-size: 13px; white-space: nowrap; }
  .pw-seg button[aria-checked="true"] { background: var(--panel-2, #1b2130); color: var(--text, #d7dce5); box-shadow: inset 0 0 0 1px var(--accent, #6aa9ff); font-weight: 600; }
  .pw-seg button:disabled { opacity: .6; }
  .pw-hint, .pw-sub { margin: 0; color: var(--muted, #7d8799); font-size: 13px; }
  .pw-status { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; }
  .pw-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #7d8799); }
  .pw-status.awake .pw-dot { background: #7ee787; }
  .pw-err { margin: 0; color: var(--danger, #ff7b72); font-size: 13px; }
  .pw-err:empty { display: none; }
  .pw-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding-top: 10px; border-top: 1px solid var(--line, #252d3c); }
  .pw-row b { font-weight: 500; }
  .pw-row .pw-val { color: var(--muted, #7d8799); }
  .pw-row .pw-val.on { color: #f0c674; }
  .pw-row .pw-sub { grid-column: 1 / -1; }
  .pw-row code { white-space: nowrap; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; color: var(--text, #d7dce5); }
  .pw-badge { flex: none; height: 36px; max-width: 64px; padding: 0 8px; border-radius: 8px; background: var(--bg, #0b0e14); border: 1px solid var(--line, #252d3c); color: var(--text, #d7dce5); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pw-badge.low { border-color: var(--danger, #ff7b72); color: var(--danger, #ff7b72); }
`;

function injectCss() {
  if (document.getElementById('pw-css')) return;
  const style = document.createElement('style');
  style.id = 'pw-css';
  style.textContent = CSS;
  document.head.append(style);
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// Runs fn now and every ms until the node leaves the page.
function pollWhileMounted(node, ms, fn) {
  fn();
  const timer = setInterval(() => (node.isConnected ? fn() : clearInterval(timer)), ms);
}

function statusLine(s) {
  const parts = [s.onAC ? 'Plugged in' : 'On battery'];
  if (s.battery !== null) parts.push(`${s.battery}%`);
  parts.push(s.stayingAwake ? 'staying awake' : 'Mac may sleep');
  return parts.join(' · ');
}

export function renderPowerSection(container, api) {
  injectCss();
  const root = el('section', 'pw');
  const seg = el('div', 'pw-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Keep Mac awake');
  const hint = el('p', 'pw-hint');
  const status = el('p', 'pw-status');
  const dot = el('span', 'pw-dot');
  const statusText = el('span');
  status.append(dot, statusText);
  const err = el('p', 'pw-err');
  const lidVal = el('span', 'pw-val');
  const lidSub = el('p', 'pw-sub');
  const lid = el('div', 'pw-row');
  lid.append(el('b', null, 'Lid closed'), lidVal, lidSub);

  const buttons = MODES.map((mode) => {
    const b = el('button', null, mode.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.mode = mode.id;
    b.onclick = () => choose(mode.id);
    return b;
  });
  seg.append(...buttons);
  root.append(el('h3', 'pw-title', 'Keep Mac awake'), seg, hint, status, err, lid);
  container.append(root);

  let shown = null;
  function show(s) {
    shown = s;
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.mode === s.awake));
    hint.textContent = MODES.find((m) => m.id === s.awake).hint;
    statusText.textContent = statusLine(s);
    status.classList.toggle('awake', s.stayingAwake);
    lidVal.textContent = s.lidSleepDisabled ? 'On' : 'Off';
    lidVal.classList.toggle('on', s.lidSleepDisabled);
    lidSub.replaceChildren(
      s.lidSleepDisabled ? 'Stays awake with the lid shut. Change with: ' : 'Sleeps when the lid shuts. Change with: ',
      el('code', null, `npm run lid -- ${s.lidSleepDisabled ? 'off' : 'on'}`),
      ' (needs your Mac password)',
    );
  }

  async function load(request) {
    try {
      show(await request());
      err.textContent = '';
    } catch (e) {
      err.textContent = e.message;
      if (shown) show(shown);
    }
  }

  async function choose(mode) {
    if (mode === shown?.awake) return;
    for (const b of buttons) {
      b.disabled = true;
      b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    }
    await load(() => api('PUT', '/api/power', { awake: mode }));
    for (const b of buttons) b.disabled = false;
  }

  pollWhileMounted(root, SECTION_POLL_MS, () => load(() => api('GET', '/api/power')));
  return root;
}

export function renderBatteryBadge(container, api) {
  injectCss();
  const badge = el('button', 'pw-badge');
  badge.type = 'button';
  badge.hidden = true;
  container.append(badge);

  async function refresh() {
    let s;
    try { s = await api('GET', '/api/power'); } catch { return; }
    badge.hidden = s.battery === null;
    if (badge.hidden) return;
    const plugged = s.onAC || s.charging;
    badge.textContent = `${plugged ? '🔌' : '🔋'} ${s.battery}%`;
    badge.classList.toggle('low', !plugged && s.battery <= LOW_BATTERY);
    const left = s.timeRemaining === null ? '' : `, ${Math.floor(s.timeRemaining / 60)}:${String(s.timeRemaining % 60).padStart(2, '0')} ${s.charging ? 'to full' : 'left'}`;
    badge.title = `Mac battery ${s.battery}%, ${s.charging ? 'charging' : plugged ? 'plugged in' : 'on battery'}${left}`;
    badge.setAttribute('aria-label', badge.title);
  }

  pollWhileMounted(badge, BADGE_POLL_MS, refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && badge.isConnected) refresh();
  });
  return badge;
}
