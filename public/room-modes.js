// Mode controls inside the Room screen: what each device in the room may do on this device (and, for devices that named this
// one to answer for them, on those devices), the Bypass duration sheet, whole-room Bypass, and the assigned person.
import { MODE_INFO, MODE_ORDER, BYPASS_CHOICES, BYPASS_WARNING, modeLabel, modeLine, bypassChoiceText, timeLeftText, canChange, modesAllowedFor, roleOf, friendlyError, call, discover, forgetDiscovery } from './modes-core.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };

// One bottom sheet at a time, drawn over everything. `build(sheet, close)` fills it.
let sheetCount = 0;
function openSheet(title, build) {
  const back = el('div', 'md-back');
  const sheet = el('div', 'md-sheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', title);
  // One history entry per sheet: the Android back gesture closes the sheet, not the Room behind it.
  const overlays = window.pocketDev?.overlays, name = `mode-sheet-${++sheetCount}`;
  const close = () => { if (overlays) overlays.close(name); back.remove(); };
  back.onclick = (e) => { if (e.target === back) close(); };
  sheet.append(el('h3', '', title));
  build(sheet, close);
  back.append(sheet);
  document.body.append(back);
  overlays?.open(name, () => back.remove());
  return close;
}

export function mountModes(host, { api }) {
  let sources = [], assignedLoaded = null, loadError = '', last = 0, busy = false, poll = 0, tick = 0;

  const offline = () => navigator.onLine === false;

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const found = await discover({ force: Date.now() - last > 25_000 });
      if (!found.inRoom) { sources = []; assignedLoaded = null; loadError = ''; return; }
      const local = await call('GET', '/api/room/modes');
      const out = [{ id: null, name: 'this device', local: true, role: 'owner', data: local.data }];
      const rest = await Promise.allSettled(found.others.map((m) => {
        const mine = found.answersFor.some((a) => a.id === m.deviceId);
        return call('GET', `/m/${m.deviceId}/api/room/modes`).then((r) => ({ id: m.deviceId, name: m.name, role: roleOf({ isLocal: false, assignedTo: mine ? found.selfId : null, selfId: found.selfId }), data: r.data }));
      }));
      rest.forEach((r, i) => out.push(r.status === 'fulfilled' ? r.value : { id: found.others[i].deviceId, name: found.others[i].name, role: 'none', error: friendlyError(r.reason, offline()) }));
      sources = out; assignedLoaded = found; loadError = ''; last = Date.now();
    } catch (err) { loadError = friendlyError(err, offline()); }
    finally { busy = false; render(); }
  }

  function render() {
    const kids = [];
    if (loadError) kids.push(el('p', 'co-error', `${loadError}${sources.length ? ' Showing what was last known.' : ''}`));
    const found = assignedLoaded;
    if (found) {
      const local = sources.find((s) => s.local);
      if (local) kids.push(localSection(local, found));
      for (const s of sources.filter((x) => !x.local)) kids.push(remoteSection(s, found));
    }
    host.replaceChildren(...kids);
  }

  function chip(mode, until) {
    const c = el('span', `md-chip md-${mode}`, modeLabel(mode));
    if (mode === 'bypass') { const t = el('span', 'md-left'); t.dataset.until = String(until ?? 'always'); t.textContent = ` ${timeLeftText(until, Date.now())}`; c.append(t); }
    return c;
  }

  function memberRow(s, m, found, canEdit) {
    const row = el('li', 'md-row');
    const top = el('div', 'md-row-top');
    const right = el('span', 'md-right');
    right.append(chip(m.mode, m.bypassUntil));
    if (canEdit) right.append(button('Change', () => chooseMode(s, m, found), 'md-change'));
    top.append(el('span', 'md-name', m.name || 'Unnamed device'), right);
    row.append(top, el('p', 'co-note md-line', modeLine(m.mode)));
    return row;
  }

  function localSection(s, found) {
    const sec = el('section', 'md-sec');
    sec.append(el('h4', '', 'What other devices may do here'));
    const members = s.data.members || [];
    if (!members.length) { sec.append(el('p', 'co-note', 'No other device has joined yet.')); return sec; }
    sec.append(el('p', 'co-note', 'This is what each device can do on this device. You decide.'));
    const ul = el('ul', 'md-list');
    for (const m of members) ul.append(memberRow(s, m, found, canChange({ role: 'owner', mode: m.mode, targetId: m.deviceId, selfId: found.selfId })));
    sec.append(ul);
    if (members.length > 1) sec.append(button('Change for everyone', () => chooseMode(s, { deviceId: 'all', name: 'every device', mode: null }, found), 'md-all'));
    sec.append(assignedControl(s, members, found));
    return sec;
  }

  function assignedControl(s, members, found) {
    const box = el('div', 'md-assign');
    const label = el('label', 'co-field');
    label.append(el('span', '', 'Who answers for this device'));
    const sel = el('select');
    sel.setAttribute('aria-label', 'Who answers for this device');
    const none = el('option', '', 'Only me'); none.value = ''; sel.append(none);
    for (const m of members) { const o = el('option', '', m.name || 'Unnamed device'); o.value = m.deviceId; sel.append(o); }
    sel.value = s.data.assigned && members.some((m) => m.deviceId === s.data.assigned) ? s.data.assigned : '';
    const msg = el('p', 'co-error'); msg.setAttribute('role', 'alert');
    sel.onchange = async () => {
      sel.disabled = true; msg.textContent = '';
      try { await call('PUT', '/api/room/assigned', { deviceId: sel.value || null }); forgetDiscovery(); await load(); }
      catch (err) { msg.textContent = friendlyError(err, offline()); sel.disabled = false; sel.value = s.data.assigned || ''; }
    };
    label.append(sel);
    box.append(label, el('p', 'co-note', 'This person can approve requests and change modes here (not turn Bypass on). They do it from their own phone.'), msg);
    return box;
  }

  function remoteSection(s, found) {
    const sec = el('section', 'md-sec');
    sec.append(el('h4', '', `On ${s.name}`));
    if (s.error) { sec.append(el('p', 'co-note', `${s.name} is not answering. ${s.error}`)); return sec; }
    const members = s.data.members || [];
    if (s.role === 'assigned') {
      sec.append(el('p', 'co-note', `You answer for ${s.name}. You can change modes there, except Bypass and your own.`));
      const ul = el('ul', 'md-list');
      for (const m of members) ul.append(memberRow(s, m, found, canChange({ role: 'assigned', mode: m.mode, targetId: m.deviceId, selfId: found.selfId })));
      sec.append(ul);
      return sec;
    }
    const mine = members[0];
    if (!mine) { sec.append(el('p', 'co-note', 'Nothing is set for this device there.')); return sec; }
    const top = el('div', 'md-row-top');
    top.append(el('span', 'md-name', 'Access for this device'), chip(mine.mode, mine.bypassUntil));
    sec.append(top, el('p', 'co-note md-line', `${modeLine(mine.mode)} Only the owner of ${s.name} can change this.`));
    return sec;
  }

  // ---- changing a mode ----

  async function put(s, id, body) {
    const base = s.local ? '' : `/m/${s.id}`;
    return call('PUT', `${base}/api/room/modes/${id}`, body);
  }

  function chooseMode(s, m, found) {
    const everyone = m.deviceId === 'all';
    const allowed = modesAllowedFor(s.role);
    openSheet(everyone ? 'Mode for every device' : `Mode for ${m.name}`, (sheet, close) => {
      const err = el('p', 'co-error'); err.setAttribute('role', 'alert');
      for (const mode of MODE_ORDER) {
        if (!allowed.includes(mode)) continue;
        const b = el('button', `md-opt${mode === m.mode ? ' on' : ''}${mode === 'bypass' ? ' md-opt-bypass' : ''}`);
        b.type = 'button';
        b.append(el('strong', '', MODE_INFO[mode].label + (mode === m.mode ? ' (now)' : '')), el('span', '', MODE_INFO[mode].line));
        b.onclick = async () => {
          if (mode === 'bypass') { close(); return chooseDuration(s, m, found); }
          if (mode === m.mode) return close();
          b.disabled = true; err.textContent = '';
          try { await put(s, m.deviceId, { mode }); close(); await load(); }
          catch (e) { err.textContent = friendlyError(e, offline()); b.disabled = false; }
        };
        sheet.append(b);
      }
      sheet.append(err, button('Cancel', close, 'md-cancel'));
    });
  }

  function chooseDuration(s, m, found) {
    const everyone = m.deviceId === 'all';
    openSheet(everyone ? 'Bypass for every device' : `Bypass for ${m.name}`, (sheet, close) => {
      const warn = el('p', 'md-warn', BYPASS_WARNING);
      warn.setAttribute('role', 'alert');
      const err = el('p', 'co-error'); err.setAttribute('role', 'alert');
      sheet.append(warn, el('p', 'co-note', 'How long should it last?'));
      const row = el('div', 'md-hours');
      for (const [hours, text] of BYPASS_CHOICES) {
        row.append(button(text, async (e) => {
          const b = e.currentTarget; b.disabled = true; err.textContent = '';
          try {
            if (everyone) {
              const first = await put(s, 'all', { mode: 'bypass', bypassHours: hours, confirm: true });
              if (first.data.confirmToken) { close(); return confirmEveryone(s, hours, first.data.confirmToken); }
            } else await put(s, m.deviceId, { mode: 'bypass', bypassHours: hours });
            close(); await load();
          } catch (e2) { err.textContent = friendlyError(e2, offline()); b.disabled = false; }
        }, hours === 'always' ? 'md-danger' : ''));
      }
      sheet.append(row, err, button('Cancel', close, 'md-cancel'));
    });
  }

  // Whole-room Bypass is only applied by a second call that quotes the token from the first.
  function confirmEveryone(s, hours, token) {
    openSheet('Are you sure?', (sheet, close) => {
      const err = el('p', 'co-error'); err.setAttribute('role', 'alert');
      sheet.append(el('p', 'md-warn', `Bypass will be on for every device in the room ${hours === 'always' ? 'until you end it' : `for ${bypassChoiceText(hours)}`}. ${BYPASS_WARNING}`),
        el('p', 'co-note', 'You have one minute to confirm.'));
      const yes = button('Yes, turn on Bypass for everyone', async () => {
        yes.disabled = true; err.textContent = '';
        try { await put(s, 'all', { mode: 'bypass', bypassHours: hours, confirm: true, confirmToken: token }); close(); await load(); }
        catch (e) { err.textContent = friendlyError(e, offline()); yes.disabled = false; }
      }, 'md-danger md-confirm');
      sheet.append(yes, err, button('No, keep it as it is', close, 'md-cancel'));
    });
  }

  // ---- upkeep: the time left counts down every second; the data refreshes every 8 s while the screen is showing ----
  const showing = () => host.isConnected && host.offsetParent !== null && !document.hidden;
  tick = setInterval(() => {
    if (!host.isConnected) return;
    for (const n of host.querySelectorAll('[data-until]')) n.textContent = ` ${timeLeftText(n.dataset.until === 'always' ? 'always' : Number(n.dataset.until), Date.now())}`;
  }, 1000);
  poll = setInterval(() => { if (showing()) load(); }, 8000);

  return { refresh: load };
}
