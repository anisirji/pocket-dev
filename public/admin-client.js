'use strict';
const REFRESH_MS = 5000;
const MIN_DEVICES = 1;
const MAX_DEVICES = 20;

const $ = (id) => document.getElementById(id);

// h('div', { class: 'x', onclick }, child, 'text') builds an element; null and false children are skipped.
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-pocket-admin': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

function stamp(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

let toastTimer = 0;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

// A styled confirm. Resolves true when the person presses the confirm button. `extra` is shown under the body.
function ask({ title, body, confirm, danger = false, extra = null }) {
  const dialog = $('ask');
  $('askTitle').textContent = title;
  $('askBody').textContent = body;
  $('askExtra').replaceChildren(...(extra ? [extra] : []));
  $('askOk').textContent = confirm;
  dialog.classList.toggle('danger', danger);
  dialog.returnValue = '';
  dialog.showModal();
  $('askCancel').focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

// Runs a page action: shows its error as a toast and refreshes afterwards.
async function act(fn, done) {
  try {
    const result = await fn();
    if (done) toast(typeof done === 'function' ? done(result) : done);
  } catch (err) {
    toast(err.message, true);
  }
  await refresh(true);
}

let state = null;
let collaborators;
import('/collaborators.js').then((m) => {
  collaborators = m.mountCollaborators($('collaborators'), { api, local: true, devices: () => state?.devices || [] });
}).catch((err) => { $('collaborators').textContent = `Could not load Collaborators: ${err.message}`; });
let logFilter = 'all';
let editingId = null;
let limitDraft = null;
let lastOk = 0;

// ---- Connection

function renderConnection() {
  const { access, overview, urls } = state;
  const box = $('connection');
  box.classList.toggle('off', !access.connected);
  $('connTitle').textContent = access.connected ? 'Connected' : 'Disconnected';
  const sub = $('connSub');
  if (access.connected) {
    sub.replaceChildren(plural(overview.online, 'device'), ' online · phones open ', h('b', {}, urls.lan));
  } else {
    sub.textContent = "Phones can't reach this Mac. Terminals keep running here.";
  }
  $('connErr').textContent = access.error ?? '';
  const btn = $('connBtn');
  btn.textContent = access.connected ? 'Disconnect' : 'Connect';
  btn.className = `btn btn-big ${access.connected ? 'btn-danger-outline' : 'btn-primary'}`;
  $('keepOpen').checked = access.keepOpen;
  startHeartbeat(access.heartbeatEveryMs);
}

$('connBtn').addEventListener('click', async () => {
  const connect = !state.access.connected;
  if (!connect && !(await ask({
    title: 'Disconnect phones?',
    body: 'Closes the phone port: every phone disconnects and port forwards stop. Terminals keep running on the Mac. You can reconnect from this page.',
    confirm: 'Disconnect',
    danger: true,
  }))) return;
  await act(() => api('PUT', '/api/access', { connected: connect }), connect ? 'Connected' : 'Disconnected');
});

$('keepOpen').addEventListener('change', (e) => act(() => api('PUT', '/api/access', { keepOpen: e.target.checked })));

// A worker keeps the beat when the tab is in the background, where browsers slow page timers to once a minute.
let heartbeat = null;
let heartbeatMs = 0;
function startHeartbeat(ms) {
  if (heartbeat && ms === heartbeatMs) return;
  heartbeat?.terminate();
  heartbeatMs = ms;
  heartbeat = new Worker('/admin-heartbeat.js');
  heartbeat.postMessage(ms);
}

// ---- Internet access

const KIND_LABEL = { off: 'Off', quick: 'Quick link', domain: 'My own domain' };
// The domain choice shows its form before anything is saved; Off and Quick link save on click.
let netDraftKind = null;

function renderInternet() {
  const { network, access } = state;
  const { wifi, internet, tunnel, hasToken, cloudflared } = network;
  const shown = netDraftKind ?? internet.kind;
  for (const b of document.querySelectorAll('.net-kinds button')) b.setAttribute('aria-pressed', String(b.dataset.kind === shown));
  for (const kind of Object.keys(KIND_LABEL)) $(`net${kind[0].toUpperCase()}${kind.slice(1)}`).hidden = kind !== shown;
  $('netCloudflared').hidden = shown === 'off' || Boolean(cloudflared);
  $('netCount').textContent = internet.kind === 'off' ? 'Off' : tunnel.status === 'connected' ? `On · ${tunnel.url}` : `${KIND_LABEL[internet.kind]} · ${tunnel.status === 'error' ? 'failed' : tunnel.status === 'starting' ? 'connecting' : 'not connected'}`;
  $('domainPort').textContent = `localhost:${access.port}`;

  const running = tunnel.status !== 'off';
  $('quickStatus').textContent = tunnel.kind !== 'quick' ? 'Off' : { starting: 'Connecting to Cloudflare…', connected: 'On', error: 'Could not start' }[tunnel.status];
  $('quickDetail').textContent = tunnel.kind === 'quick' && tunnel.status === 'error' ? tunnel.error
    : !access.connected ? 'Press Connect above first.'
      : tunnel.kind === 'quick' && tunnel.status === 'connected' ? 'Anyone with this link reaches the login page. Turn off when you are done.'
        : 'Gives a random address that works until you turn it off.';
  $('quickBtn').textContent = tunnel.kind === 'quick' && running ? 'Turn off' : 'Turn on';
  $('quickBtn').disabled = internet.kind !== 'quick' || (!access.connected && !running);
  $('quickLink').hidden = !(tunnel.kind === 'quick' && tunnel.url);
  $('quickUrl').textContent = tunnel.url ?? '';
  $('quickOpen').href = tunnel.url ?? '#';

  const form = $('domainForm');
  if (form.dataset.hostname !== (internet.hostname ?? '') && !form.contains(document.activeElement)) {
    form.dataset.hostname = internet.hostname ?? '';
    form.elements.hostname.value = internet.hostname ?? '';
  }
  form.elements.token.placeholder = hasToken ? 'Tunnel token (saved; paste a new one to replace it)' : 'Tunnel token';
  form.elements.token.required = !hasToken;
  const domain = internet.kind === 'domain' && tunnel.kind === 'domain' ? tunnel.status : internet.kind === 'domain' ? 'waiting' : 'unset';
  $('domainStatus').textContent = { unset: 'Not set up yet', waiting: 'Waiting', starting: 'Connecting to Cloudflare…', connected: 'Connected', error: 'Could not connect', off: 'Waiting' }[domain];
  $('domainDetail').textContent = {
    unset: 'Follow the steps above, then press Save and connect.',
    waiting: access.connected ? 'Press Try again to start the link.' : 'Starts when phone access is connected.',
    off: access.connected ? 'Press Try again to start the link.' : 'Starts when phone access is connected.',
    starting: `Pocket Dev will be at https://${internet.hostname}`,
    connected: `Pocket Dev is at https://${internet.hostname}. Log in there once; Wi-Fi then comes by Switch to local on the phone.`,
    error: tunnel.error,
  }[domain];
  $('domainOpen').hidden = domain !== 'connected';
  $('domainOpen').href = domain === 'connected' ? tunnel.url : '#';
  $('domainRetry').hidden = !(['error', 'waiting', 'off'].includes(domain) && access.connected);

  $('wifi').checked = wifi;
  $('wifi').disabled = internet.kind === 'off';
  $('wifiNote').textContent = internet.kind === 'off'
    ? 'Phones on your Wi-Fi reach this Mac directly. Turn on internet access first if you want to turn this off.'
    : `${wifi ? 'Phones on your Wi-Fi reach this Mac directly; turn off to allow only the internet link.' : 'Off: only the internet link reaches Pocket Dev.'} A change applies after you restart Pocket Dev.`;
}

async function saveNetwork(changes, done) {
  $('netErr').textContent = '';
  try {
    state.network = await api('PUT', '/api/network', changes);
    netDraftKind = null;
    if (done) toast(done);
  } catch (err) {
    $('netErr').textContent = err.message;
  }
  await refresh(true);
}

document.querySelector('.net-kinds').addEventListener('click', async (e) => {
  const kind = e.target.closest('[data-kind]')?.dataset.kind;
  if (!kind || !state) return;
  if (kind === 'domain') {
    netDraftKind = 'domain';
    renderInternet();
    return;
  }
  if (kind === 'off' && state.network.tunnel.status === 'connected' && !(await ask({
    title: 'Turn internet access off?', body: 'The internet link closes now. Phones using it lose Pocket Dev until they are back on your Wi-Fi.', confirm: 'Turn off', danger: true,
  }))) return;
  await saveNetwork({ internet: { kind } }, kind === 'off' ? 'Internet access off' : 'Quick link allowed. Press Turn on for a link.');
});

$('quickBtn').addEventListener('click', () => act(() => api('PUT', '/api/remote', { on: state.network.tunnel.kind !== 'quick' || state.network.tunnel.status === 'off' }), (r) => (r.status === 'off' ? 'Quick link off' : 'Starting the Quick link')));
$('quickCopy').addEventListener('click', () => copyLink($('quickUrl').textContent));
$('domainRetry').addEventListener('click', () => act(() => api('PUT', '/api/remote', { on: true })));

$('domainForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { hostname, token } = e.target.elements;
  await saveNetwork({ internet: { kind: 'domain', hostname: hostname.value }, ...(token.value && { token: token.value }) }, 'Saved. Connecting to Cloudflare…');
  if (!$('netErr').textContent) token.value = '';
});

$('wifi').addEventListener('change', (e) => saveNetwork({ wifi: e.target.checked }, e.target.checked ? 'Wi-Fi access on after the next restart' : 'Wi-Fi access off after the next restart'));

// ---- Overview

function renderOverview() {
  const { overview, maxDevices, requireApproval } = state;
  $('cLogged').textContent = overview.loggedIn;
  $('cLoggedSub').textContent = `of ${maxDevices} allowed`;
  $('cOnline').textContent = overview.online;
  $('cPending').textContent = overview.pending;
  $('cPendingSub').textContent = requireApproval ? 'approval is on' : 'approval is off';
  $('cPendingCard').classList.toggle('warn', overview.pending > 0);
  $('navPending').textContent = overview.pending || '';
  const failed = overview.failedLogins;
  $('cFailed').textContent = failed.count;
  $('cFailedCard').classList.toggle('alarm', failed.guessing);

  const banner = $('guessing');
  banner.hidden = !failed.guessing;
  if (failed.guessing) {
    const from = failed.ips.slice(0, 3).map((x) => `${x.ip} (${x.count})`).join(', ') + (failed.ips.length > 3 ? ', …' : '');
    banner.replaceChildren(...[
      h('p', {}, h('b', {}, 'Someone may be guessing your password: '), `${failed.count} failed attempts in the last hour from ${failed.ips.length === 1 ? 'IP' : 'IPs'} ${from}.`),
      requireApproval ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setApproval(true) }, 'Turn on approval'),
      h('a', { class: 'btn btn-sm link-btn', href: '#password' }, 'Change password'),
    ].filter(Boolean));
  }
}

