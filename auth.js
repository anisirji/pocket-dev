import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { svgQr } from './qr.js';

const STATE_DIR = process.env.POCKET_DEV_STATE_DIR || path.join(os.homedir(), '.pocket-dev');
const DEVICES_PATH = path.join(STATE_DIR, 'devices.json');
export const LOCAL_SECRET_PATH = path.join(STATE_DIR, 'local-secret');
const QR_TTL_MS = Number(process.env.POCKET_DEV_QR_TTL_MS) || 10 * 60_000;
export const QR_TTL_MIN = Math.round(QR_TTL_MS / 60_000);
const ONLINE_WINDOW_MS = Number(process.env.POCKET_DEV_ONLINE_WINDOW_MS) || 60_000;
const LAST_SEEN_SAVE_MS = 30_000;
const DEFAULT_MAX_DEVICES = 2;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// A tunnel or reverse proxy on the Mac connects from loopback too; these headers mean the request came from elsewhere.
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
export const LOCAL_SECRET_HEADER = 'x-pocket-dev-secret';

const scrypt = promisify(crypto.scrypt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Hashing first gives equal-length buffers, so timingSafeEqual never leaks the length.
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const tokenHash = (token) => sha256(token).toString('hex');

function hashPassword(password) {
  const { N, r, p, keylen } = SCRYPT;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return { algo: 'scrypt', N, r, p, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

async function verifyPassword(given, { N, r, p, salt, hash }) {
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(given, Buffer.from(salt, 'base64'), expected.length, { N, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

const isPasswordHash = (v) => v?.algo === 'scrypt' && [v.N, v.r, v.p].every(Number.isInteger)
  && typeof v.salt === 'string' && typeof v.hash === 'string';

const isMaxDevices = (n) => Number.isInteger(n) && n >= 1 && n <= 20;

const OS_NAMES = [
  [/Android/, 'Android'], [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'macOS'], [/Windows/, 'Windows'], [/Linux/, 'Linux'],
];
// Order matters: Edge, Opera and Samsung all claim Chrome, and Chrome claims Safari.
const BROWSER_NAMES = [
  [/Edg(A|iOS)?\//, 'Edge'], [/OPR\//, 'Opera'], [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'], [/Chrome\/|CriOS\//, 'Chrome'], [/Safari\//, 'Safari'],
];

export function deviceName(ua = '') {
  const pick = (table) => table.find(([re]) => re.test(ua))?.[1];
  return [pick(OS_NAMES), pick(BROWSER_NAMES)].filter(Boolean).join(' · ') || 'Unknown device';
}

const clientIp = (req) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

function cookieToken(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'pd_token') return v;
  }
  return undefined;
}

const setCookie = (token) => `pd_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
const CLEAR_COOKIE = 'pd_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

function writePrivate(file, text) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const isStoredDevice = (d) => typeof d?.tokenHash === 'string' && typeof d.id === 'string'
  && typeof d.name === 'string' && Number.isFinite(d.lastSeen);

function loadDevices() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8')).devices;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring unreadable ${DEVICES_PATH}: ${err.message}`);
    return new Map();
  }
  return new Map((Array.isArray(stored) ? stored : []).filter(isStoredDevice).map(({ tokenHash: hash, ...d }) => [hash, d]));
}

const reply = (status, body, headers = {}) => ({ status, body, headers });
const redirect = (location) => reply(302, undefined, { location });
// A scanner app can open the QR link as a cross-site navigation. SameSite=Strict then withholds the new cookie on a
// redirect in that same navigation, so a same-origin script starts a fresh one; replace() also drops ?k= from history.
const BOUNCE_HOME = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  + '<title>Pocket Dev</title><style>html{background:#0b0e14}</style><script>location.replace("/")</script>';
const bounceHome = (cookie) => reply(200, BOUNCE_HOME, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookie });
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function parseDeviceName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  return name.length >= 1 && name.length <= 40 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}

