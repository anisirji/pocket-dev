// Shared by the Room screen's mode controls, the approvals inbox and the Bypass banner.
// The pure helpers run in node (test/room-modes-ui.test.mjs); `call` and `discover` need a browser.

export const MODE_INFO = {
  'read-only': { label: 'Read-only', line: 'Can look at files and chats. Cannot change anything.' },
  plan: { label: 'Plan', line: 'Changes are only suggested. Nothing happens until you say yes.' },
  ask: { label: 'Ask', line: 'Every change waits for your yes.' },
  auto: { label: 'Auto', line: 'Works freely. Only risky things ask you first.' },
  bypass: { label: 'Bypass', line: 'No questions asked. Full access, including private files.' },
};
export const MODE_ORDER = ['read-only', 'plan', 'ask', 'auto', 'bypass'];
export const BYPASS_CHOICES = [[1, '1 hour'], [2, '2 hours'], [3, '3 hours'], [4, '4 hours'], ['always', 'Always']];
export const BYPASS_WARNING = 'Bypass means no questions asked. This device can do anything on yours, including private files, until the time is up. Only use it for someone you trust completely.';

export const modeLabel = (mode) => MODE_INFO[mode]?.label || String(mode || 'Unknown');
export const modeLine = (mode) => MODE_INFO[mode]?.line || '';
export const bypassChoiceText = (h) => (BYPASS_CHOICES.find(([v]) => v === h) || [h, String(h)])[1];

