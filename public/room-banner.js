// A red strip on every screen while any device in the room is in Bypass on this device. Checks lightly (every 15 s, not while hidden)
// and counts the time down locally in between. Hidden when this device is not in a room or nothing is in Bypass.
import { call, bannerText, friendlyError } from './modes-core.js';

const POLL_MS = 15_000;
const bar = document.createElement('div');
bar.className = 'rb';
bar.hidden = true;
bar.setAttribute('role', 'alert');
const text = document.createElement('span');
text.className = 'rb-text';
const end = document.createElement('button');
end.type = 'button';
end.className = 'rb-end';
end.textContent = 'End now';
bar.append(text, end);

let members = [], busy = false, timer = 0;

// Lives inside the Mac status strip when there is one, so every full-screen layer already leaves room for it.
function place() {
  const host = document.getElementById('macStatus');
  if (host) { if (bar.parentNode !== host) { bar.classList.remove('rb-fixed'); host.append(bar); } }
  else if (!bar.isConnected) { bar.classList.add('rb-fixed'); document.body.append(bar); }
}

const live = () => members.filter((m) => m.banner && (m.bypassUntil === 'always' || m.bypassUntil == null || m.bypassUntil > Date.now()));

function paint() {
  const on = live();
  if (!on.length) { bar.hidden = true; return; }
  place();
  const line = bannerText(on);
  if (text.textContent !== line) text.textContent = line;
  bar.hidden = false;
}

async function poll() {
  if (document.hidden || busy) return;
  busy = true;
  try { members = (await call('GET', '/api/room/modes')).data.members || []; }
  catch { /* Keep what was last shown: a failed check is not a reason to hide a warning. */ }
  finally { busy = false; paint(); }
}

end.onclick = async () => {
  end.disabled = true;
  try {
    await Promise.all(live().map((m) => call('PUT', `/api/room/modes/${m.deviceId}`, { mode: 'auto' })));
    members = [];
    paint();
  } catch (err) { text.textContent = `Could not end Bypass. ${friendlyError(err, navigator.onLine === false)}`; }
  finally { end.disabled = false; poll(); }
};

poll();
timer = setInterval(poll, POLL_MS);
setInterval(() => { if (!document.hidden) paint(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.PocketDevBanner = { refresh: poll };
