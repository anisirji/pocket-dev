(() => {
  const POLL_MS = 30_000;
  const SNOOZE_MS = 15 * 60_000;
  const THERMAL_WORD = { fair: 'warm', serious: 'hot', critical: 'very hot' };
  const baseTitle = document.title;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // One strip above every screen with the Mac's battery and temperature, and a banner under it when the Mac needs
  // attention. The banner and strip are the top of the page, so every full-screen layer starts below them (--status-h).
  const wrap = el('div');
  wrap.id = 'macStatus';
  wrap.hidden = true;
  const strip = el('button', 'ms-strip');
  strip.type = 'button';
  strip.title = 'Mac health';
  strip.onclick = () => window.openHealthSheet?.();
  const battery = el('span', 'ms-item');
  const temp = el('span', 'ms-item');
  strip.append(el('span', 'ms-label', 'Mac'), battery, temp);
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

  function renderAlerts(alerts) {
    const shown = visibleAlerts(alerts);
    announce(shown);
    document.title = alerts.length ? `⚠ ${baseTitle}` : baseTitle;
    banner.hidden = !shown.length;
    if (!shown.length) return;
    const top = shown[0];
    banner.className = `ms-banner ${top.level}`;
    bannerText.textContent = shown.length > 1 ? `${top.text} (+${shown.length - 1} more)` : top.text;
    const dismiss = el('button', 'ms-btn', 'Dismiss');
    dismiss.type = 'button';
    dismiss.onclick = () => {
      for (const a of shown) dismissed.set(a.key, { level: a.level, at: Date.now() });
      renderAlerts(alerts);
    };
    const actions = [dismiss];
    if (shown.some((a) => a.key === 'hot') && window.openAppsSheet) {
      const apps = el('button', 'ms-btn', 'Open apps');
      apps.type = 'button';
      apps.onclick = () => window.openAppsSheet();
      actions.unshift(apps);
    }
    bannerActions.replaceChildren(...actions);
  }

  function render(v) {
    battery.hidden = v.battery === null;
    if (v.battery !== null) {
      const plugged = v.onAC || v.charging;
      const charge = v.charging ? 'Charging' : v.onAC && v.battery === 100 ? 'Fully charged' : 'Not charging';
      battery.textContent = `${v.battery}% · ${charge}`;
      battery.title = `Mac battery: ${v.battery}%, ${charge.toLowerCase()}, ${plugged ? 'plugged in' : 'on battery'}`;
      battery.className = `ms-item${!plugged && v.battery <= 10 ? ' crit' : !plugged && v.battery <= v.limits.batteryPercent ? ' warn' : ''}`;
    }
    const { batteryC, thermal } = v.temperature;
    temp.hidden = batteryC === null && !thermal;
    if (!temp.hidden) {
      const word = THERMAL_WORD[thermal];
      temp.textContent = [batteryC !== null && `${batteryC.toFixed(1)} °C`, word].filter(Boolean).join(' · ');
      temp.className = `ms-item${thermal === 'critical' || batteryC >= v.limits.temperatureC + 5 ? ' crit' : thermal === 'serious' || batteryC >= v.limits.temperatureC ? ' warn' : ''}`;
    }
    // A Mac with neither a battery nor a temperature reading has nothing to show.
    wrap.hidden = battery.hidden && temp.hidden;
    setHeight();
    renderAlerts(v.alerts);
  }

  async function poll() {
    try {
      const res = await fetch('/api/power/vitals', { cache: 'no-store' });
      if (res.status === 401) return location.replace('/login.html');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch {
      // The server may be restarting. Keep the last reading on screen rather than flashing an error.
    }
  }

  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
