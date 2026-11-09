// Power settings section, the battery badges (Settings header, Settings button), and the full-screen sleep / shutdown state.
// `api(method, url, body)` is index.html's fetch helper: resolves to parsed JSON, throws Error(message).
// `runInTerminal(command, cwd)` opens a new terminal tab in cwd and runs command (text + Enter). Anything
// that needs sudo goes through it, so macOS asks for the password in that terminal; the server never sees it.

const MODES = [
  { id: 'off', label: 'Off', hint: 'Your Mac sleeps on its normal schedule.' },
  { id: 'plugged', label: 'When plugged in', hint: 'Awake on the charger, normal sleep on battery.' },
  { id: 'always', label: 'Always', hint: 'Awake on battery too. Drains the battery.' },
];
const SECTION_POLL_MS = 15_000;
const BADGE_POLL_MS = 60_000;
const SCREEN_POLL_MS = 15_000;
const SCREEN_FETCH_TIMEOUT_MS = 5000;
const LOW_BATTERY = 20;
const LID_POLL_MS = 2000;
const LID_WAIT_MS = 60_000;
const LID_CLOSED_TEXT = 'Open the laptop lid to change this. Turning it off while the lid is closed would put the Mac to sleep and disconnect you.';
const UPDATE_TEXT = 'A macOS update is being installed. Shutting down now could interrupt it. Try again after it finishes.';

// Keyed by the WebSocket close reason the server sends before it sleeps or shuts down.
const SCREENS = {
  'mac-sleeping': {
    title: 'Mac is going to sleep.',
    text: 'Open the lid or press a key on the Mac to wake it.',
  },
  'mac-shutting-down': {
    title: 'Mac is shutting down.',
    text: 'Turn it on with the power button. Pocket Dev starts after someone logs in.',
  },
};

const CSS = `
  .pw { display: grid; gap: 10px; color: var(--text, #d7dce5); }
  .pw button, .pw-screen button, .pw-badge { -webkit-tap-highlight-color: transparent; }
  .pw-title { margin: 0; font-size: 15px; font-weight: 600; }
  .pw-seg { display: flex; padding: 3px; gap: 3px; border-radius: 10px; background: var(--bg, #0b0e14); border: 1px solid var(--line, #252d3c); }
  .pw-seg button { flex: 1 1 auto; height: 36px; padding: 0 4px; border-radius: 7px; color: var(--muted, #7d8799); font-size: 13px; white-space: nowrap; }
  .pw-seg button[aria-checked="true"] { background: var(--panel-2, #1b2130); color: var(--text, #d7dce5); box-shadow: inset 0 0 0 1px var(--accent, #6aa9ff); font-weight: 600; }
  .pw-seg button:disabled { opacity: .6; }
  .pw-hint, .pw-sub { margin: 0; color: var(--muted, #7d8799); font-size: 13px; }
  .pw-temp.hot { color: #ff7b72; }
  .pw-temp[hidden] { display: none; }
  .pw-status { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; }
  .pw-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #7d8799); }
  .pw-status.awake .pw-dot { background: #7ee787; }
  .pw-err { margin: 0; color: var(--danger, #ff7b72); font-size: 13px; }
  .pw-err:empty { display: none; }
  .pw-warn { margin: 0; color: #f0c674; font-size: 13px; }
  .pw-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 4px 10px; padding-top: 10px; border-top: 1px solid var(--line, #252d3c); }
  .pw-row b { font-weight: 500; }
  .pw-row .pw-val { color: var(--muted, #7d8799); font-size: 13px; }
  .pw-row .pw-sub, .pw-row .pw-confirm { grid-column: 1 / -1; }
  .pw-row.locked .pw-sub { color: #f0c674; }
  .pw code, .pw-screen code { white-space: nowrap; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; color: var(--text, #d7dce5); }
  .pw-switch { position: relative; width: 46px; height: 28px; border-radius: 14px; background: var(--line, #252d3c); transition: background .15s; }
  .pw-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--text, #d7dce5); transition: transform .15s; }
  .pw-switch[aria-checked="true"] { background: #b8862b; }
  .pw-switch[aria-checked="true"]::after { transform: translateX(18px); }
  .pw-switch:disabled { opacity: .45; }
  .pw-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line, #252d3c); }
  .pw-actions > :not(.pw-btn) { grid-column: 1 / -1; }
  .pw-btn { height: 40px; padding: 0 12px; border-radius: 10px; background: var(--panel-2, #1b2130); border: 1px solid var(--line, #252d3c); font-weight: 500; }
  .pw-btn.danger { color: var(--danger, #ff7b72); }
  .pw-btn.primary { background: var(--accent, #6aa9ff); border-color: var(--accent, #6aa9ff); color: #08101e; font-weight: 600; }
  .pw-btn.quiet { background: none; border-color: transparent; color: var(--muted, #7d8799); }
  .pw-btn[hidden] { display: none; }
  .pw-app { color: var(--text, #d7dce5); background: #3a2a10; padding: 0 4px; border-radius: 4px; font-weight: 600; }
  .pw-btn:disabled { opacity: .45; }
  .pw-confirm { display: grid; gap: 8px; padding: 10px; border-radius: 10px; border: 1px solid #b8862b; background: #2a2210; font-size: 13px; text-align: left; }
  .pw-confirm.danger { border-color: var(--danger, #ff7b72); background: #2c1414; }
  .pw-confirm[hidden] { display: none; }
  .pw-confirm p { margin: 0; color: var(--text, #d7dce5); }
  .pw-confirm ul { margin: 0; padding-left: 18px; }
  .pw-confirm-body { display: grid; gap: 6px; }
  .pw-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .pw-confirm-actions button { height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line, #252d3c); }
  .pw-confirm .pw-go { border: 0; background: #f0c674; color: #1a1406; font-weight: 600; }
  .pw-confirm.danger .pw-go { background: var(--danger, #ff7b72); color: #1e0806; }
  .pw-screen { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 24px; background: var(--bg, #0b0e14); color: var(--text, #d7dce5); text-align: center; font-size: 14px; }
  .pw-screen h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .pw-screen > p { margin: 0; color: var(--muted, #7d8799); }
  .pw-screen > p.pw-warn { color: #f0c674; }
  .pw-screen-actions { display: grid; gap: 8px; margin-top: 8px; }
  .pw-badge { display: inline-flex; align-items: center; height: 26px; padding: 0 8px; border-radius: 8px; background: var(--bg, #0b0e14); border: 1px solid var(--line, #252d3c); color: var(--text, #d7dce5); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pw-badge[hidden], .pw-gear[hidden] { display: none; }
  .pw-badge.low { border-color: var(--danger, #ff7b72); color: var(--danger, #ff7b72); }
  .pw-gear { position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); height: 14px; padding: 0 3px; border-radius: 7px; background: var(--panel-2, #1b2130); border: 1px solid var(--line, #252d3c); color: var(--muted, #7d8799); font-size: 9px; font-weight: 600; line-height: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
  .pw-gear.low { background: var(--danger, #ff7b72); border-color: var(--danger, #ff7b72); color: #1e0806; }
`;

