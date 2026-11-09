// Approvals inbox: a bell in the header that shows up when something waits for a yes or no, and the list it opens.
// Also opened from the Room screen with PocketDevApprovals.open(). Answers requests held on this device and on devices that named this one to answer.
import { call, discover, describeRequest, riskText, waitingText, answererText, friendlyError } from './modes-core.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };

const IDLE_MS = 8000, OPEN_MS = 5000, GONE_MS = 6000;
const offline = () => navigator.onLine === false;

// One card per request, keyed by source and id, so a card keeps its state between refreshes.
const cards = new Map(); // key -> { src, a, state: 'pending'|'sent'|'answered'|'gone', note, error, since }
let sources = [], lastError = '', loaded = false, open = false, root = null, list = null, status = null, timer = 0, busy = false, bell = null, count = null;

async function sourcesNow() {
  const found = await discover();
  if (!found.inRoom) return [{ id: null, name: 'this device', base: '' }];
  return [{ id: null, name: 'this device', base: '' }, ...found.answersFor.map((d) => ({ id: d.id, name: d.name, base: `/m/${d.id}` }))];
}

export async function refresh() {
  if (busy) return;
  busy = true;
  try {
    sources = await sourcesNow();
    const results = await Promise.allSettled(sources.map((s) => call('GET', `${s.base}/api/room/approvals`)));
    const seen = new Set();
    let failed = 0;
    results.forEach((r, i) => {
      const s = sources[i];
      if (r.status !== 'fulfilled') { failed++; return; }
      const { pending, recent } = r.value.data;
      for (const a of pending) {
        const key = `${s.id}:${a.id}`;
        seen.add(key);
        const old = cards.get(key);
        if (old) old.a = a; else cards.set(key, { src: s, a, state: 'pending', since: Date.now() });
      }
      for (const [key, c] of cards) {
        if (c.src.id !== s.id || seen.has(key) || c.state === 'gone' || c.state === 'answered') continue;
        const done = recent.find((x) => x.id === c.a.id);
        // Someone else got there first, or it timed out; a request this phone just answered goes quietly.
        if (c.state === 'sent') cards.delete(key);
        else Object.assign(c, { state: 'gone', a: done || c.a, since: Date.now() });
      }
    });
    lastError = failed === sources.length ? (offline() ? friendlyError(null, true) : 'Could not check for requests.') : failed ? 'One device did not answer.' : '';
    loaded = true;
  } catch (err) { lastError = friendlyError(err, offline()); }
  finally { busy = false; paint(); }
}

function paintBell() {
  if (!bell) return;
  const n = [...cards.values()].filter((c) => c.state === 'pending').length;
  bell.hidden = n === 0;
  document.body.classList.toggle('ap-waiting', n > 0);
  count.textContent = n > 9 ? '9+' : String(n);
  bell.setAttribute('aria-label', `${n} request${n === 1 ? '' : 's'} waiting for your answer`);
}

async function answer(c, decision) {
  const base = c.src.base;
  c.state = 'sent'; c.error = ''; paint();
  try {
    await call('POST', `${base}/api/room/approvals/${c.a.id}`, { decision });
    cards.delete(`${c.src.id}:${c.a.id}`);
  } catch (err) {
    if (err.status === 409) Object.assign(c, { state: 'gone', a: err.data?.approval || c.a, since: Date.now() });
    else { c.state = 'pending'; c.error = friendlyError(err, offline()); }
  }
  paint();
  refresh();
}