// ---- Devices

const via = (d) => (d.via === 'qr' ? 'QR code' : 'Password');

function deviceCell(d) {
  if (d.id === editingId) {
    const input = h('input', { type: 'text', value: d.name, maxlength: 40, 'aria-label': 'Device name' });
    const save = () => act(() => api('PATCH', `/api/devices/${d.id}`, { name: input.value }).then(() => { editingId = null; }));
    const cancel = () => { editingId = null; renderDevices(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return h('div', { class: 'cell rename' }, input,
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, 'Save'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: cancel }, 'Cancel'));
  }
  return h('div', { class: 'cell' },
    h('span', { class: 'dev-name' }, d.name),
    d.role === 'admin' ? h('span', { class: 'tag' }, 'Admin') : null,
    d.status === 'blocked' ? h('span', { class: 'tag tag-blocked' }, 'Blocked') : null,
    h('small', {}, d.kind && d.kind !== d.name ? d.kind : `id ${d.id}`));
}

function activity(d) {
  if (d.status === 'blocked') return h('div', { class: 'cell' }, `Tried ${ago(d.lastSeen)}`, h('small', {}, 'every request refused'));
  if (d.online) {
    return h('div', { class: 'cell' }, h('span', { class: 'online' }, 'Online now'),
      h('small', {}, d.connections ? `${plural(d.connections, 'terminal connection')}` : 'no terminal open'));
  }
  return h('div', { class: 'cell' }, `Last seen ${ago(d.lastSeen)}`);
}