function injectCss() {
  if (document.getElementById('pw-css')) return;
  const style = document.createElement('style');
  style.id = 'pw-css';
  style.textContent = CSS;
  document.head.append(style);
}

const say = (text) => globalThis.PocketMachine?.say?.(text) ?? text;
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = say(text);
  return node;
};

const button = (cls, text, onclick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
};

// Runs fn now and every ms until the node leaves the page.
function pollWhileMounted(node, ms, fn) {
  fn();
  const timer = setInterval(() => (node.isConnected ? fn() : clearInterval(timer)), ms);
}

// An inline "are you sure" box. open(...content) fills and shows it; the confirm button runs onGo.
function confirmBox(goLabel, onGo, { danger = false } = {}) {
  const node = el('div', `pw-confirm${danger ? ' danger' : ''}`);
  node.hidden = true;
  const body = el('div', 'pw-confirm-body');
  const close = () => { node.hidden = true; };
  const actions = el('div', 'pw-confirm-actions');
  actions.append(button(null, 'Cancel', close), button('pw-go', goLabel, () => { close(); onGo(); }));
  node.append(body, actions);
  return {
    node,
    close,
    open(...content) {
      body.replaceChildren(...content);
      node.hidden = false;
    },
  };
}

// "Battery 31 °C · Thermal: normal". Thermal is how hard macOS is throttling; anything above normal is worth a look.
const THERMAL_TEXT = { nominal: 'normal', fair: 'warm, slightly slowed', serious: 'hot, slowed down', critical: 'very hot, heavily slowed' };
function temperatureLine(t) {
  const parts = [];
  if (t?.batteryC != null) parts.push(`Battery ${t.batteryC.toFixed(1)} °C`);
  if (t?.thermal) parts.push(`Thermal: ${THERMAL_TEXT[t.thermal]}`);
  return parts.join(' · ');
}

