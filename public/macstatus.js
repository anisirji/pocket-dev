(() => {
  const POLL_MS = 5000;
  const VITALS_MS = 30_000;
  const REQUEST_MS = 8000;
  const STALE_MS = 15_000;
  const SNOOZE_MS = 15 * 60_000;
  const THERMAL_WORD = { fair: 'warm', serious: 'hot', critical: 'very hot' };
  const baseTitle = document.title;
  const say = (text) => globalThis.PocketMachine?.say?.(text) ?? text;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = say(text);
    return node;
  };

  // Live performance, battery and temperature stay above every screen. All full-screen layers reserve --status-h.
  const wrap = el('div');
  wrap.id = 'macStatus';
  wrap.hidden = false;
  const strip = el('button', 'ms-strip');
  strip.type = 'button';
  strip.title = say('Mac health');
  strip.onclick = () => window.openHealthSheet?.();
  const battery = el('span', 'ms-item');
  const temp = el('span', 'ms-item');
  const state = el('span', 'ms-state', 'Checking Mac…');
  state.setAttribute('role', 'status');
  const cpu = el('span', 'ms-item ms-cpu', 'CPU —');
  const storage = el('span', 'ms-item ms-storage', 'Free —');
  const age = el('span', 'ms-age');
  battery.hidden = temp.hidden = true;
  strip.append(el('span', 'ms-label', 'Mac'), state, cpu, storage, battery, temp, age);
  const banner = el('div', 'ms-banner');
  banner.hidden = true;
  const bannerText = el('span', 'ms-text');
  const bannerActions = el('span', 'ms-actions');
  banner.append(bannerText, bannerActions);
  wrap.append(strip, banner);
  document.body.append(wrap);

  const setHeight = () => document.documentElement.style.setProperty('--status-h', wrap.hidden ? '0px' : `${wrap.offsetHeight}px`);
  new ResizeObserver(setHeight).observe(wrap);

  // Publish one geometry for all screens. Resizing only #app leaves overlays behind
  // the keyboard; translating it also gives nested fixed elements a new containing block.
  const vv = window.visualViewport;
  const follow = () => {
    const style = document.documentElement.style;
    style.setProperty('--viewport-h', `${vv?.height ?? window.innerHeight}px`);
    style.setProperty('--viewport-top', `${vv?.offsetTop ?? 0}px`);
  };
  vv?.addEventListener('resize', follow);
  vv?.addEventListener('scroll', follow);
  window.addEventListener('resize', follow);
  window.addEventListener('orientationchange', follow);
  window.addEventListener('pageshow', follow);
  follow();

  const dismissed = new Map(); // key -> { level, at }
  const announced = new Map(); // key -> level already vibrated for

  function visibleAlerts(alerts) {
    for (const key of [...dismissed.keys()]) if (!alerts.some((a) => a.key === key)) dismissed.delete(key);
    for (const key of [...announced.keys()]) if (!alerts.some((a) => a.key === key)) announced.delete(key);
    return alerts.filter((a) => {
      const d = dismissed.get(a.key);
      return !d || (a.level === 'critical' && d.level !== 'critical') || Date.now() - d.at > SNOOZE_MS;
    });
  }

  // A new alert, or one that got worse, buzzes the phone once. Vibration needs a tap on the page, so it can no-op.
  function announce(alerts) {
    let buzz = false;
    for (const a of alerts) {
      if (announced.get(a.key) !== a.level && !(a.level === 'warning' && announced.get(a.key) === 'critical')) buzz = true;
      announced.set(a.key, a.level);
    }
    if (buzz) try { navigator.vibrate?.([250, 120, 250]); } catch {}
  }

  let vitalsAlerts = [], performanceAlerts = [], performance = null;
  let connection = navigator.onLine === false ? 'offline' : 'checking';
  let receivedAt = null, active = null, vitalsRequest = null, pollTimer = 0, authExpired = false;

  function allAlerts() {
    const alerts = [...vitalsAlerts, ...performanceAlerts];
    if (connection === 'unreachable') alerts.unshift({ key: 'connection', level: 'warning', text: 'Mac is not responding. It may be busy, asleep, or disconnected. The displayed readings are old.' });
    if (connection === 'unavailable') alerts.unshift({ key: 'connection', level: 'warning', text: 'The Mac replied, but its performance readings are unavailable. Try checking again.' });
    if (connection === 'offline') alerts.unshift({ key: 'connection', level: 'warning', text: 'This phone is offline. Mac readings are out of date.' });
    return alerts.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  }

  function renderAlerts(alerts = allAlerts()) {
    const shown = visibleAlerts(alerts);
    announce(shown);
    document.title = alerts.length ? `⚠ ${baseTitle}` : baseTitle;
    banner.hidden = !shown.length;
    if (!shown.length) return;
    const top = shown[0];
    banner.className = `ms-banner ${top.level}`;
    bannerText.textContent = say(shown.length > 1 ? `${top.text} (+${shown.length - 1} more)` : top.text);
    const dismiss = el('button', 'ms-btn', 'Dismiss');
    dismiss.type = 'button';
    dismiss.onclick = () => {
      for (const a of shown) dismissed.set(a.key, { level: a.level, at: Date.now() });
      renderAlerts(alerts);
    };
    const actions = [dismiss];
    if (connection === 'connected' && shown.some((a) => ['hot', 'cpu', 'memory', 'response'].includes(a.key)) && window.openAppsSheet) {
      const apps = el('button', 'ms-btn', 'Open apps');
      apps.type = 'button';
      apps.onclick = () => window.openAppsSheet();
      actions.unshift(apps);
    }
    if (shown.some((a) => a.key === 'connection')) {
      const retry = el('button', 'ms-btn', 'Check again');
      retry.type = 'button'; retry.disabled = navigator.onLine === false;
      retry.onclick = () => { if (!active) { setConnection('checking'); poll(); } };
      actions.unshift(retry);
    }
    bannerActions.replaceChildren(...actions);
  }

  function renderVitals(v) {
    battery.hidden = v.battery === null;
    if (v.battery !== null) {
      const plugged = v.onAC || v.charging;
      const charge = v.charging ? 'Charging' : v.onAC && v.battery === 100 ? 'Fully charged' : 'Not charging';
      battery.textContent = `${v.battery}% · ${charge}`;
      battery.title = say(`Mac battery: ${v.battery}%, ${charge.toLowerCase()}, ${plugged ? 'plugged in' : 'on battery'}`);
      battery.className = `ms-item${!plugged && v.battery <= 10 ? ' crit' : !plugged && v.battery <= v.limits.batteryPercent ? ' warn' : ''}`;
    }
    const { batteryC, thermal } = v.temperature;
    temp.hidden = batteryC === null && !thermal;
    if (!temp.hidden) {
      const word = THERMAL_WORD[thermal];
      temp.textContent = [batteryC !== null && `${batteryC.toFixed(1)} °C`, word].filter(Boolean).join(' · ');
      temp.className = `ms-item${thermal === 'critical' || batteryC >= v.limits.temperatureC + 5 ? ' crit' : thermal === 'serious' || batteryC >= v.limits.temperatureC ? ' warn' : ''}`;
    }
    vitalsAlerts = v.alerts || [];
    setHeight();
    renderAlerts();
  }

  const WORD = { normal: 'Normal', cpu: 'Busy', memory: 'Memory tight', disk: 'Storage low', response: 'Slow response', unknown: 'Partial readings' };
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  function updateAge() {
    const stale = connection !== 'connected';
    wrap.className = stale ? 'ms-stale' : '';
    age.textContent = receivedAt === null ? 'Waiting for readings' : `${stale ? 'Last reading' : 'Updated'} ${Math.max(0, Math.floor((Date.now() - receivedAt) / 1000))}s ago`;
  }
  function paintPerformance() {
    const status = connection === 'offline' ? 'Phone offline' : connection === 'unreachable' ? 'Mac not responding'
      : connection === 'checking' ? 'Checking Mac…' : connection === 'unavailable' ? 'Readings unavailable'
        : connection === 'unsupported' ? 'Monitoring needs update' : WORD[performance?.status] || 'Partial readings';
    setText(state, say(status));
    state.className = `ms-state ${connection === 'connected' ? performance?.level || 'unknown' : 'unknown'}`;
    const percent = performance?.cpu?.usedPercent;
    cpu.textContent = Number.isFinite(percent) ? `CPU ${percent}%` : 'CPU —';
    cpu.title = Number.isFinite(percent) ? say(`${percent}% of the Mac’s total CPU capacity is in use`) : 'CPU reading is unavailable';
    cpu.className = `ms-item ms-cpu${Number.isFinite(percent) && percent >= 90 ? ' warn' : ''}`;
    const free = performance?.disk?.freeGB;
    storage.textContent = Number.isFinite(free) ? `${free < 1 ? `${Math.round(free * 1024)} MB` : `${free.toFixed(1)} GB`} free` : 'Free —';
    storage.title = Number.isFinite(free) ? say(`Available on the Mac’s home disk: ${free.toFixed(1)} GB${Number.isFinite(performance.disk.totalGB) ? ` of ${performance.disk.totalGB} GB` : ''}`) : 'Storage reading is unavailable';
    storage.className = `ms-item ms-storage${Number.isFinite(free) && free < 3 ? ' crit' : Number.isFinite(free) && free < 10 ? ' warn' : ''}`;
    updateAge(); setHeight();
  }
  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    paintPerformance(); renderAlerts();
  }

  // The deadline includes the JSON body, not just response headers. Cancellation also ends mocked or stuck reads,
  // and each caller checks request identity so a response after wake/retry cannot replace newer readings.
  function requestJson(url) {
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const cancel = () => { controller.abort(); rejectDeadline(new Error('Request ended')); };
    const timer = setTimeout(cancel, REQUEST_MS);
    const response = (async () => {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res.json().catch((err) => { err.responded = true; throw err; });
    })();
    return { cancel, result: Promise.race([response, deadline]).finally(() => clearTimeout(timer)) };
  }
  function stopRequests() {
    clearTimeout(pollTimer);
    const pending = active, vitals = vitalsRequest;
    active = vitalsRequest = null;
    pending?.cancel(); vitals?.cancel();
  }
  function expired() {
    authExpired = true; stopRequests();
    location.replace('/login.html');
  }
  async function poll() {
    if (active || document.hidden || authExpired || navigator.onLine === false) return;
    clearTimeout(pollTimer);
    const request = active = requestJson('/api/performance');
    try {
      const data = await request.result;
      if (active !== request) return;
      if (!data?.cpu || !data?.disk || !data?.memory || !Object.hasOwn(WORD, data.status)) throw Object.assign(new Error('No performance reading'), { responded: true });
      performance = data;
      performanceAlerts = data.alerts || [];
      receivedAt = Date.now();
      connection = 'connected';
      paintPerformance(); renderAlerts();
    } catch (err) {
      if (active !== request) return;
      if (err.status === 401 || err.status === 403) return expired();
      if (err.status === 404) {
        performance = null; performanceAlerts = []; connection = 'unsupported';
        paintPerformance(); renderAlerts();
      } else setConnection(navigator.onLine === false ? 'offline' : err.status || err.responded ? 'unavailable' : 'unreachable');
    } finally {
      if (active === request) {
        active = null;
        if (!document.hidden && !authExpired && navigator.onLine !== false) pollTimer = setTimeout(poll, POLL_MS);
      }
    }
  }
  async function pollVitals() {
    if (vitalsRequest || document.hidden || authExpired || navigator.onLine === false) return;
    const request = vitalsRequest = requestJson('/api/power/vitals');
    try {
      const data = await request.result;
      if (vitalsRequest === request) renderVitals(data);
    } catch (err) {
      if (vitalsRequest === request && (err.status === 401 || err.status === 403)) expired();
    } finally { if (vitalsRequest === request) vitalsRequest = null; }
  }
  function resume() {
    stopRequests();
    if (authExpired) return;
    setConnection(navigator.onLine === false ? 'offline' : 'checking');
    updateAge(); poll(); pollVitals();
  }
  setInterval(() => {
    if (document.hidden || authExpired) return;
    if (navigator.onLine === false) setConnection('offline');
    else if (receivedAt !== null && Date.now() - receivedAt > STALE_MS && connection === 'connected') setConnection('unreachable');
    updateAge();
  }, 1000);
  setInterval(pollVitals, VITALS_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRequests(); else resume(); });
  window.addEventListener('offline', () => { stopRequests(); setConnection('offline'); });
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  paintPerformance(); renderAlerts(); poll(); pollVitals();
})();
