// "A newer Pocket Dev is on npm": an icon beside the Settings gear, a sheet that says what to do, and a ping every time
// the page opens (and when the tab comes back after a while). The install itself happens on the Mac, in the Admin page
// or with `pocket-dev update`, so this only tells the person. "Later" lasts for this page load only.
(() => {
  const HIDDEN_LONG_MS = 10 * 60_000;
  const RELEASES = 'https://github.com/anisirji/pocket-dev/releases';

  function createNotice({ fetchUpdate, now = Date.now } = {}) {
    let info = null;
    let later = false;
    let hiddenAt = 0;
    return {
      info: () => info,
      pinging: () => Boolean(info) && !later,
      async load() {
        let found = null;
        try { found = await fetchUpdate(); } catch { /* offline: keep what we knew */ return info; }
        info = found?.available ? { latest: found.latest, current: found.current, command: found.command ?? null, os: found.os ?? null } : null;
        return info;
      },
      later() { later = true; },
      // Returns true when the tab came back after a long time away, which asks for a fresh look and a new ping.
      async visibility(hidden) {
        if (hidden) { hiddenAt = now(); return false; }
        const away = hiddenAt ? now() - hiddenAt : 0;
        hiddenAt = 0;
        if (away <= HIDDEN_LONG_MS) return false;
        later = false;
        await this.load();
        return true;
      },
    };
  }
  // The three steps and the one-line alternative, worded for the computer Pocket Dev runs on.
  const OPEN_ADMIN = {
    darwin: 'On your Mac, open Pocket Dev Admin: click its tile in the Dock, or run pocket-dev admin in Terminal.',
    win32: 'On your computer, open Pocket Dev Admin from its shortcut on the Desktop or in the Start menu, or run pocket-dev admin in PowerShell.',
    linux: 'On your computer, open Pocket Dev Admin from the app menu, or run pocket-dev admin in a terminal.',
  };
  function updateSteps(os, command = 'pocket-dev update') {
    return {
      steps: [
        OPEN_ADMIN[os] ?? 'On your computer, open Pocket Dev Admin, or run pocket-dev admin in a terminal.',
        'Tap Update and confirm.',
        'Wait a few seconds. This page reconnects by itself.',
      ],
      alternative: `Or, in a terminal on the computer, run: ${command || 'pocket-dev update'}`,
    };
  }
  globalThis.PocketUpdateNotice = { createNotice, updateSteps, HIDDEN_LONG_MS };
  if (typeof document === 'undefined') return;

  const SVG = 'http://www.w3.org/2000/svg';
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function icon() {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const circle = document.createElementNS(SVG, 'circle'); circle.setAttribute('cx', 12); circle.setAttribute('cy', 12); circle.setAttribute('r', 9);
    const arrow = document.createElementNS(SVG, 'path'); arrow.setAttribute('d', 'M12 16V8M8.5 11.5 12 8l3.5 3.5');
    svg.append(circle, arrow);
    return svg;
  }

  const notice = createNotice({
    async fetchUpdate() {
      const res = await fetch('/api/service', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).update ?? null;
    },
  });

  const button = make('button', 'icon-btn glyph un-icon');
  button.id = 'updateBtn';
  button.type = 'button';
  button.hidden = true;
  button.append(icon(), make('span', 'un-dot'));
  let sheet = null;
  let ping = null;

  function closeSheet() { sheet?.remove(); sheet = null; }
  function closePing() { ping?.remove(); ping = null; }

  function openSheet() {
    const u = notice.info();
    if (!u || sheet) return;
    closePing();
    sheet = make('div', 'un-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Update available');
    const body = make('div', 'un-card');
    const link = make('a', 'un-link', 'What is new');
    link.href = RELEASES; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const later = make('button', 'un-btn', 'Later');
    later.type = 'button';
    later.onclick = () => { notice.later(); closeSheet(); };
    const how = updateSteps(u.os, u.command);
    const steps = make('ol', 'un-steps');
    for (const text of how.steps) steps.append(make('li', 'un-step', text));
    const versions = make('p', 'un-versions');
    versions.append(make('span', 'un-v', `You have ${u.current}`), make('span', 'un-arrow', ' \u2192 '), make('b', 'un-v', `${u.latest} is available`));
    body.append(make('h2', 'un-title', 'Update Pocket Dev'), versions, steps, make('p', 'un-alt', how.alternative), link, later);
    sheet.append(body);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    document.body.append(sheet);
    later.focus();
  }

  function showPing() {
    const u = notice.info();
    if (!u || !notice.pinging() || ping || sheet) return;
    ping = make('div', 'un-ping');
    ping.setAttribute('role', 'status');
    const text = make('span', 'un-ping-text', `Pocket Dev ${u.latest} is available`);
    const details = make('button', 'un-btn', 'Details'); details.type = 'button'; details.onclick = openSheet;
    const later = make('button', 'un-btn un-quiet', 'Later'); later.type = 'button';
    later.onclick = () => { notice.later(); closePing(); };
    ping.append(text, details, later);
    document.body.append(ping);
  }

  function render() {
    const u = notice.info();
    button.hidden = !u;
    if (u) {
      button.setAttribute('aria-label', `Pocket Dev ${u.latest} is available`);
      button.title = `Pocket Dev ${u.latest} is available`;
    } else { closeSheet(); closePing(); }
  }

  button.onclick = openSheet;
  const gear = document.getElementById('settingsBtn');
  if (gear) gear.before(button); else document.querySelector('header')?.append(button);

  async function check({ pingAgain = true } = {}) {
    await notice.load();
    render();
    if (pingAgain) showPing();
  }
  document.addEventListener('visibilitychange', async () => {
    if (await notice.visibility(document.hidden)) { render(); showPing(); }
  });
  void check();
})();