const DEVICE_BUTTONS = {
  active: [
    ['Rename', null],
    ['Block', 'block'],
    ['Log out', 'revoke'],
  ],
  blocked: [
    ['Rename', null],
    ['Unblock', 'unblock'],
    ['Remove', 'remove'],
  ],
};

const CONFIRMS = {
  revoke: (d) => ({ title: `Log out ${d.name}?`, body: 'Its terminals disconnect now. It can log in again with the password or a QR code.', confirm: 'Log out', danger: true }),
  block: (d) => ({ title: `Block ${d.name}?`, body: 'It disconnects now and every request it sends is refused until you unblock it.\n\nIf that browser clears its cookies it becomes a new device. Turn on "Approve new devices" so a fresh login has to wait for you.', confirm: 'Block', danger: true }),
  remove: (d) => ({ title: `Remove ${d.name}?`, body: 'Its record is deleted, so that browser is no longer blocked: it can try the password again as a new device, or wait for approval if that is on.', confirm: 'Remove', danger: true }),
  deny: (d) => ({ title: `Deny ${d.name}?`, body: 'The request is removed and the phone goes back to the login form.', confirm: 'Deny', danger: true }),
};

async function deviceAction(d, action) {
  if (CONFIRMS[action] && !(await ask(CONFIRMS[action](d)))) return;
  const done = { remove: `${d.name} removed`, revoke: `${d.name} logged out`, block: `${d.name} blocked`, unblock: `${d.name} unblocked`, approve: `${d.name} approved`, deny: `${d.name} denied` }[action];
  await act(() => api('POST', `/api/devices/${d.id}/${action}`), done);
}

function deviceRow(d) {
  const buttons = (DEVICE_BUTTONS[d.status] ?? []).map(([label, action]) => h('button', {
    class: `btn btn-sm${action === 'revoke' || action === 'remove' ? ' btn-danger' : ''}`,
    type: 'button',
    onclick: action ? () => deviceAction(d, action) : () => { editingId = d.id; renderDevices(); },
  }, label));
  return h('div', { class: `row ${d.status}` },
    deviceCell(d),
    h('div', { class: 'cell' }, d.ip, h('small', {}, 'IP address')),
    h('div', { class: 'cell' }, via(d), h('small', {}, `added ${ago(d.createdAt)}`)),
    activity(d),
    h('div', { class: 'actions' }, d.id === editingId ? null : buttons));
}