// "2 h 05 min", "12:09" (minutes:seconds under an hour), "Always", "ending now". `until` is a time in ms, 'always' or null.
export function timeLeftText(until, now = Date.now()) {
  if (until === 'always' || until == null) return 'Always';
  const s = Math.ceil((until - now) / 1000);
  if (s <= 0) return 'ending now';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// What the banner says for the members in Bypass: the one that ends last decides the time shown for a group.
export function bannerText(members, now = Date.now()) {
  const on = members.filter((m) => m.banner);
  if (!on.length) return '';
  const names = on.map((m) => m.name || 'A device');
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  const open = on.some((m) => m.bypassUntil === 'always' || m.bypassUntil == null);
  const last = open ? 'always' : Math.max(...on.map((m) => m.bypassUntil));
  const left = last === 'always' ? 'until you end it' : `${timeLeftText(last, now)} left`;
  return `Bypass is on for ${who}: no questions asked, full access, ${left}.`;
}

// Who may do what. `role` is 'owner' (the person logged in on the device), 'assigned' (the person the owner named) or 'none'.
export function canChange({ role, mode, targetId, selfId }) {
  if (role === 'owner') return true;
  if (role === 'assigned') return mode !== 'bypass' && targetId !== selfId;
  return false;
}
export const modesAllowedFor = (role) => MODE_ORDER.filter((m) => canChange({ role, mode: m, targetId: 'x', selfId: 'y' }));
export const canEndBypass = (role) => role === 'owner' || role === 'assigned';

export function roleOf({ isLocal, assignedTo, selfId }) {
  if (isLocal) return 'owner';
  return assignedTo && assignedTo === selfId ? 'assigned' : 'none';
}

const leaf = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');
const list = (p) => String(p || '').split(', ').map(leaf).filter(Boolean).join(', ');

// A held request in plain words: { title, detail }. `summary` is "METHOD /path target : command" (see modes.js).
export function describeRequest(a) {
  const m = /^(\S+)\s+(\S+)\s*(.*)$/.exec(a.summary || `${a.method || ''} ${a.path || ''}`) || [];
  const method = m[1] || a.method || '', route = m[2] || a.path || '';
  let rest = m[3] || '', command = '';
  const at = rest.indexOf(' : ');
  if (at >= 0 || rest.startsWith(': ')) { command = rest.slice(at >= 0 ? at + 3 : 2).trim(); rest = at >= 0 ? rest.slice(0, at) : ''; }
  rest = rest.trim();
  if (command) return { title: `Run the command: ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`, detail: rest ? `In ${rest}` : '' };
  const target = list(rest), full = rest;
  const done = (title) => ({ title, detail: full && full !== target ? full : '' });
  if (/^\/api\/files\/trash$/.test(route)) return done(target ? `Delete ${target}` : 'Delete files');
  if (/^\/api\/files\/mkdir$/.test(route)) return done(target ? `Create folder ${target}` : 'Create a folder');
  if (/^\/api\/files\/rename$/.test(route)) return done(target ? `Rename ${target}` : 'Rename a file');
  if (/^\/api\/files\/upload$/.test(route)) return done(target ? `Upload a file to ${target}` : 'Upload a file');
  if (method === 'DELETE' && route.startsWith('/api/files')) return done(target ? `Delete ${target}` : 'Delete files');
  if (/^\/api\/files\//.test(route)) return done(target ? `Change files in ${target}` : 'Change files');
  if (route.startsWith('/api/sessions') || /terminal/.test(route)) return done('Open a terminal');
  if (/^\/api\/git\/clone/.test(route)) return done(target ? `Download the repository ${target}` : 'Download a repository');
  if (route.startsWith('/api/git')) return done(target ? `Change the git project ${target}` : 'Change a git project');
  if (route.startsWith('/api/chat')) return done('Send a message to a chat');
  if (route.startsWith('/api/power')) return done('Change the power settings (sleep, restart or shut down)');
  if (route.startsWith('/api/forwards')) return done('Open a port to the internet');
  if (route.startsWith('/api/apps')) return done('Change an app');
  if (/^\/api\/(admin|devices|collaborators|handoff)/.test(route)) return done('Change who can use this device');
  if (/^\/api\/(settings|network|connection)/.test(route)) return done('Change a setting of this device');
  return done(`Change something on this device (${method} ${route})`);
}

export function riskText(a) {
  const why = String(a.why || '').trim().replace(/\/[^\s),;]+/g, (p) => p.split('/').filter(Boolean).slice(-2).join('/'));
  if (!why) return '';
  const text = why.charAt(0).toUpperCase() + why.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function waitingText(createdAt, now = Date.now()) {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 10) return 'Just now';
  if (s < 60) return `Waiting ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `Waiting ${m} min` : `Waiting ${Math.floor(m / 60)} h ${m % 60} min`;
}

// "owner" and "assigned:Name" are how modes.js records who answered.
export const answererText = (by) => !by ? 'someone else' : by === 'owner' ? 'the owner' : by.startsWith('assigned:') ? by.slice(9) || 'the assigned person' : by === 'system' ? 'the system' : by;

export function friendlyError(err, offline = false) {
  const m = String(err?.message || err || '');
  if (offline || /failed to fetch|networkerror|load failed/i.test(m)) return 'This phone is offline. Check its connection and try again.';
  if (/not in a room/i.test(m)) return 'This device is not in a room.';
  if (/HTTP 50[24]|unreachable|timed out|ECONN/i.test(m)) return 'Could not reach that device. Check that it is on and connected.';
  return m || 'Something went wrong. Try again.';
}

// ---- browser only ----

// JSON request; throws an Error with .status and .data when the server answers 4xx or 5xx.
export async function call(method, url, body) {
  const res = await fetch(url, { method, cache: 'no-store', headers: { 'x-pocket-dev': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return { status: res.status, data };
}

// This device's room and the other devices that named this one as the person who answers for them.
// Cached for a short time so the badge, the inbox and the Room screen do not each ask every device.
let found = null, foundAt = 0, finding = null;
export async function discover({ force = false, maxAge = 30_000 } = {}) {
  if (!force && found && Date.now() - foundAt < maxAge) return found;
  return finding ||= (async () => {
    try {
      const { data } = await call('GET', '/api/room');
      const room = data.room;
      const others = room ? room.members.filter((m) => m.deviceId !== data.deviceId) : [];
      const checks = await Promise.allSettled(others.map((m) => call('GET', `/m/${m.deviceId}/api/room/assigned`)));
      const answersFor = others.filter((m, i) => checks[i].status === 'fulfilled' && checks[i].value.data.assigned === data.deviceId).map((m) => ({ id: m.deviceId, name: m.name }));
      found = { inRoom: Boolean(room), selfId: data.deviceId, members: room ? room.members : [], others, answersFor };
      foundAt = Date.now();
      return found;
    } finally { finding = null; }
  })();
}
export const forgetDiscovery = () => { found = null; };