function card(c) {
  const { a, src } = c;
  const d = describeRequest(a);
  const li = el('li', `ap-card${c.state === 'gone' ? ' ap-gone' : ''}`);
  const who = `${a.from?.name || 'A device'}${src.id ? ` on ${src.name}` : ''}`;
  li.append(el('p', 'ap-who', `${who} ${a.kind === 'proposal' ? 'suggests' : 'asks'}`), el('p', 'ap-title', d.title));
  if (d.detail) li.append(el('p', 'co-note ap-detail', d.detail));
  const risk = riskText(a);
  if (c.state === 'gone') {
    const word = a.status === 'allowed' ? 'Allowed' : a.status === 'denied' ? 'Denied' : 'Expired';
    li.append(el('p', 'ap-answered', a.answeredBy && a.answeredBy !== 'system' ? `Already answered by ${answererText(a.answeredBy)}. ${word}.` : 'This request is over. It was not answered in time.'));
    return li;
  }
  if (risk) li.append(el('p', 'ap-risk', risk));
  const when = el('p', 'co-note ap-wait', waitingText(a.createdAt)); when.dataset.since = String(a.createdAt);
  li.append(when);
  if (a.kind === 'proposal') li.append(el('p', 'co-note', `After you allow it, ${a.from?.name || 'that device'} sends it again and it goes through once.`));
  const row = el('div', 'ap-actions');
  const sending = c.state === 'sent';
  const allow = button(sending ? 'Sending...' : 'Allow', () => answer(c, 'allow'), 'ap-allow');
  const deny = button('Deny', () => answer(c, 'deny'), 'ap-deny');
  allow.disabled = deny.disabled = sending;
  row.append(allow, deny);
  li.append(row);
  if (c.error) { const e = el('p', 'co-error', c.error); e.setAttribute('role', 'alert'); li.append(e); }
  return li;
}

function paint() {
  paintBell();
  if (!open) return;
  for (const [key, c] of cards) if (c.state === 'gone' && Date.now() - c.since > GONE_MS) cards.delete(key);
  const kids = [...cards.values()].sort((x, y) => x.a.createdAt - y.a.createdAt).map(card);
  list.replaceChildren(...kids);
  status.className = lastError ? 'co-error' : 'co-note';
  status.textContent = lastError ? `${lastError}${cards.size ? ' Showing what was last known.' : ''}`
    : !loaded ? 'Checking...' : kids.length ? '' : 'Nothing is waiting for you. A request from another device shows up here.';
  if (lastError && !loaded) status.append(' ', button('Try again', refresh));
}

function close() { open = false; root?.remove(); root = null; schedule(); }

export function openInbox() {
  if (open) return;
  open = true;
  root = el('div', 'ap');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Approvals');
  const head = el('header', 'ap-head');
  head.append(el('h2', '', 'Approvals'), button('✕', close, 'ap-close'));
  head.lastChild.setAttribute('aria-label', 'Close');
  status = el('p', 'co-note'); status.setAttribute('role', 'status');
  list = el('ul', 'ap-list');
  const body = el('div', 'ap-body');
  body.append(el('p', 'co-note', 'Requests from other devices that need your yes or no. The first answer counts.'), status, list);
  root.append(head, body);
  document.body.append(root);
  paint(); refresh(); schedule();
}

// Poll while the page is showing: faster with the list open, slower for the badge. The time on each card counts up every second.
function schedule() {
  clearTimeout(timer);
  const loop = async () => {
    if (!document.hidden) await refresh();
    timer = setTimeout(loop, open ? OPEN_MS : IDLE_MS);
  };
  timer = setTimeout(loop, open ? OPEN_MS : IDLE_MS);
}
setInterval(() => {
  if (!open) return;
  for (const n of root.querySelectorAll('[data-since]')) n.textContent = waitingText(Number(n.dataset.since));
  for (const [key, c] of cards) if (c.state === 'gone' && Date.now() - c.since > GONE_MS) { cards.delete(key); paint(); }
}, 1000);

window.PocketDevApprovals = { open: openInbox, refresh };

const head = document.querySelector('header'), gear = document.getElementById('settingsBtn');
if (head && gear) {
  bell = el('button', 'icon-btn glyph ap-bell');
  bell.id = 'approvalsBtn'; bell.type = 'button'; bell.hidden = true; bell.title = 'Requests waiting';
  bell.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  count = el('span', 'ap-count');
  bell.append(count);
  bell.onclick = openInbox;
  gear.before(bell);
  refresh();
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