function renderDevices() {
  const list = state.devices.filter((d) => d.status !== 'pending');
  const blocked = list.filter((d) => d.status === 'blocked').length;
  $('devCount').textContent = `${state.overview.loggedIn} logged in${blocked ? ` · ${blocked} blocked` : ''}`;
  const head = h('div', { class: 'row row-head' }, h('div', {}, 'Device'), h('div', {}, 'Address'), h('div', {}, 'Logged in with'), h('div', {}, 'Activity'), h('div', {}, ''));
  $('deviceRows').replaceChildren(...(list.length
    ? [head, ...list.map(deviceRow)]
    : [h('p', { class: 'empty' }, 'No devices yet. Show a login QR in Share & login above, or open the address on a phone and type the password.')]));
}

function renderPending() {
  const list = state.devices.filter((d) => d.status === 'pending');
  $('pending').hidden = list.length === 0 && !state.requireApproval;
  $('pendingTtl').textContent = state.pendingTtlMin;
  $('pendingRows').replaceChildren(...(list.length ? list.map((d) => h('div', { class: 'row' },
    h('div', { class: 'cell' }, h('span', { class: 'dev-name' }, d.name), h('span', { class: 'tag tag-code' }, d.code), h('small', {}, 'code shown on the phone')),
    h('div', { class: 'cell' }, d.ip, h('small', {}, 'IP address')),
    h('div', { class: 'cell' }, `Asked ${ago(d.createdAt)}`, h('small', {}, `expires in ${Math.max(1, Math.ceil((d.expiresAt - Date.now()) / 60000))} min`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => deviceAction(d, 'approve') }, state.roleAccessEnabled ? 'Approve as Admin' : 'Approve'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => deviceAction(d, 'deny') }, 'Deny'),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deviceAction(d, 'block') }, 'Block')),
  )) : [h('p', { class: 'empty' }, 'Nobody is waiting. New password logins show up here.')]));
}

// ---- Security log

const BY = { admin: 'on this page', phone: 'from a phone', cli: 'from the command line', startup: 'at startup', self: 'itself', lockdown: 'by lockdown' };
const byText = (e) => (BY[e.by] ? ` ${BY[e.by]}` : '');
const REVOKED_BY = {
  admin: 'on this page', phone: 'from another device', self: 'itself', 'qr-eviction': 'to make room for a QR login',
  'password-change': 'by the password change', lockdown: 'by lockdown',
};
const closedText = (closed = {}) => Object.entries(closed).map(([id, n]) => `${n} ${id}`).join(', ');

const EVENT_TEXT = {
  'remote-started': (e) => `Internet link on at ${e.url}`,
  'remote-stopped': () => 'Internet link off',
  'remote-error': (e) => `Internet link failed: ${e.error}`,
  'network-changed': (e) => `Internet access set to ${KIND_LABEL[e.kind] ?? e.kind}${e.hostname ? ` (${e.hostname})` : ''}${e.wifi === false ? ', Wi-Fi access off' : ''}${byText(e)}`,
  'handoff-created': (e) => `${e.name} asked to switch from the internet link to Wi-Fi`,
  'handoff-redeemed': (e) => `${e.name} switched to the Wi-Fi address`,
  'handoff-failed': (e) => `A switch link was refused (${e.reason})${e.kind ? ` from ${e.kind}` : ''}`,
  'role-access-enabled': () => 'Role-based sharing enabled after trusted Admin device review',
  'collaborator-created': (e) => `Collaborator ${e.grantId} created as ${e.role}`,
  'collaborator-updated': (e) => `Collaborator ${e.grantId} access updated`,
  'collaborator-revoked': (e) => `Collaborator ${e.grantId} access revoked`,
  'collaborator-invited': (e) => `One-time invitation created for collaborator ${e.grantId}`,
  'collaborator-joined': (e) => `Collaborator ${e.grantId} accepted access as ${e.role}`,
  'collaborator-expired': (e) => `Collaborator ${e.grantId} access expired`,
  'login': (e) => `${e.name} logged in with ${e.via === 'qr' ? 'a QR code' : 'the password'}`,
  'login-pending': (e) => `${e.name} typed the password and is waiting for approval (code ${e.deviceId?.slice(-4)})`,
  'login-failed': (e) => `Wrong password${e.kind ? ` from ${e.kind}` : ''}`,
  'login-locked': (e) => `Password logins from ${e.ip} locked for ${e.minutes} min after 10 wrong passwords`,
  'qr-expired': (e) => `Used or expired QR code opened${e.kind ? ` on ${e.kind}` : ''}`,
  'device-revoked': (e) => `${e.name} logged out ${REVOKED_BY[e.by] ?? ''}`.trim(),
  'device-blocked': (e) => `${e.name} blocked`,
  'device-unblocked': (e) => `${e.name} unblocked`,
  'device-approved': (e) => `${e.name} approved${e.by === 'qr' ? ' by scanning a QR code' : ''}`,
  'device-denied': (e) => `${e.name} denied`,
  'device-removed': (e) => `${e.name} removed while blocked`,
  'device-renamed': (e) => `${e.from} renamed to ${e.name}${byText(e)}`,
  'pending-expired': (e) => `${e.name} stopped waiting: nobody approved it in time`,
  'password-changed': (e) => `Password changed${byText(e)}${e.loggedOut ? `, ${plural(e.loggedOut, 'device')} logged out` : ''}`,
  'limit-changed': (e) => `Device limit changed from ${e.from} to ${e.to}${byText(e)}`,
  'approval-changed': (e) => (e.on ? 'New devices now need approval' : 'New devices no longer need approval'),
  'lockdown': (e) => `Lockdown: phone access closed, ${plural(e.devices, 'device')} logged out${closedText(e.closed) ? `, closed ${closedText(e.closed)}` : ''}${e.passwordChanged ? ', password changed' : ''}`,
  'access-connected': (e) => `Phone access opened${byText(e)}`,
  'access-disconnected': (e) => (e.by === 'heartbeat' ? 'Phone access closed: the admin page was closed' : `Phone access closed${byText(e)}`),
  'keep-open-changed': (e) => `Keep connection open turned ${e.on ? 'on' : 'off'}`,
  'autostart-changed': (e) => `Start automatically turned ${e.on ? 'on' : 'off'}${byText(e)}`,
  'service-installed': () => 'Installed as a launchd service',
  'server-stopped': () => 'Pocket Dev stopped from this page',
  'server-restarted': (e) => `Pocket Dev restarted from ${e.by === 'phone' ? 'a phone' : 'this page'}`,
};

