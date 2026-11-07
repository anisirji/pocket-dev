import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROXY_HEADERS, STATE_DIR, deviceName } from './auth.js';
import { EVENT_KINDS, isLogFilter } from './security-log.js';
import { serviceStatus, setAutostart, installService, stopThisServer } from './launchd.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_URL_PATH = path.join(STATE_DIR, 'admin.json');
const BODY_MAX = 16_000;
const HOUR_MS = 60 * 60_000;
const GUESSING_THRESHOLD = 5;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const FILES = {
  '/': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/admin-client.js': ['admin-client.js', 'text/javascript; charset=utf-8'],
  '/admin-heartbeat.js': ['admin-heartbeat.js', 'text/javascript; charset=utf-8'],
};
const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
// `urls()` returns the phone listener's current { lan, local } base URLs.
export async function startAdmin({ auth, access, config, mainPort, urls, sections }) {
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
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return 'Send a JSON body.';
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
      },
      service: await serviceStatus(),
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

  async function changeAutostart({ enabled }, by) {
    if (typeof enabled !== 'boolean') return reply(400, { error: 'enabled must be true or false.' });
    const before = await serviceStatus();
    if (!before.installed) return reply(409, { error: 'Pocket Dev is not installed as a service yet. Install it from the admin page on the Mac.' });
    await setAutostart(enabled);
    if (before.autostart !== enabled) auth.admin.log('autostart-changed', { on: enabled, by, label: before.label });
    return ok(await serviceStatus());
  }

  const route = router({
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
    'POST /api/qr': async () => (access.view().connected
      ? ok(await auth.admin.mintQr())
      : reply(409, { error: 'Phone access is off. Connect first, then show the code.' })),
    'POST /api/sections/:section/:item': async ({ params }) => {
      const s = Object.hasOwn(sections, params.section) ? sections[params.section] : null;
      if (!s?.act) return reply(404, { error: 'No such section' });
      return (await s.act(params.item)) ? ok({ ok: true }) : reply(404, { error: 'Already gone' });
    },
    'POST /api/lockdown': ({ body }) => lockdown(body),
    'PUT /api/access': ({ body }) => setAccess(body, body.by === 'cli' ? 'cli' : 'admin'),
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
    'POST /api/stop': () => {
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
      const file = FILES[pathname];
      if (file && req.method === 'GET') {
        const text = fs.readFileSync(path.join(ROOT, 'public', file[0]));
        res.writeHead(200, { ...HEADERS, 'content-type': file[1] });
        return res.end(text);
      }
      const found = route(req.method, pathname);
      if (!found) return send(404, { error: 'Not found' });
      const body = SAFE_METHODS.has(req.method) ? {} : await readJson(req);
      const r = await found.handler({ params: found.params, query: searchParams, body });
      send(r.status, r.body);
    } catch (err) {
      if (!res.headersSent) send(400, { error: err.message });
    }
  }

  const listen = (host) => new Promise((resolve, reject) => {
    const server = http.createServer(handle);
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
  fs.writeFileSync(ADMIN_URL_PATH, JSON.stringify({ url }) + '\n', { mode: 0o600 });

  // Routes the phone can call on the main listener, after the server checked its login.
  const phoneRoute = router({
    'GET /api/service': async () => ok(await serviceStatus()),
    'PUT /api/service/autostart': ({ body }) => changeAutostart(body, 'phone'),
    'POST /api/access/disconnect': () => {
      // Let this reply reach the phone before its connection closes.
      setTimeout(() => access.close('phone'), 200);
      return ok({ ok: true });
    },
  });

  return {
    url,
    line: `Admin (this Mac only): ${url}`,
    openPage() {
      if (process.env.POCKET_DEV_NO_OPEN) return;
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    },
    async phoneApi(req, pathname, readBody) {
      const found = phoneRoute(req.method, pathname);
      if (!found) return null;
      const body = SAFE_METHODS.has(req.method) ? {} : await readBody();
      return found.handler({ params: found.params, body: body && typeof body === 'object' ? body : {} });
    },
  };
}
