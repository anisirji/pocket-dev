(() => {
  const REFRESH_MS = 10_000;
  const { overlays } = window.pocketDev;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const VERDICT = {
    good: ['Healthy', 'Nothing needs your attention.'],
    watch: ['Worth a look', 'Something is outside its usual range.'],
    attention: ['Needs attention', 'Act on this soon.'],
  };
  const THERMAL = { nominal: 'Normal', fair: 'Warm, slightly slowed', serious: 'Hot, slowed down', critical: 'Very hot, heavily slowed' };

  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  const hours = (min) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  function span(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  }

  const state = { open: false, busy: false, timer: 0 };
  let ui = null;

  function build() {
    const root = el('div', 'health-sheet');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Mac health');
    const bar = el('div', 'health-bar');
    const refresh = el('button', 'health-btn', 'Refresh');
    const close = el('button', 'health-btn', 'Close');
    refresh.type = close.type = 'button';
    refresh.onclick = load;
    close.onclick = () => overlays.close('health');
    bar.append(el('h2', null, 'Mac health'), refresh, close);
    const scroll = el('div', 'health-scroll');
    const note = el('p', 'health-note');
    root.append(bar, scroll, note);
    document.body.appendChild(root);
    return { root, scroll, note };
  }

  const row = (label, value, tone) => {
    const r = el('div', 'health-row');
    r.append(el('span', 'health-label', label), el('span', `health-value${tone ? ` ${tone}` : ''}`, value));
    return r;
  };
  const group = (title, ...rows) => {
    const g = el('section', 'health-group');
    g.append(el('h3', null, title), ...rows.filter(Boolean));
    return g;
  };
  const unknown = 'No reading';

  function render(h) {
    const [title, sub] = VERDICT[h.status];
    const verdict = el('div', `health-verdict ${h.status}`);
    verdict.append(el('b', null, title), el('span', null, sub));
    const issues = h.issues.map((i) => el('p', `health-issue ${i.level}`, i.text));

    const b = h.battery;
    const plugged = b.onAC || b.charging;
    const heat = h.temperature;
    const hot = heat.thermal === 'serious' || heat.thermal === 'critical' || (heat.batteryC !== null && heat.batteryC >= h.limits.temperatureC);
    const m = h.memory;
    const cond = b.condition;

    ui.scroll.replaceChildren(
      verdict, ...issues,
      group('Battery',
        row('Charge', b.percent === null ? unknown : `${b.percent}%${b.charging ? ', charging' : plugged ? ', plugged in' : ', on battery'}`,
          !plugged && b.percent !== null && b.percent <= h.limits.batteryPercent ? 'warn' : ''),
        b.timeRemaining != null && row(b.charging ? 'Time to full' : 'Time left', hours(b.timeRemaining)),
        cond && row('Condition', `${cond.capacityPercent}% of original capacity`, cond.capacityPercent < 80 ? 'warn' : ''),
        cond && row('Charge cycles', cond.designCycles ? `${cond.cycles} of ${cond.designCycles}` : String(cond.cycles))),
      group('Temperature',
        row('Battery', heat.batteryC === null ? unknown : `${heat.batteryC.toFixed(1)} °C`, hot ? 'warn' : ''),
        row('Thermal state', heat.thermal ? THERMAL[heat.thermal] : unknown, hot ? 'warn' : ''),
        row('Alert at', `${h.limits.temperatureC} °C or ${h.limits.batteryPercent}% battery`)),
      group('Performance',
        row('Processor', h.cpu.usedPercent === null ? unknown : `${h.cpu.usedPercent}% in use of ${h.cpu.cores} cores`, h.cpu.usedPercent >= 90 ? 'warn' : ''),
        row('Memory free', m && m.freePercent !== null ? `${m.freePercent}%` : unknown, m && m.freePercent !== null && m.freePercent < 10 ? 'warn' : ''),
        m && row('Memory used', `${gb(m.usedMB)} (${gb(m.compressedMB)} compressed)`),
        row('Disk free', h.disk.freeGB === null ? unknown : `${h.disk.freeGB} GB of ${h.disk.totalGB} GB`, h.disk.freeGB !== null && h.disk.freeGB < 10 ? 'warn' : '')),
      group('Staying awake',
        row('Keep awake', { always: 'Always', plugged: 'When plugged in', off: 'Off' }[h.power.awake] ?? h.power.awake),
        row('Right now', h.power.stayingAwake ? 'Staying awake' : 'The Mac may sleep'),
        row('Lid', h.power.lidClosed ? (h.power.lidSleepDisabled ? 'Closed, awake' : 'Closed') : 'Open')),
      group('This Mac',
        row('Name', h.mac.name),
        row('Up for', span(h.mac.uptimeSec)),
        h.network.length > 0 && row('Network', h.network.join(', '))),
      group('Pocket Dev',
        row('Version', h.pocketDev.version),
        row('Running for', span(h.pocketDev.uptimeSec)),
        row('Node', h.pocketDev.node)));
    ui.note.textContent = `Updated ${new Date().toLocaleTimeString()}. Refreshes every 10 s while open.`;
  }

  async function load() {
    if (state.busy || !state.open) return;
    state.busy = true;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.status === 401) return location.replace('/login.html');
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      ui.note.textContent = `Could not read the Mac: ${err.message}`;
    } finally {
      state.busy = false;
    }
  }

  function closeSheet() {
    clearInterval(state.timer);
    state.open = false;
    ui.root.hidden = true;
  }

  window.openHealthSheet = () => {
    if (state.open) return;
    document.activeElement?.blur();
    ui ??= build();
    ui.root.hidden = false;
    ui.scroll.replaceChildren(el('p', 'health-note', 'Reading the Mac…'));
    ui.note.textContent = '';
    state.open = true;
    overlays.open('health', closeSheet);
    load();
    state.timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  };
})();