function renderLog(entries) {
  $('logRows').replaceChildren(...(entries.length ? entries.map((e) => h('div', { class: `log-row ${e.category}` },
    h('time', { datetime: new Date(e.at).toISOString() }, stamp(e.at)),
    h('span', { class: 'what' }, (EVENT_TEXT[e.type] ?? ((x) => x.type))(e)),
    h('span', { class: 'where', title: e.ua ?? null }, e.ip ?? ''),
  )) : [h('p', { class: 'empty' }, logFilter === 'all' ? 'Nothing logged yet.' : 'Nothing matches this filter.')]));
}

document.querySelector('.seg').addEventListener('click', (e) => {
  const filter = e.target.closest('[data-filter]')?.dataset.filter;
  if (!filter) return;
  logFilter = filter;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  refresh(true);
});

// ---- Password

function renderPassword() {
  const form = $('pwForm');
  const locked = state.passwordFromEnv;
  for (const el of form.elements) el.disabled = locked;
  $('pwNote').textContent = locked
    ? 'The password comes from the POCKET_DEV_PASSWORD environment variable, which overrides any password set here. Remove it from where Pocket Dev starts, restart Pocket Dev, then change the password here.'
    : "You're at the Mac, so the current password isn't needed.";
}

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { next, confirm, logoutAll } = e.target.elements;
  $('pwErr').textContent = '';
  $('pwOk').textContent = '';
  if (next.value.length < 6) return void ($('pwErr').textContent = 'The new password needs at least 6 characters.');
  if (next.value !== confirm.value) return void ($('pwErr').textContent = 'The two passwords do not match.');
  try {
    const { loggedOut } = await api('POST', '/api/password', { next: next.value, logoutAll: logoutAll.checked });
    e.target.reset();
    next.blur();
    $('pwOk').textContent = loggedOut ? `Password changed. ${plural(loggedOut, 'device')} logged out.` : 'Password changed.';
  } catch (err) {
    $('pwErr').textContent = err.message;
  }
  refresh(true);
});

// ---- Settings

function renderSettings() {
  const { maxDevices, overview, requireApproval, urls } = state;
  const limit = limitDraft ?? maxDevices;
  $('limitOut').textContent = limit;
  document.querySelector('[data-step="-1"]').disabled = limit <= MIN_DEVICES;
  document.querySelector('[data-step="1"]').disabled = limit >= MAX_DEVICES;
  $('limitSave').disabled = limit === maxDevices;
  $('limitNote').textContent = limit < overview.loggedIn
    ? `${plural(overview.loggedIn, 'device is', 'devices are')} logged in, so new password logins stay refused until you log some out. Lowering the limit logs nobody out.`
    : 'Password logins stop at this many devices. QR logins always work and replace the device used least recently.';
  if (state.roleAccessEnabled) $('limitNote').textContent = `The device limit includes ${plural(overview.loggedIn, 'Admin device')} and ${plural(state.collaboratorSessions || 0, 'active collaborator session')}. Invitations never log out an Admin. New password logins always require Mac approval.`;
  $('approval').checked = requireApproval;
  const copy = (text) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyLink(text) }, 'Copy');
  $('urls').replaceChildren(
    h('dt', {}, 'Wi-Fi IP'), ...(urls.lan ? [h('dd', {}, urls.lan), copy(urls.lan)] : [h('dd', {}, state.network.wifi ? 'No network' : 'Wi-Fi access off'), h('span')]),
    h('dt', {}, 'Name'), ...(urls.mdns ? [h('dd', {}, urls.mdns), copy(urls.mdns)] : [h('dd', {}, 'Wi-Fi access off'), h('span')]),
    ...(urls.remote ? [h('dt', {}, 'Internet'), h('dd', {}, urls.remote), copy(urls.remote)] : []),
  );
}