// `config` is the server's config store (config.js): read() at use time, update() writes only the keys auth owns.
// `urls()` returns the current { lan, local } base URLs; lan is null while the Mac has no network.
export function createAuth({ config, port, urls, localNote }) {
  const envPassword = process.env.POCKET_DEV_PASSWORD;
  let passwordLine = envPassword ? `Password: ${envPassword} (from POCKET_DEV_PASSWORD)` : 'Password: (set; change it in Settings)';
  const startup = config.read();
  if (typeof startup.password === 'string') {
    config.update({ password: undefined, passwordHash: hashPassword(startup.password) });
  } else if (!startup.passwordHash && !envPassword) {
    const generated = crypto.randomBytes(9).toString('base64url');
    config.update({ passwordHash: hashPassword(generated) });
    passwordLine = `Password: ${generated}`;
  }
  const { passwordHash, maxDevices: startMax } = config.read();
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) {
    throw new Error('config.json: passwordHash is malformed. Delete it and set "password" to migrate a new one.');
  }
  if (startMax !== undefined && !isMaxDevices(startMax)) {
    console.warn(`config.json: maxDevices must be a whole number from 1 to 20; using ${DEFAULT_MAX_DEVICES}.`);
  }
  const maxDevices = () => {
    const n = config.read().maxDevices;
    return isMaxDevices(n) ? n : DEFAULT_MAX_DEVICES;
  };

  const devices = loadDevices();
  const sockets = new Map();
  const qrKeys = new Map();
  const localSecret = crypto.randomBytes(32).toString('hex');
  writePrivate(LOCAL_SECRET_PATH, JSON.stringify({ port, secret: localSecret }) + '\n');

  let saveTimer = null;
  function saveDevices() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const list = [...devices].map(([hash, d]) => ({ tokenHash: hash, ...d }));
    writePrivate(DEVICES_PATH, JSON.stringify({ devices: list }, null, 2) + '\n');
  }
  function saveDevicesSoon() {
    saveTimer ??= setTimeout(saveDevices, LAST_SEEN_SAVE_MS).unref();
  }

  function deviceFor(req) {
    const token = cookieToken(req);
    const device = token && devices.get(tokenHash(token));
    if (!device) return undefined;
    device.lastSeen = Date.now();
    device.ip = clientIp(req);
    saveDevicesSoon();
    return device;
  }

  function addDevice(req, via) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    devices.set(tokenHash(token), {
      id: crypto.randomBytes(4).toString('hex'),
      name: deviceName(req.headers['user-agent']),
      createdAt: now, lastSeen: now, ip: clientIp(req), via,
    });
    saveDevices();
    return setCookie(token);
  }

  const findDevice = (id) => [...devices].find(([, d]) => d.id === id);

  function revoke(id) {
    const entry = findDevice(id);
    if (!entry) return false;
    devices.delete(entry[0]);
    for (const ws of sockets.get(id) ?? []) ws.terminate();
    sockets.delete(id);
    saveDevices();
    return true;
  }

  const connections = (d) => sockets.get(d.id)?.size ?? 0;

  // A device holding a terminal open is in use right now, however long ago it connected.
  function evictLeastRecent() {
    const [victim] = [...devices.values()].sort((a, b) => (connections(a) > 0) - (connections(b) > 0) || a.lastSeen - b.lastSeen);
    revoke(victim.id);
  }

  function trackSocket(device, ws) {
    if (!sockets.has(device.id)) sockets.set(device.id, new Set());
    const set = sockets.get(device.id);
    set.add(ws);
    ws.on('close', () => {
      set.delete(ws);
      device.lastSeen = Date.now();
      saveDevicesSoon();
    });
  }

  function deviceView(d, now) {
    const n = connections(d);
    const { id, name, createdAt, lastSeen, ip, via } = d;
    return { id, name, createdAt, lastSeen, ip, via, connections: n, online: n > 0 || now - lastSeen < ONLINE_WINDOW_MS };
  }

  function listDevices() {
    const now = Date.now();
    return [...devices.values()].map((d) => deviceView(d, now)).sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  }

  function mintQrUrl() {
    const now = Date.now();
    for (const [key, expiresAt] of qrKeys) if (expiresAt <= now) qrKeys.delete(key);
    const key = crypto.randomBytes(32).toString('hex');
    qrKeys.set(key, now + QR_TTL_MS);
    const { lan, local } = urls();
    return `${lan ?? local}/?k=${key}`;
  }

  function redeemQrKey(req, key) {
    const expiresAt = qrKeys.get(key);
    qrKeys.delete(key);
    if (deviceFor(req)) return redirect('/');
    if (!expiresAt || expiresAt <= Date.now()) return redirect('/login.html?e=qr');
    if (devices.size >= maxDevices()) evictLeastRecent();
    return bounceHome(addDevice(req, 'qr'));
  }

  const passwordMatches = (given) => (envPassword ? sameSecret(given, envPassword) : verifyPassword(given, config.read().passwordHash));

  const isLocalRequest = (req) => LOOPBACK.has(req.socket.remoteAddress)
    && !PROXY_HEADERS.some((h) => h in req.headers)
    && typeof req.headers[LOCAL_SECRET_HEADER] === 'string' && sameSecret(req.headers[LOCAL_SECRET_HEADER], localSecret);

  const routes = {
    async 'POST /api/login'({ req, body }) {
      const { password } = await body();
      if (typeof password !== 'string' || !(await passwordMatches(password))) {
        await sleep(1000);
        return reply(401, { error: 'Wrong password' });
      }
      const max = maxDevices();
      if (devices.size >= max) {
        return reply(403, { error: `Device limit reached (${max}). Log out a device in Settings on a logged-in device, or scan the QR code from the Mac.` });
      }
      return reply(200, { ok: true }, { 'set-cookie': addDevice(req, 'password') });
    },
    'POST /api/qr-key'({ req }) {
      if (!isLocalRequest(req)) return reply(403, { error: 'Only the Mac itself can create login keys.' });
      return reply(200, { url: mintQrUrl(), expiresInMin: QR_TTL_MIN });
    },
    'POST /api/logout'({ device }) {
      revoke(device.id);
      return reply(204, undefined, { 'set-cookie': CLEAR_COOKIE });
    },
    'GET /api/settings'({ device }) {
      return reply(200, { maxDevices: maxDevices(), currentDeviceId: device.id, devices: listDevices(), urls: { ...urls(), localNote } });
    },
    async 'PUT /api/settings/max-devices'({ body }) {
      const { maxDevices: n } = await body();
      if (!isMaxDevices(n)) return reply(400, { error: 'The device limit must be a whole number from 1 to 20.' });
      config.update({ maxDevices: n });
      return reply(200, { maxDevices: n });
    },
    async 'PATCH /api/devices/:id'({ id, body }) {
      const entry = findDevice(id);
      if (!entry) return reply(404, { error: 'No such device' });
      const name = parseDeviceName((await body()).name);
      if (!name) return reply(400, { error: 'The name must be 1 to 40 characters on one line.' });
      entry[1].name = name;
      saveDevices();
      return reply(200, deviceView(entry[1], Date.now()));
    },
    'DELETE /api/devices/:id'({ id, device }) {
      if (!revoke(id)) return reply(404, { error: 'No such device' });
      return reply(204, undefined, id === device.id ? { 'set-cookie': CLEAR_COOKIE } : {});
    },
    async 'POST /api/settings/password'({ device, body }) {
      if (envPassword) return reply(409, { error: 'The password comes from POCKET_DEV_PASSWORD on the Mac. Change it there.' });
      const { current, next, logoutOthers = false } = await body();
      if (typeof current !== 'string' || typeof next !== 'string' || typeof logoutOthers !== 'boolean') {
        return reply(400, { error: 'Send current and next as text and logoutOthers as true or false.' });
      }
      if (next.length < 4 || next.length > 200) return reply(400, { error: 'The new password needs 4 to 200 characters.' });
      if (!(await passwordMatches(current))) {
        await sleep(1000);
        return reply(403, { error: 'The current password is wrong.' });
      }
      config.update({ passwordHash: hashPassword(next) });
      const others = logoutOthers ? [...devices.values()].filter((d) => d.id !== device.id) : [];
      for (const d of others) revoke(d.id);
      return reply(200, { ok: true, loggedOut: others.length });
    },
    async 'POST /api/settings/qr-key'() {
      const url = mintQrUrl();
      return reply(200, { url, svg: await svgQr(url), expiresInMin: QR_TTL_MIN });
    },
  };
  const PUBLIC_ROUTES = new Set(['POST /api/login', 'POST /api/qr-key']);

  // Returns null for paths it does not own, so the server can route them.
  async function handleApi(req, pathname, readBody) {
    const deviceRoute = /^\/api\/devices\/([^/]+)$/.exec(pathname);
    const route = `${req.method} ${deviceRoute ? '/api/devices/:id' : pathname}`;
    const handler = routes[route];
    if (!handler) return null;
    const body = async () => asObject(await readBody());
    if (PUBLIC_ROUTES.has(route)) return handler({ req, body });
    const device = deviceFor(req);
    if (!device) return reply(401, { error: 'Not logged in' });
    return handler({ req, body, device, id: deviceRoute?.[1] });
  }

  return { passwordLine, deviceFor, trackSocket, mintQrUrl, redeemQrKey, isLocalRequest, handleApi };
}
