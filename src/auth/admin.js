import http from 'node:http';
import { WebSocketServer } from 'ws';
import { notificationSettings, updateNotificationSettings } from '../core/notifications.js';
import fs from 'node:fs';
import path from 'node:path';
import { platform } from '../core/platform.js';
import { PACKAGE_ROOT } from '../core/paths.js';
import { PROXY_HEADERS, STATE_DIR, deviceName } from './auth.js';
import { EVENT_KINDS, isLogFilter } from '../core/security-log.js';
import { serviceStatus, setAutostart, installService, stopThisServer, restartThisServer } from '../core/launchd.js';
import { createUpdateRunner } from '../setup/update-runner.js';
import { ADMIN_FRESH_MS } from '../setup/update.js';
import { checkPermissions, openPane } from './permissions.js';
import { captureScreen } from '../machine/screen.js';
import { svgQr, qrConnectionAddress } from '../network/qr.js';
import { readNetwork, networkError, isToken, hasToken, writeToken, findCloudflared } from '../network/network.js';
import { createContext, cachedStatus } from '../setup/setup.js';
import { createSetupActions } from '../setup/actions.js';
import { featureError } from '../core/features.js';
import { remotePermissions, changeRemotePermissions } from '../machine/remote-permissions.js';
import { createFolderBrowser } from '../workspace/folder-browser.js';

export const ADMIN_URL_PATH = path.join(STATE_DIR, 'admin.json');
const BODY_MAX = 16_000;
const HOUR_MS = 60 * 60_000;
const GUESSING_THRESHOLD = 5;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const FILES = {
  '/': ['admin.html', 'text/html; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/connection-qr.css': ['connection-qr.css', 'text/css; charset=utf-8'],
  '/connection-qr.js': ['connection-qr.js', 'text/javascript; charset=utf-8'],
  '/connected-computers.js': ['connected-computers.js', 'text/javascript; charset=utf-8'],
  '/connected-computers.css': ['connected-computers.css', 'text/css; charset=utf-8'],
  '/room.css': ['room.css', 'text/css; charset=utf-8'],
  '/room-invite.js': ['room-invite.js', 'text/javascript; charset=utf-8'],
  '/room-scan.js': ['room-scan.js', 'text/javascript; charset=utf-8'],
  '/vendor/jsqr/jsQR.js': ['vendor/jsqr/jsQR.js', 'text/javascript; charset=utf-8'],
  '/feature-guides.js': ['feature-guides.js', 'text/javascript; charset=utf-8'],
  '/feature-guides.css': ['feature-guides.css', 'text/css; charset=utf-8'],
  '/admin-screen-control.js': ['admin-screen-control.js', 'text/javascript; charset=utf-8'],
  '/admin-setup.js': ['admin-setup.js', 'text/javascript; charset=utf-8'],
  '/admin-client.js': ['admin-client.js', 'text/javascript; charset=utf-8'],
  '/admin-nav.js': ['admin-nav.js', 'text/javascript; charset=utf-8'],
  '/admin-heartbeat.js': ['admin-heartbeat.js', 'text/javascript; charset=utf-8'],
  '/admin-permissions.js': ['admin-permissions.js', 'text/javascript; charset=utf-8'],
  '/admin-camera.js': ['admin-camera.js', 'text/javascript; charset=utf-8'],
  '/admin-update.js': ['admin-update.js', 'text/javascript; charset=utf-8'],
  '/notification-preferences.js': ['notification-preferences.js', 'text/javascript; charset=utf-8'],
  '/notifications.css': ['notifications.css', 'text/css; charset=utf-8'],
  '/admin-update.css': ['admin-update.css', 'text/css; charset=utf-8'],
  '/collaborators.js': ['collaborators.js', 'text/javascript; charset=utf-8'],
  '/collaborators.css': ['collaborators.css', 'text/css; charset=utf-8'],
  '/messages.js': ['messages.js', 'text/javascript; charset=utf-8'],
  '/messages.css': ['messages.css', 'text/css; charset=utf-8'],
  '/folder-picker.js': ['folder-picker.js', 'text/javascript; charset=utf-8'],
  '/folder-picker.css': ['folder-picker.css', 'text/css; charset=utf-8'],
};
const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

const reply = (status, body) => ({ status, body });
const ok = (body) => reply(200, body);

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// '/api/devices/:id/:action' -> a matcher that returns { id, action } or null.
function compile(pattern) {
  const parts = pattern.split('/');
  return (pathname) => {
    const segs = pathname.split('/');
    if (segs.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (parts[i] !== segs[i]) return null;
    }
    return params;
  };
}

function router(table) {
  const compiled = Object.entries(table).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    return { method, match: compile(pattern), handler };
  });
  return (method, pathname) => {
    for (const r of compiled) {
      const params = r.method === method && r.match(pathname);
      if (params) return { handler: r.handler, params };
    }
    return null;
  };
}