document.querySelector('.stepper').addEventListener('click', (e) => {
  const step = Number(e.target.closest('[data-step]')?.dataset.step);
  if (!step) return;
  limitDraft = Math.min(MAX_DEVICES, Math.max(MIN_DEVICES, (limitDraft ?? state.maxDevices) + step));
  renderSettings();
});

$('limitSave').addEventListener('click', () => act(async () => {
  await api('PUT', '/api/settings', { maxDevices: limitDraft });
  limitDraft = null;
}, 'Device limit saved'));

async function setApproval(on) {
  await act(() => api('PUT', '/api/settings', { requireApproval: on }), on ? 'New password logins now wait for approval' : 'Approval turned off');
}
$('approval').addEventListener('change', (e) => setApproval(e.target.checked));

// ---- Share and login QR codes

const qrViews = {
  share: { button: 'shareQrBtn', box: 'shareQr', code: 'shareQrCode', url: 'shareQrUrl', copy: 'shareQrCopy', label: 'Show share QR' },
  login: { button: 'qrBtn', box: 'qr', code: 'qrCode', url: 'qrUrl', copy: 'qrCopy', label: 'Show login QR' },
};
let qrAddress = null;
let qrGeneration = 0;
let qrExpiryTimer = 0;
const qrLoading = new Set();

async function copyLink(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy. Select the link and copy it manually.', true);
  }
}

function clearQr(kind) {
  const view = qrViews[kind];
  $(view.box).hidden = true;
  $(view.code).replaceChildren();
  $(view.url).textContent = '';
  $(view.button).textContent = view.label;
  $(view.button).setAttribute('aria-expanded', 'false');
  if (kind === 'login') {
    clearTimeout(qrExpiryTimer);
    $('qrExpiry').textContent = '';
  }
}

// Codes point at the internet link when there is one, so a phone's first login lands on the address that works anywhere.
function renderSharing(online = true) {
  const address = online && state?.access.connected ? state.urls.remote ?? state.urls.lan : null;
  const reason = !online ? 'Cannot reach Pocket Dev. QR codes will be available when it reconnects.'
    : !state?.access.connected ? 'Press Connect above to share or log in a phone.'
      : !address ? (state.network.wifi ? 'Connect this Mac to Wi-Fi to show a QR code.' : 'Wait for the internet link to connect.') : '';
  $('sharingNote').textContent = state?.urls.remote ? 'Works from anywhere through your internet link.' : 'Scan from a phone on the same Wi-Fi as this Mac.';
  if (address !== qrAddress) {
    qrGeneration++;
    qrAddress = address;
    for (const kind of Object.keys(qrViews)) clearQr(kind);
    $('qrErr').textContent = '';
  }
  $('qrUnavailable').textContent = reason;
  $('qrUnavailable').hidden = !reason;
  $('qrTtl').textContent = state?.qrTtlMin ?? 10;
  for (const [kind, view] of Object.entries(qrViews)) {
    $(view.button).disabled = !address || qrLoading.has(kind);
    $(view.button).title = reason;
  }
}

for (const [kind, view] of Object.entries(qrViews)) {
  $(view.copy).addEventListener('click', () => copyLink($(view.url).textContent));
  $(view.button).addEventListener('click', async () => {
    if (!qrAddress || qrLoading.has(kind)) return;
    const generation = qrGeneration;
    qrLoading.add(kind);
    clearQr(kind);
    $(view.button).textContent = 'Creating…';
    $(view.button).setAttribute('aria-busy', 'true');
    $('qrErr').textContent = '';
    renderSharing();
    try {
      const { svg, url, expiresAt } = await api('POST', '/api/qr', { kind });
      if (generation !== qrGeneration) return;
      if ((kind === 'share' && new URL(url).search) || (kind === 'login' && !Number.isFinite(expiresAt))) {
        $('qrErr').textContent = 'Restart Pocket Dev to load the updated QR options, then try again.';
        return;
      }
      if (new URL(url).origin !== qrAddress) {
        $('qrErr').textContent = 'The Wi-Fi address changed. Try again for a current code.';
        return;
      }
      if (kind === 'login' && expiresAt <= Date.now()) {
        $('qrErr').textContent = 'The login QR expired. Show a new code.';
        return;
      }
      $(view.code).innerHTML = svg;
      $(view.url).textContent = url;
      $(view.box).hidden = false;
      $(view.button).setAttribute('aria-expanded', 'true');
      if (kind === 'login') {
        $('qrExpiry').textContent = `Expires at ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Works once.`;
        qrExpiryTimer = setTimeout(() => {
          clearQr('login');
          $('qrErr').textContent = 'The login QR expired. Show a new code.';
        }, expiresAt - Date.now());
      }
    } catch (err) {
      if (generation === qrGeneration) $('qrErr').textContent = err.message;
    } finally {
      qrLoading.delete(kind);
      $(view.button).removeAttribute('aria-busy');
      $(view.button).textContent = $(view.box).hidden ? view.label : kind === 'login' ? 'New login QR' : 'Refresh share QR';
      renderSharing($('offline').hidden);
    }
  });
}