function statusLine(s) {
  const parts = [s.onAC ? 'Plugged in' : 'On battery'];
  if (s.battery !== null) parts.push(`${s.battery}%`);
  parts.push(s.stayingAwake ? 'staying awake' : say('Mac may sleep'));
  return parts.join(' · ');
}

// What a shutdown closes, for the confirm box: running terminals and port forwards.
async function shutdownSummary(api) {
  const [sessions, forwards] = await Promise.all([
    api('GET', '/api/sessions').catch(() => []),
    api('GET', '/api/forwards').catch(() => []),
  ]);
  const list = el('ul');
  for (const t of sessions.filter((t) => t.exitCode === null)) list.append(el('li', null, t.title));
  for (const f of forwards) list.append(el('li', null, `Port forward :${f.port}`));
  return [
    el('p', null, 'Shut down the Mac?'),
    ...(list.children.length ? [el('p', null, 'These close:'), list] : [el('p', null, 'No terminals or port forwards are open.')]),
    el('p', null, 'Apps with unsaved changes may stop the shutdown and ask on the Mac.'),
  ];
}

// Covers the page while the Mac sleeps or shuts down, and polls slowly until the server answers again.
// `kind` is the WebSocket close reason: 'mac-sleeping' or 'mac-shutting-down'.
// `openApps()` (optional) opens the running-apps sheet from the blocked notice.
export function showPowerScreen(kind, api, { runInTerminal, openApps, onBack } = {}) {
  injectCss();
  if (document.querySelector('.pw-screen')) return null;
  const screen = el('div', 'pw-screen');
  screen.setAttribute('role', 'alertdialog');
  document.body.append(screen);
  let stopped = false;

  const finish = () => {
    stopped = true;
    screen.remove();
    onBack?.();
  };
  const dismiss = () => {
    api('DELETE', '/api/power/shutdown').catch(() => {});
    finish();
  };
  const render = (...nodes) => screen.replaceChildren(...nodes);

  function waiting() {
    render(el('h2', null, SCREENS[kind].title), el('p', null, SCREENS[kind].text));
    setTimeout(poll, SCREEN_POLL_MS);
  }

  function blocked(s) {
    const retry = confirmBox('Shut down', async () => {
      try {
        await api('POST', '/api/power/shutdown');
        waiting();
      } catch (e) {
        render(el('h2', null, 'The Mac did not shut down.'), el('p', 'pw-warn', e.message), button('pw-btn', 'OK', dismiss));
      }
    }, { danger: true });
    const force = confirmBox('Yes, force it', () => {
      dismiss();
      runInTerminal('npm run shutdown -- --force', s.repoDir);
    }, { danger: true });
    const retryButton = button('pw-btn primary', 'Try shut down again', async () => {
      force.close();
      retry.open(...await shutdownSummary(api));
    });
    const appsButton = button('pw-btn', 'See open apps', () => openApps());
    appsButton.hidden = !openApps;
    const forceButton = button('pw-btn danger', 'Force shut down…', () => {
      retry.close();
      force.open(
        el('p', null, 'Force shut down?'),
        el('p', null, 'Every app quits without saving. Unsaved work in all apps is lost. A terminal opens and asks for your Mac password.'),
      );
    });
    retryButton.disabled = forceButton.disabled = s.updateInProgress;
    forceButton.disabled ||= !runInTerminal;
    const actions = el('div', 'pw-screen-actions');
    actions.append(retry.node, retryButton, appsButton, force.node, forceButton, button('pw-btn quiet', 'Keep the Mac on', dismiss));
    const why = el('p', 'pw-warn', 'Probably by an app with unsaved changes. ');
    if (s.shutdown.apps.length) {
      why.append('Still open: ');
      s.shutdown.apps.forEach((app, i) => why.append(...(i ? [', '] : []), el('strong', 'pw-app', app)));
      why.append('. ');
    }
    why.append('Save or close it on the Mac, or force it.');
    render(
      el('h2', null, 'Shutdown was blocked.'),
      why,
      ...(s.updateInProgress ? [el('p', 'pw-warn', UPDATE_TEXT)] : []),
      actions,
    );
  }

  function failed(s) {
    render(el('h2', null, 'The Mac did not shut down.'), el('p', 'pw-warn', s.shutdown.error), button('pw-btn', 'OK', dismiss));
  }

  async function poll() {
    if (stopped || !screen.isConnected) return;
    let s = null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SCREEN_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/power', { signal: abort.signal, cache: 'no-store' });
      if (res.ok) s = await res.json();
    } catch {}
    clearTimeout(timer);
    if (stopped) return;
    const state = kind === 'mac-shutting-down' ? s?.shutdown?.state : undefined;
    if (s && !state) return finish();
    if (state === 'blocked') return blocked(s);
    if (state === 'error') return failed(s);
    setTimeout(poll, SCREEN_POLL_MS);
  }

  waiting();
  return screen;
}