// Groups the last hour's failed logins by address. A person mistyping fails once or twice; five suggests guessing.
function failedLogins(entries) {
  const byIp = new Map();
  for (const e of entries) byIp.set(e.ip, (byIp.get(e.ip) ?? 0) + 1);
  const ips = [...byIp].sort((a, b) => b[1] - a[1]).map(([ip, count]) => ({ ip, count }));
  return { count: entries.length, ips, guessing: entries.length >= GUESSING_THRESHOLD };
}

// `sections` is the live-overview registry (terminals, port forwards, and whatever a later feature adds). Each entry:
//   { title, empty, list() -> [{ id, label, details: [string], startedAt? }] (or a promise of it),
//     action?, warning?, act?(id) -> bool, lockdown?: 'always' | 'optional' }
// A section without act() is read-only. Lockdown closes 'always' sections and the 'optional' ones it is asked to.
// `urls()` returns the phone listener's current { lan, local, remote } base URLs.
const setupStatus = cachedStatus(createContext());

export async function startAdmin({ auth, collaborators, messages, access, tunnel, config, mainPort, urls, sections, connections = null, camera = null, media = camera, screenControl = null, update = null, updateMeta = null, onRemotePermissionsChange = () => {}, onNotificationSettingsChange = () => {}, onSetupChanged = () => {} }) {
  const setupActions = createSetupActions({ context: createContext(), config, stateDir: STATE_DIR, changed() { setupStatus.invalidate(); onSetupChanged(); } });
  const browseFolders = createFolderBrowser({ config });
  const port = Number(process.env.POCKET_DEV_ADMIN_PORT) || config.read().adminPort || mainPort + 1;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const url = `http://localhost:${port}`;

  // No login here: being at the Mac is the trust boundary. These checks stop other web pages and tunnels.
  function refusal(req) {
    if (PROXY_HEADERS.some((h) => h in req.headers)) return 'Proxied requests are refused.';
    if (!hosts.has(req.headers.host)) return 'Unknown Host header.';
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return 'Cross-origin requests are refused.';
    if (SAFE_METHODS.has(req.method)) return null;
    if (req.headers['x-pocket-admin'] !== '1') return 'Missing x-pocket-admin header.';
    const upload = req.url === '/api/messages/files' && req.headers['content-type'] === 'application/octet-stream';
    if (!upload && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return 'Send a JSON body.';
    return null;
  }

  const sectionViews = () => Promise.all(Object.entries(sections).map(async ([id, s]) => {
    const view = { id, title: s.title, empty: s.empty, action: s.act ? s.action : null, warning: s.warning, lockdown: s.lockdown ?? null };
    try {
      return { ...view, items: await s.list() };
    } catch (err) {
      return { ...view, items: [], empty: `Could not read: ${err.message}` };
    }
  }));
  const permissionsView = () => ({ ...remotePermissions(config), screenControlSupported: platform.platform === 'darwin', microphoneSupported: Boolean(camera) });

  async function state() {
    const a = auth.admin.state();
    // With the phone port closed nobody can be online, however recently they made a request.
    if (!access.view().connected) a.devices = a.devices.map((d) => ({ ...d, online: false }));
    const active = a.devices.filter((d) => d.status === 'active');
    const failures = auth.admin.recentLog({ filter: 'failures', since: Date.now() - HOUR_MS, limit: 10_000 })
      .filter((e) => e.type === 'login-failed');
    return {
      ...a,
      overview: {
        loggedIn: active.length,
        online: active.filter((d) => d.online).length,
        pending: a.devices.filter((d) => d.status === 'pending').length,
        failedLogins: failedLogins(failures),
      },
      access: access.view(),
      urls: {
        lan: urls().lan,
        mdns: urls().local,
        local: `http://localhost:${mainPort}`,
        remote: urls().remote,
      },
      network: networkState(),
      qrConnections: auth.qrConnections(),
      service: await serviceView(),
      permissionsSetup: config.read().permissionsSetup ?? null,
      camera: camera?.setupStatus() ?? null,
      screenControl: screenControl?.localState() ?? { state: 'off' },
      remotePermissions: permissionsView(),
      setup: setupActions.snapshot(),
      sections: await sectionViews(),
    };
  }

  // Disconnects phone access, logs out every device that is not blocked, stops forwards, cancels login codes, and
  // optionally sets a new password. Only Connect on this page lets phones back in.
  async function lockdown({ also = [], password }) {
    const optional = Object.keys(sections).filter((id) => sections[id].lockdown === 'optional');
    if (!Array.isArray(also) || also.some((id) => !optional.includes(id))) {
      return reply(400, { error: `also must list sections from: ${optional.join(', ') || 'none'}.` });
    }
    if (password !== undefined) {
      const invalid = auth.admin.newPasswordError(password);
      if (invalid) return reply(400, { error: invalid });
    }
    const closed = {};
    for (const [id, s] of Object.entries(sections)) {
      if (s.lockdown !== 'always' && !also.includes(id)) continue;
      closed[id] = 0;
      for (const item of await s.list()) if (await s.act(item.id)) closed[id]++;
    }
    const devices = auth.admin.lockdown(password);
    await access.close('lockdown');
    access.forgetForwards();
    auth.admin.log('lockdown', { devices, closed, passwordChanged: password !== undefined });
    return ok({ devices, closed, passwordChanged: password !== undefined, access: access.view() });
  }

  // The token itself never leaves the Mac: the page learns only whether one is saved.
  const networkState = () => ({ ...readNetwork(config), hasToken: hasToken(), cloudflared: findCloudflared(), tunnel: tunnel.view() });

  // Saves the network setting and applies it to the running tunnel: a changed kind, hostname or token restarts it, a
  // domain link starts as soon as phone access is connected, and a Quick link waits for Turn on.
  async function setNetwork({ wifi, internet, token }, by) {
    const current = readNetwork(config);
    if (token !== undefined && !isToken(token)) return reply(400, { error: 'The tunnel token is a long code without spaces. Copy only the token from the install command.' });
    if (internet !== undefined && (!internet || typeof internet !== 'object')) return reply(400, { error: 'internet must be { kind, hostname }.' });
    const kind = internet?.kind ?? current.internet.kind;
    const next = {
      wifi: wifi ?? current.wifi,
      internet: { kind, hostname: kind === 'domain' ? String(internet?.hostname ?? current.internet.hostname ?? '').trim().toLowerCase() || null : null },
    };
    const invalid = networkError(next, { hasToken: hasToken() || token !== undefined });
    if (invalid) return reply(400, { error: invalid });
    if (token !== undefined) writeToken(token);
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (changed) {
      config.update({ network: next });
      auth.admin.log('network-changed', { wifi: next.wifi, kind: next.internet.kind, hostname: next.internet.hostname, by });
    }
    const running = tunnel.view();
    if (running.status !== 'off' && (running.kind !== next.internet.kind || changed || token !== undefined)) await tunnel.stop();
    if (next.internet.kind === 'domain' && access.view().connected) await tunnel.start().catch(() => {});
    return ok(networkState());
  }

  async function setRemote(on) {
    if (typeof on !== 'boolean') return reply(400, { error: 'on must be true or false.' });
    try {
      return ok(on ? await tunnel.start() : await tunnel.stop());
    } catch (err) {
      return reply(409, { ...tunnel.view(), error: err.message });
    }
  }

  async function setAccess({ connected, keepOpen }, by) {
    if (connected !== undefined && typeof connected !== 'boolean') return reply(400, { error: 'connected must be true or false.' });
    if (keepOpen !== undefined && typeof keepOpen !== 'boolean') return reply(400, { error: 'keepOpen must be true or false.' });
    if (keepOpen !== undefined) access.setKeepOpen(keepOpen, by);
    if (connected === true) {
      const r = await access.open(by);
      if (r.error) return reply(409, { error: r.error, access: access.view() });
    }
    if (connected === false) await access.close(by);
    return ok(access.view());
  }

  // The service status plus what the quiet version check knows: { current, latest, available, command } or null.
  // `os` lets the phone word its update steps for this computer (Dock tile, Start menu, app menu).
  const serviceView = async () => {
    const view = update?.view() ?? null;
    return { ...(await serviceStatus()), updateReminders: notificationSettings(config).preferences.inAppUpdates, update: view && { ...view, os: process.platform } };
  };

  // The Admin page's Update button. It exists only when the quiet check is on and this copy knows its version.
  const updateRunner = update && updateMeta ? createUpdateRunner({
    versionCheck: update, kind: updateMeta.kind, version: updateMeta.version, readVersion: updateMeta.readVersion,
    serviceInfo: async () => { const svc = await serviceStatus(); return { installed: Boolean(svc.installed), running: Boolean(svc.running), isThisServer: Boolean(svc.isThisServer) }; },
    restartThisServer, log: (line) => console.error(line),
  }) : null;
  // A look at the registry when the last one is over an hour old, so the page does not show old news.
  async function updateView() {
    if (!updateRunner || !update.enabled()) return { enabled: false, available: false, phase: 'idle', canUpdate: false };
    await update.refresh({ maxAgeMs: ADMIN_FRESH_MS }).catch(() => {});
    return updateRunner.view();
  }

  async function changeAutostart({ enabled }, by) {
    if (typeof enabled !== 'boolean') return reply(400, { error: 'enabled must be true or false.' });
    const before = await serviceStatus();
    if (!before.installed) return reply(409, { error: `Pocket Dev is not installed as a service yet. Install it from the admin page on ${platform.host.the}.` });
    await setAutostart(enabled);
    if (before.autostart !== enabled) auth.admin.log('autostart-changed', { on: enabled, by, label: before.label });
    return ok(await serviceStatus());
  }

  // Only the launchd job restarts itself: a copy started with `npm start` that exits would just be gone.
  async function restart(by, req) {
    const svc = await serviceStatus();
    if (!svc.isThisServer) {
      return reply(409, { error: `This copy is not the background service, so it cannot restart itself. Stop it and run pocket-dev start, or install the service from the admin page on ${platform.host.the}.` });
    }
    if (req) auth.noteRestart(req);
    auth.admin.log('server-restarted', { by, updateReady: svc.updateReady });
    // Let this reply reach the caller before the process exits.
    setTimeout(restartThisServer, 300);
    return ok({ ok: true });
  }

  const SETUP_STATUSES = new Set(['done', 'skipped']);

  // "Allow" for Control System Events raises macOS's own prompt on this Mac and waits for the answer. Every other
  // permission has no prompt to raise, so it opens the System Settings page where the person turns it on.
  async function requestPermission(id) {
    let items = await checkPermissions({ ask: id === 'automation' });
    const item = items.find((i) => i.id === id);
    if (!item) return reply(404, { error: 'No such permission.' });
    const opened = item.state === 'missing' && !!item.pane;
    // node only appears in the Screen Recording list after it has tried to capture, so try once before opening it.
    if (opened && id === 'screenRecording') await captureScreen().catch(() => {});
    if (opened) openPane(item.pane);
    if (id === 'automation') items = await checkPermissions();
    return ok({ items, opened, setup: config.read().permissionsSetup ?? null });
  }

  const route = router({
    'GET /api/setup/plan': async () => ok(await setupActions.plan()),
    'POST /api/setup/actions': async ({ body }) => reply(202, await setupActions.start(body)),
    'POST /api/setup/progress': ({ body }) => ok(setupActions.progress(body.step)),
    'POST /api/setup/complete': async () => ok(await setupActions.complete()),
    'POST /api/screen/control/approve': async ({ body }) => {
      if (!screenControl || typeof body.requestId !== 'string' || typeof body.allow !== 'boolean') return reply(400, { error: 'Choose a current control request and approval decision.' });
      return ok(await screenControl.approve(body.requestId, body.allow));
    },
    'POST /api/screen/control/stop': () => { screenControl?.revokeCurrent(); return ok({ state: 'off' }); },
    'GET /api/remote-permissions': () => ok(permissionsView()),
    'PUT /api/remote-permissions': ({ body }) => {
      changeRemotePermissions(config, body, { camera: media, screenControl, changed: (changes) => { onRemotePermissionsChange(changes); onSetupChanged(); } });
      return ok(permissionsView());
    },
    'POST /api/camera/prepare': ({ body }) => {
      if (!camera) return reply(409, { error: 'Remote camera preparation requires the browser capture backend.' });
      try { return ok(camera.prepare(body.media)); }
      catch (err) { return reply(err.status || 400, { error: err.message }); }
    },
    'GET /api/permissions': async () => ok({ items: await checkPermissions(), setup: config.read().permissionsSetup ?? null }),
    'POST /api/permissions/setup': ({ body }) => {
      if (!SETUP_STATUSES.has(body.status)) return reply(400, { error: 'status must be done or skipped.' });
      config.update({ permissionsSetup: body.status });
      return ok({ setup: body.status });
    },
    'POST /api/permissions/:id/request': ({ params }) => requestPermission(params.id),
    'GET /api/notifications': () => ok(notificationSettings(config)),
    'PUT /api/notifications': ({ body }) => { const settings = updateNotificationSettings(config, body); onNotificationSettingsChange(); return ok(settings); },
    'GET /api/state': async () => ok(await state()),
    'GET /api/log': ({ query }) => {
      const filter = query.get('filter') ?? 'all';
      if (!isLogFilter(filter)) return reply(400, { error: 'filter must be all, failures, or changes.' });
      return ok(auth.admin.recentLog({ filter, limit: 200 })
        .map((e) => ({ ...e, category: EVENT_KINDS[e.type], ...(e.ua && { kind: deviceName(e.ua) }) })));
    },
    'POST /api/devices/:id/:action': ({ params }) => auth.admin.deviceAction(params.id, params.action),
    'PATCH /api/devices/:id': ({ params, body }) => auth.admin.rename(params.id, body.name),
    'PUT /api/settings': ({ body }) => auth.admin.updateSettings(body),
    'POST /api/password': ({ body }) => auth.admin.setPassword(body),
    'POST /api/recovery-code': () => auth.admin.createRecoveryCode(),
    'POST /api/qr': async ({ body }) => {
      const kind = body.kind ?? 'login';
      if (!['share', 'login'].includes(kind)) return reply(400, { error: 'kind must be share or login.' });
      if (!access.view().connected) return reply(409, { error: 'Phone access is off. Connect first, then show the code.' });
      const address = qrConnectionAddress(auth.qrConnections(), body.connection);
      if (kind === 'login') return ok(await auth.admin.mintQr(address));
      return ok({ url: address, svg: await svgQr(address) });
    },
    'POST /api/sections/:section/:item': async ({ params }) => {
      const s = Object.hasOwn(sections, params.section) ? sections[params.section] : null;
      if (!s?.act) return reply(404, { error: 'No such section' });
      return (await s.act(params.item)) ? ok({ ok: true }) : reply(404, { error: 'Already gone' });
    },
    'POST /api/lockdown': ({ body }) => lockdown(body),
    'PUT /api/access': ({ body }) => setAccess(body, body.by === 'cli' ? 'cli' : 'admin'),
    'PUT /api/network': ({ body }) => setNetwork(body, body.by === 'cli' ? 'cli' : 'admin'),
    'PUT /api/remote': ({ body }) => setRemote(body.on),
    'POST /api/heartbeat': () => {
      access.heartbeat();
      return ok(access.view());
    },
    'PUT /api/service/autostart': ({ body }) => changeAutostart(body, 'admin'),
    'POST /api/service/install': async ({ body }) => {
      const r = await installService({ port: mainPort, force: body.force === true });
      if (r.ok) {
        // The page offers Install in place of the autostart switch, so installing means turning it on.
        await setAutostart(true);
        auth.admin.log('service-installed', { by: 'admin', force: body.force === true });
      }
      return reply(r.ok ? 200 : 409, { ...r, service: await serviceStatus() });
    },
    'POST /api/service/restart': () => restart('admin'),
    'GET /api/update': async () => ok(await updateView()),
    'POST /api/update': async () => {
      if (!updateRunner || !update.enabled()) return reply(404, { error: 'Update checks are turned off.' });
      const r = await updateRunner.start();
      if (r.status === 202) auth.admin.log('update-started', { by: 'admin', from: updateMeta.version });
      return reply(r.status, r.body);
    },
    'POST /api/stop': () => {
      for (const item of sections.terminals?.list() ?? []) sections.terminals.act(item.id);
      auth.admin.log('server-stopped', { by: 'admin' });
      setTimeout(stopThisServer, 200);
      return ok({ ok: true });
    },
  });

  async function handle(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...HEADERS, 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const why = refusal(req);
    if (why) return send(403, { error: why });
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    try {
      if (connections && (pathname === '/api/connections' || pathname.startsWith('/api/connections/'))) {
        // Keep local Admin origin/CSRF checks and advertise the public port.
        req.headers = { ...req.headers, host: `localhost:${mainPort}` };
        return connections.handleApi(req, res, new URL(req.url, 'http://localhost'), { readJson, sendJson: (_res, status, body) => send(status, body), owner: true });
      }
      if (req.method === 'GET' && pathname === '/api/folders/browse') return send(200, await browseFolders(new URL(req.url, 'http://localhost')));
      if (req.method === 'GET' && pathname === '/api/setup/actions/events') return setupActions.stream(req, res, HEADERS);
      if (req.method === 'POST' && pathname === '/api/folders/create') return send(200, await browseFolders.create(await readJson(req)));
      if (pathname === '/api/messages' || pathname.startsWith('/api/messages/')) return messages.handleApi(req, res, { mac: true, headers: HEADERS });
      if (pathname === '/api/collaborators' || pathname.startsWith('/api/collaborators/')) {
        const r = await collaborators.ownerApi(req.method, pathname, SAFE_METHODS.has(req.method) ? {} : await readJson(req), true);
        return send(r.status, r.body);
      }
      const file = FILES[pathname];
      if (file && req.method === 'GET') {
        const text = fs.readFileSync(path.join(PACKAGE_ROOT, 'public', file[0]));
        res.writeHead(200, { ...HEADERS, 'content-type': file[1] });
        return res.end(text);
      }
      const found = route(req.method, pathname);
      if (!found) return send(404, { error: 'Not found' });
      const body = SAFE_METHODS.has(req.method) ? {} : await readJson(req);
      const r = await found.handler({ params: found.params, query: searchParams, body });
      send(r.status, r.body);
    } catch (err) {
      if (!res.headersSent) send(err.status || 400, err.feature ? featureError(err.feature, err) : { error: err.message });
    }
  }

  const listen = (host) => new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    if (screenControl) {
      const sockets = new WebSocketServer({ noServer: true, maxPayload: 2000 });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (refusal(req) || url.pathname !== '/ws/screen-control-host' || !screenControl.acceptsHost(url.searchParams.get('token'))) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        sockets.handleUpgrade(req, socket, head, (ws) => screenControl.attachHost(ws, url.searchParams.get('token')));
      });
      server.once('close', () => sockets.close());
    }
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
  try {
    await listen('127.0.0.1');
  } catch (err) {
    throw new Error(err.code === 'EADDRINUSE'
      ? `Admin port ${port} is in use. Set adminPort in config.json or POCKET_DEV_ADMIN_PORT to another port.`
      : `Could not open the admin page on port ${port}: ${err.message}`);
  }
  // Browsers may resolve localhost to ::1 first. A Mac without IPv6 loopback still has 127.0.0.1.
  await listen('::1').catch(() => {});
  fs.writeFileSync(ADMIN_URL_PATH, JSON.stringify({ url, pid: process.pid }) + '\n', { mode: 0o600 });

  // Routes the phone can call on the main listener, after the server checked its login.
  const phoneRoute = router({
    'GET /api/service': async () => ok(await serviceView()),
    'GET /api/notifications': () => ok(notificationSettings(config)),
    'PUT /api/notifications': ({ body }) => { const settings = updateNotificationSettings(config, body); onNotificationSettingsChange(); return ok(settings); },
    'GET /api/setup/status': async () => ok(await setupStatus()),
    'PUT /api/service/autostart': ({ body }) => changeAutostart(body, 'phone'),
    'POST /api/service/restart': ({ req }) => restart('phone', req),
    'POST /api/access/disconnect': () => {
      // Let this reply reach the phone before its connection closes.
      setTimeout(() => access.close('phone'), 200);
      return ok({ ok: true });
    },
    // Only the Mac can widen access; a phone may turn the internet link off.
    'PUT /api/network': ({ body }) => {
      if (readNetwork(config).internet.kind === 'off') return reply(404, { error: 'Not found' });
      if (body.wifi !== undefined || body.token !== undefined || body.internet?.kind !== 'off') return reply(403, { error: `Only ${platform.host.the} can turn internet access on. Use Admin on ${platform.host.the} or pocket-dev internet.` });
      return setNetwork({ internet: { kind: 'off' } }, 'phone');
    },
  });

  return {
    close() { setupActions.close(); },
    url,
    port,
    line: `Admin (${platform.host.this} only): ${url}`,
    openPage() {
      if (process.env.POCKET_DEV_NO_OPEN) return;
      if (!platform.openUrl(url)) console.warn(`Not available on this system: ${platform.capabilities().openUrl.reason} Open ${url} yourself.`);
    },
    async phoneApi(req, pathname, readBody) {
      const found = phoneRoute(req.method, pathname);
      if (!found) return null;
      const body = SAFE_METHODS.has(req.method) ? {} : await readBody();
      return found.handler({ req, params: found.params, body: body && typeof body === 'object' ? body : {} });
    },
  };
}