// ---- Live overview

function renderLive() {
  $('liveSections').replaceChildren(...state.sections.map((s) => h('div', { class: 'live-section' },
    h('h3', {}, s.title, s.action && h('span', {}, String(s.items.length))),
    s.items.length ? s.items.map((item) => h('div', { class: 'live-item' },
      h('div', { class: 'cell' }, h('b', {}, item.label),
        h('small', {}, [...item.details, ...(item.startedAt ? [`started ${ago(item.startedAt)}`] : [])].join(' · '))),
      s.action && h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          if (!(await ask({ title: `${s.action} ${item.label}?`, body: s.warning ?? '', confirm: s.action, danger: true }))) return;
          await act(() => api('POST', `/api/sections/${s.id}/${encodeURIComponent(item.id)}`));
        },
      }, s.action))) : h('p', { class: 'empty' }, s.empty))));

  const optional = state.sections.filter((s) => s.lockdown === 'optional');
  const box = $('lockOptions');
  if (box.dataset.ids !== optional.map((s) => s.id).join()) {
    box.dataset.ids = optional.map((s) => s.id).join();
    box.replaceChildren(...optional.map((s) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', 'data-also': s.id }), h('span', {}, `Also close all ${s.title.toLowerCase()}`))));
  }
}

// ---- Service

let restarting = null;

function renderService() {
  const svc = state.service;
  $('svcLabel').textContent = svc.label;
  const status = svc.running
    ? `Running as a launchd service (pid ${svc.pid})${svc.isThisServer ? ', which is this copy' : ''}.`
    : svc.installed ? 'Installed, not running right now.' : 'Not installed. This copy runs only until it stops or the Mac restarts.';
  const body = svc.installed
    ? h('div', { class: 'setting' },
      h('label', { class: 'setting-text switch-label', for: 'autostart' }, h('b', {}, 'Start automatically when the Mac starts'),
        h('small', {}, "Starts when you log in. Turning this off doesn't stop Pocket Dev now; it only stays off after the next restart.")),
      h('input', { type: 'checkbox', role: 'switch', class: 'switch', id: 'autostart', checked: svc.autostart, onchange: (e) => act(() => api('PUT', '/api/service/autostart', { enabled: e.target.checked }), e.target.checked ? 'Starts automatically' : 'Stays off after the next restart') }))
    : h('div', { class: 'setting' },
      h('div', { class: 'setting-text' }, h('b', {}, 'Start automatically when the Mac starts'),
        h('small', {}, 'Installs Pocket Dev as a launchd service: it starts when you log in and restarts if it crashes.')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => install(false) }, 'Install service'));
  const canRestart = svc.running && svc.isThisServer;
  const restartButton = $('restartBtn');
  restartButton.disabled = !canRestart || !!restarting;
  restartButton.textContent = restarting ? 'Restarting…' : 'Restart Pocket Dev';
  restartButton.title = canRestart ? 'Load the latest code. This page reconnects automatically.'
    : 'Restart is available when Pocket Dev runs as the background service. See Service below.';
  const restartRow = h('div', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('b', {}, svc.updateReady ? 'Update ready' : 'Restart Pocket Dev'),
      h('small', {}, restarting ? 'Back in about 15 seconds. This page reloads by itself.' : !canRestart
        ? 'Only the background service can restart itself. Install the service first.'
        : svc.updateReady ? 'Newer code is on disk than what is running. Restart to start using it.' : 'Loads the latest code. Nothing newer is waiting right now.')),
    h('button', { class: `btn ${canRestart && svc.updateReady && !restarting ? 'btn-primary' : ''}`, type: 'button', disabled: !canRestart || !!restarting, onclick: restartServer },
      restarting ? `${restarting.verb}… ${Math.floor((Date.now() - restarting.at) / 1000)}s` : svc.updateReady ? 'Update now' : 'Restart'));
  $('svcBody').replaceChildren(h('p', { class: 'status-line' }, status), restartRow, body);
}

// What an update will and will not interrupt, from the live sections already on this page.
function restartWarning() {
  const items = (id) => state.sections.find((s) => s.id === id)?.items ?? [];
  const running = items('terminals').filter((t) => t.running);
  const kept = running.filter((t) => t.persistent).length;
  const ending = running.length - kept;
  const working = items('chats').length;
  const lines = [];
  if (kept) lines.push(`${plural(kept, 'terminal')} keep${kept === 1 ? 's' : ''} running.`);
  if (ending) lines.push(`${plural(ending, 'terminal')} will end.`);
  if (working) lines.push(`${plural(working, 'chat')} ${working === 1 ? 'is' : 'are'} working and will be cut off. They can be continued afterwards.`);
  if (!lines.length) lines.push('Nothing is running.');
  return `${lines.join(' ')} Your phone reconnects by itself and stays logged in. Back in about 15 seconds.`;
}