export function renderPowerSection(container, api, { runInTerminal, openApps, onBack } = {}) {
  injectCss();
  const root = el('section', 'pw');
  const seg = el('div', 'pw-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', say('Keep Mac awake'));
  const hint = el('p', 'pw-hint');
  const status = el('p', 'pw-status');
  const statusText = el('span');
  status.append(el('span', 'pw-dot'), statusText);
  const temp = el('p', 'pw-sub pw-temp');
  const err = el('p', 'pw-err');

  const lidVal = el('span', 'pw-val');
  const lidSwitch = button('pw-switch', null, () => {
    if (shown.lidSleepDisabled) runLid('off');
    else lidConfirm.open(
      el('p', null, 'Keep the Mac awake with the lid closed?'),
      el('p', null, 'Keep it on a desk and plugged in. Never put it in a bag while this is on.'),
    );
  });
  lidSwitch.setAttribute('role', 'switch');
  lidSwitch.setAttribute('aria-label', 'Stay awake with the lid closed');
  const lidSub = el('p', 'pw-sub');
  const lidConfirm = confirmBox('Open terminal', () => runLid('on'));
  const lid = el('div', 'pw-row');
  lid.append(el('b', null, 'Lid closed'), lidVal, lidSwitch, lidSub, lidConfirm.node);

  const sleepConfirm = confirmBox('Sleep', () => sleep());
  const shutdownConfirm = confirmBox('Shut down', () => shutDown(), { danger: true });
  const sleepButton = button('pw-btn', 'Put Mac to sleep', () => {
    shutdownConfirm.close();
    sleepConfirm.open(el('p', null, 'Put the Mac to sleep? Pocket Dev disconnects until you open the lid or press a key on the Mac.'));
  });
  const shutdownButton = button('pw-btn danger', 'Shut down Mac', openShutdownConfirm);
  const updateWarn = el('p', 'pw-warn', UPDATE_TEXT);
  const actions = el('div', 'pw-actions');
  actions.append(sleepButton, shutdownButton, updateWarn, sleepConfirm.node, shutdownConfirm.node);

  const buttons = MODES.map((mode) => {
    const b = button(null, mode.label, () => choose(mode.id));
    b.setAttribute('role', 'radio');
    b.dataset.mode = mode.id;
    return b;
  });
  seg.append(...buttons);
  root.append(el('h3', 'pw-title', 'Keep Mac awake'), seg, hint, status, temp, err, lid, actions);
  container.append(root);

  let shown = null;
  let lidWait = null;
  const screenOptions = { runInTerminal, openApps, onBack };

  function showLid(s) {
    if (lidWait && s.lidSleepDisabled === lidWait.target) lidWait = null;
    lidVal.textContent = s.lidSleepDisabled ? 'On' : 'Off';
    lidSwitch.setAttribute('aria-checked', String(lidWait ? lidWait.target : s.lidSleepDisabled));
    lidSwitch.disabled = s.lidClosed || Boolean(lidWait) || !runInTerminal;
    lid.classList.toggle('locked', s.lidClosed);
    if (s.lidClosed) lidConfirm.close();
    const command = el('code', null, `npm run lid -- ${s.lidSleepDisabled ? 'off' : 'on'}`);
    if (s.lidClosed) lidSub.replaceChildren(LID_CLOSED_TEXT);
    else if (lidWait) lidSub.replaceChildren('Type your Mac password in the new terminal.');
    else lidSub.replaceChildren(
      s.lidSleepDisabled ? 'Stays awake with the lid shut. ' : 'Sleeps when the lid shuts. ',
      runInTerminal ? 'Tapping runs ' : 'Change with: ', command,
      runInTerminal ? ' in a new terminal (needs your Mac password).' : ' (needs your Mac password)',
    );
  }

  function show(s) {
    shown = s;
    const off = s.unsupported ?? {};
    const note = (key) => `Not available on this system. ${off[key]}`;
    for (const b of buttons) b.disabled = Boolean(off.keepAwake);
    lid.hidden = Boolean(off.lid || off.lidSleep);
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.mode === s.awake));
    hint.textContent = off.keepAwake ? note('keepAwake') : MODES.find((m) => m.id === s.awake).hint;
    statusText.textContent = statusLine(s);
    status.classList.toggle('awake', s.stayingAwake);
    temp.textContent = temperatureLine(s.temperature);
    temp.classList.toggle('hot', s.temperature?.thermal === 'serious' || s.temperature?.thermal === 'critical');
    temp.hidden = !temp.textContent;
    showLid(s);
    sleepButton.disabled = s.updateInProgress || Boolean(off.sleepNow);
    shutdownButton.disabled = s.updateInProgress || Boolean(off.shutDown);
    sleepButton.title = off.sleepNow ? note('sleepNow') : '';
    shutdownButton.title = off.shutDown ? note('shutDown') : '';
    updateWarn.hidden = !s.updateInProgress;
    if (s.updateInProgress) {
      sleepConfirm.close();
      shutdownConfirm.close();
    }
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

  async function runLid(word) {
    lidWait = { target: word === 'on', until: Date.now() + LID_WAIT_MS };
    showLid(shown);
    try {
      await runInTerminal(`npm run lid -- ${word}`, shown.repoDir);
    } catch (e) {
      lidWait = null;
      err.textContent = e.message;
      showLid(shown);
      return;
    }
    const timer = setInterval(async () => {
      if (!lidWait || !root.isConnected) return clearInterval(timer);
      if (Date.now() > lidWait.until) {
        lidWait = null;
        err.textContent = 'Lid setting did not change within a minute. Check the terminal.';
        return showLid(shown);
      }
      await load(() => api('GET', '/api/power'));
    }, LID_POLL_MS);
  }

  // With lid sleep off the Mac cannot sleep, so a terminal turns it back on first (sudo) and then sleeps.
  async function sleep() {
    try {
      if (shown.lidSleepDisabled) {
        if (!runInTerminal) throw new Error('Run npm run sleep in a terminal on the Mac.');
        await runInTerminal('npm run sleep', shown.repoDir);
      } else {
        await api('POST', '/api/power/sleep');
        showPowerScreen('mac-sleeping', api, screenOptions);
      }
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function openShutdownConfirm() {
    sleepConfirm.close();
    shutdownConfirm.open(...await shutdownSummary(api));
  }

  async function shutDown() {
    try {
      await api('POST', '/api/power/shutdown');
      showPowerScreen('mac-shutting-down', api, screenOptions);
    } catch (e) {
      err.textContent = e.message;
    }
  }

  pollWhileMounted(root, SECTION_POLL_MS, () => load(() => api('GET', '/api/power')));
  return root;
}

// null when the Mac has no battery.
function batteryView(s) {
  if (s.battery === null) return null;
  const plugged = s.onAC || s.charging;
  const left = s.timeRemaining === null ? '' : `, ${Math.floor(s.timeRemaining / 60)}:${String(s.timeRemaining % 60).padStart(2, '0')} ${s.charging ? 'to full' : 'left'}`;
  return {
    percent: s.battery,
    plugged,
    low: !plugged && s.battery <= LOW_BATTERY,
    title: say(`Mac battery ${s.battery}%, ${s.charging ? 'charging' : plugged ? 'plugged in' : 'on battery'}${left}`),
  };
}

// Calls show(batteryView or null) now, every BADGE_POLL_MS, and when the page comes back, until node leaves the page.
function watchBattery(node, api, show) {
  const refresh = async () => {
    if (!node.isConnected) return document.removeEventListener('visibilitychange', onVisible);
    try { show(batteryView(await api('GET', '/api/power'))); } catch {}
  };
  const onVisible = () => document.visibilityState === 'visible' && refresh();
  document.addEventListener('visibilitychange', onVisible);
  pollWhileMounted(node, BADGE_POLL_MS, refresh);
}

export function renderBatteryBadge(container, api) {
  injectCss();
  const badge = el('span', 'pw-badge');
  badge.hidden = true;
  container.append(badge);
  watchBattery(badge, api, (b) => {
    badge.hidden = !b;
    if (!b) return;
    badge.textContent = `${b.plugged ? '🔌' : '🔋'} ${b.percent}%`;
    badge.classList.toggle('low', b.low);
    badge.title = b.title;
    badge.setAttribute('aria-label', b.title);
  });
  return badge;
}

// The percentage on the Settings button: the top bar has no room for the full badge.
export function renderGearBattery(node, api) {
  injectCss();
  node.classList.add('pw-gear');
  node.hidden = true;
  watchBattery(node, api, (b) => {
    node.hidden = !b;
    if (!b) return;
    node.textContent = `${b.percent}%`;
    node.classList.toggle('low', b.low);
    node.closest('button')?.setAttribute('aria-label', `Settings. ${b.title}`);
  });
}