async function restartServer() {
  if (restarting || !state?.service.running || !state.service.isThisServer) return;
  if (!(await ask({ title: 'Restart Pocket Dev now?', body: restartWarning(), confirm: 'Restart' }))) return;
  try {
    await api('POST', '/api/service/restart');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  restarting = { verb: state.service.updateReady ? 'Updating' : 'Restarting', at: Date.now() };
  renderService();
  const tick = setInterval(renderService, 500);
  await new Promise((r) => setTimeout(r, 4000));
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch('/api/state', { cache: 'no-store', headers: { 'x-pocket-admin': '1' } })).ok) return location.reload();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  clearInterval(tick);
  restarting = null;
  renderService();
  toast('Pocket Dev has not come back yet. Check pocket-dev service status.', true);
}

$('restartBtn').addEventListener('click', restartServer);

async function install(force) {
  $('svcErr').textContent = '';
  const out = $('svcOutput');
  out.hidden = false;
  out.textContent = 'Installing…';
  try {
    const r = await api('POST', '/api/service/install', { force });
    out.textContent = r.output;
    toast('Installed');
  } catch (err) {
    out.textContent = err.message;
    if (!force && /in use by a process/.test(err.message)) {
      $('svcErr').replaceChildren("This copy of Pocket Dev holds the port. Install anyway: the service waits and starts once this copy stops. ",
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => install(true) }, 'Install anyway'));
    }
  }
  refresh(true);
}

$('stopBtn').addEventListener('click', async () => {
  if (!(await ask({ title: 'Stop Pocket Dev now?', body: 'Your phone disconnects and every terminal ends. Start again with npm start or npm run service:install.', confirm: 'Stop Pocket Dev', danger: true }))) return;
  try {
    await api('POST', '/api/stop');
    toast('Pocket Dev is stopping');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- Lockdown

$('lockBtn').addEventListener('click', async () => {
  const also = [...document.querySelectorAll('[data-also]:checked')].map((c) => c.dataset.also);
  const pending = state.overview.pending;
  const forwards = state.sections.find((s) => s.id === 'ports')?.items.length ?? 0;
  const lines = [
    '• Disconnects phone access. Only Connect on this page opens it again.',
    `• Logs out ${plural(state.overview.loggedIn + pending, 'device')}${pending ? ` (${pending} waiting for approval)` : ''}. Blocked devices stay blocked.`,
    `• Stops ${plural(forwards, 'port forward')} and cancels every login QR code.`,
    also.length ? `• Closes all ${also.join(' and ')}.` : '• Terminals keep running on the Mac.',
  ];
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (optional, 6+ characters)', 'aria-label': 'New password (optional)' });
  const extra = h('label', { class: 'ask-field' }, h('span', {}, 'Also change the password now'), password);
  for (;;) {
    if (!(await ask({ title: 'Lock down Pocket Dev?', body: lines.join('\n'), confirm: 'Lock down', danger: true, extra }))) return;
    if (!password.value || password.value.length >= 6) break;
    toast('The new password needs at least 6 characters, or leave it empty.', true);
  }
  await act(() => api('POST', '/api/lockdown', { also, ...(password.value && { password: password.value }) }),
    (r) => `Locked down: phone access closed, ${plural(r.devices, 'device')} logged out${r.passwordChanged ? ', password changed' : ''}`);
});

// ---- Refresh loop

// Typing, renaming, or an open dialog would lose input to a re-render.
const busy = () => editingId !== null || $('ask').open || netDraftKind !== null
  || (document.activeElement?.matches('input[type="text"], input[type="password"]') ?? false);

// A refresh asked for during another one runs right after it, so an action never shows stale data.
let refreshing = false;
let again = false;
async function refresh(force = false) {
  if (!force && busy()) return;
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    const [fresh, log] = await Promise.all([api('GET', '/api/state'), api('GET', `/api/log?filter=${logFilter}`)]);
    state = fresh;
    collaborators?.refresh();
    lastOk = Date.now();
    $('offline').hidden = true;
    renderConnection();
    renderInternet();
    renderOverview();
    renderPending();
    renderDevices();
    renderLog(log);
    renderPassword();
    renderSettings();
    renderSharing();
    renderLive();
    renderService();
    permissionsOnState(state);
  } catch {
    $('offline').hidden = false;
    $('restartBtn').disabled = true;
    renderSharing(false);
  } finally {
    refreshing = false;
    renderUpdated();
  }
  if (again) {
    again = false;
    await refresh(true);
  }
}

function renderUpdated() {
  $('updated').textContent = lastOk ? `Updated ${ago(lastOk)} · refreshes every 5 s` : '';
}

setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh(true);
