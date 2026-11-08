import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { svgQr } from './qr.js';
import { createSecurityLog } from './security-log.js';
import { STATE_DIR } from './paths.js';
import { clientIp, cookieHost, secureCookie } from './transport.js';
import { ipv6Prefix } from './network.js';

export { STATE_DIR };
const DEVICES_PATH = path.join(STATE_DIR, 'devices.json');
export const LOCAL_SECRET_PATH = path.join(STATE_DIR, 'local-secret');
// After the phone asks for an update, the same browser on the same network may log in by password without waiting for
// approval, once, for a while: the owner cannot walk to the Mac, and nobody else asked for this restart.
const GRACE_PATH = path.join(STATE_DIR, 'restart-grace.json');
const GRACE_MS = Number(process.env.POCKET_DEV_GRACE_MS) || 10 * 60_000;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QR_TTL_MS = Number(process.env.POCKET_DEV_QR_TTL_MS) || 10 * 60_000;
export const QR_TTL_MIN = Math.round(QR_TTL_MS / 60_000);
const ONLINE_WINDOW_MS = Number(process.env.POCKET_DEV_ONLINE_WINDOW_MS) || 60_000;
const LAST_SEEN_SAVE_MS = 30_000;
const PENDING_TTL_MS = Number(process.env.POCKET_DEV_PENDING_TTL_MS) || 10 * 60_000;
// A handoff token is asked for when the person taps Switch and used by the redirect that follows.
const HANDOFF_TTL_MS = Number(process.env.POCKET_DEV_HANDOFF_TTL_MS) || 60_000;
const LOGIN_WINDOW_MS = Number(process.env.POCKET_DEV_LOGIN_WINDOW_MS) || 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const LOG_MAX_BYTES = Number(process.env.POCKET_DEV_LOG_MAX_BYTES) || 1_000_000;
const MIN_PASSWORD = 6;
const UA_MAX = 300;
const DEFAULT_MAX_DEVICES = 2;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// A tunnel or reverse proxy on the Mac connects from loopback too; these headers mean the request came from elsewhere.
export const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
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

const networkKey = (ip) => ipv6Prefix(ip) ?? ip;
const newRecoveryCode = () => Array.from({ length: 16 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)])
  .join('').replace(/(.{4})(?=.)/g, '$1-');
const normalizeRecoveryCode = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

const isMaxDevices = (n) => Number.isInteger(n) && n >= 1 && n <= 20;
const newPasswordError = (next) => (typeof next !== 'string' || next.length < MIN_PASSWORD || next.length > 200
  ? `The new password needs ${MIN_PASSWORD} to 200 characters.` : null);

// A device is exactly one of these. Only active devices may use the API, open terminals, or count toward the limit.
const STATUSES = ['pending', 'active', 'blocked'];
const REFUSALS = {
  pending: { error: 'Waiting for approval on the Mac.', pending: true },
  blocked: { error: 'This device is blocked. Ask the Mac owner to unblock it.', blocked: true },
};

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

// A device holds one cookie per address it has used (the Wi-Fi address, the .local name, the internet link), so a
// phone switching between them stays one device. Each cookie works only on the host it was issued for: a tunnel
// hostname, or 'lan' for every direct address. Files from before this was recorded held a single tokenHash, and a
// cookie saved without a host is a Wi-Fi cookie, the only address there was.
const MAX_COOKIES_PER_DEVICE = 8;
const isCookie = (c) => typeof c === 'string' || typeof c?.hash === 'string';
const asCookie = (c) => (typeof c === 'string' ? { hash: c, host: 'lan' } : { hash: c.hash, host: typeof c.host === 'string' ? c.host : 'lan' });
const isHashList = (v) => Array.isArray(v) && v.length > 0 && v.every(isCookie);
const isStoredDevice = (d) => (typeof d?.tokenHash === 'string' || isHashList(d?.tokenHashes)) && typeof d.id === 'string'
  && typeof d.name === 'string' && Number.isFinite(d.lastSeen) && (d.status === undefined || STATUSES.includes(d.status));

function loadDevices() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8')).devices;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring unreadable ${DEVICES_PATH}: ${err.message}`);
    return new Map();
  }
  // Devices saved before approval and blocking existed have no status; they were logged in.
  return new Map((Array.isArray(stored) ? stored : []).filter(isStoredDevice)
    .map(({ tokenHash: hash, tokenHashes, status = 'active', ...d }) => [d.id, { ...d, status, tokenHashes: (isHashList(tokenHashes) ? tokenHashes : [hash]).map(asCookie) }]));
}

const reply = (status, body, headers = {}) => ({ status, body, headers });
const redirect = (location) => reply(302, undefined, { location });
// A scanner app can open the QR link as a cross-site navigation. SameSite=Strict then withholds the new cookie on a
// redirect in that same navigation, so a same-origin script starts a fresh one; replace() also drops ?k= from history.
// The fragment is kept: a handoff link carries the terminal or chat to reopen there.
const BOUNCE_HOME = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  + '<title>Pocket Dev</title><style>html{background:#0b0e14}</style><script>location.replace("/" + location.hash)</script>';
// `landing` is the query the page opens with; the phone uses ?linked=1 to know it just linked to the internet address.
const bounceHome = (cookie, landing = '') => reply(200, BOUNCE_HOME.replace('"/"', `"/${landing}"`), { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookie });
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function parseDeviceName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  return name.length >= 1 && name.length <= 40 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}

// Counts wrong passwords per IP address. LOGIN_MAX_FAILURES inside the window lock that address out for one window.
function createLoginLimiter() {
  const byIp = new Map();
  return {
    lockedForMs(ip) {
      return Math.max(0, (byIp.get(ip)?.lockedUntil ?? 0) - Date.now());
    },
    // True when this failure starts a lockout.
    fail(ip) {
      const now = Date.now();
      const entry = byIp.get(ip) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
      entry.failures.push(now);
      byIp.set(ip, entry);
      if (entry.failures.length < LOGIN_MAX_FAILURES) return false;
      entry.failures = [];
      entry.lockedUntil = now + LOGIN_WINDOW_MS;
      return true;
    },
    succeed(ip) {
      byIp.delete(ip);
    },
  };
}

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
const lockedMessage = (ip, ms) => `Too many wrong passwords from ${ip}. Try again in ${minutes(ms)} min.`;

// `config` is the server's config store (config.js): read() at use time, update() writes only the keys auth owns
// (undefined removes a key). `urls()` returns the current { lan, local } base URLs; lan is null while the Mac has no network.
export function createAuth({ config, port, urls, localNote, extraActiveCount = () => 0, onLockdown = () => {} }) {
  const envPassword = process.env.POCKET_DEV_PASSWORD;
  let passwordLine = envPassword ? `Password: ${envPassword} (from POCKET_DEV_PASSWORD)` : 'Password: (set; change it in Settings)';
  const boot = config.read();
  if (typeof boot.password === 'string') {
    config.update({ passwordHash: hashPassword(boot.password), password: undefined });
  } else if (!boot.passwordHash && !envPassword) {
    const generated = crypto.randomBytes(9).toString('base64url');
    config.update({ passwordHash: hashPassword(generated) });
    passwordLine = `Password: ${generated}`;
  }
  const { passwordHash, maxDevices: bootMax, requireApproval: bootApproval } = config.read();
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) {
    throw new Error('config.json: passwordHash is malformed. Delete it and set "password" to migrate a new one.');
  }
  if (bootMax !== undefined && !isMaxDevices(bootMax)) {
    console.warn(`config.json: maxDevices must be a whole number from 1 to 20; using ${DEFAULT_MAX_DEVICES}.`);
  }
  if (bootApproval !== undefined && typeof bootApproval !== 'boolean') {
    console.warn('config.json: requireApproval must be true or false; using false.');
  }
  const maxDevices = () => {
    const n = config.read().maxDevices;
    return isMaxDevices(n) ? n : DEFAULT_MAX_DEVICES;
  };
  const requireApproval = () => config.read().requireApproval === true;
  const rolesEnabled = () => config.read().roleAccessEnabled === true;
  // Off by default. Only the Mac turns it on; a phone may turn it off. With roles on, only Admin devices approve.
  const approveFromDevices = () => config.read().approveFromDevices === true;
  const mayApprove = (device) => approveFromDevices() && isActive(device) && (!rolesEnabled() || device.role === 'admin');

  const devices = loadDevices();
  const sockets = new Map();
  const qrKeys = new Map();
  const handoffs = new Map();
  const limiter = createLoginLimiter();
  const localSecret = crypto.randomBytes(32).toString('hex');
  writePrivate(LOCAL_SECRET_PATH, JSON.stringify({ port, secret: localSecret }) + '\n');
  const securityLog = createSecurityLog(path.join(STATE_DIR, 'security.log'), LOG_MAX_BYTES);
  const log = securityLog.append;

  let saveTimer = null;
  function saveDevices() {
    clearTimeout(saveTimer);
    saveTimer = null;
    // tokenHash is also written so an older Pocket Dev reading this file keeps the device's most recent cookie.
    const list = [...devices.values()].map((d) => ({ tokenHash: d.tokenHashes[d.tokenHashes.length - 1].hash, ...d }));
    writePrivate(DEVICES_PATH, JSON.stringify({ devices: list }, null, 2) + '\n');
  }
  function saveDevicesSoon() {
    saveTimer ??= setTimeout(saveDevices, LAST_SEEN_SAVE_MS).unref();
  }

  const requestInfo = (req) => ({ ip: clientIp(req), ua: String(req.headers['user-agent'] ?? '').slice(0, UA_MAX) });
  const about = (d) => ({ deviceId: d.id, name: d.name, ip: d.ip });
  const isActive = (d) => d.status === 'active' && (!rolesEnabled() || d.role === 'admin');
  const activeCount = () => [...devices.values()].filter(isActive).length;
  const totalActiveCount = () => activeCount() + extraActiveCount();

  function expirePending() {
    const now = Date.now();
    const expired = [...devices.values()].filter((d) => d.status === 'pending' && now - d.createdAt >= PENDING_TTL_MS);
    for (const d of expired) {
      devices.delete(d.id);
      log('pending-expired', about(d));
    }
    if (expired.length) saveDevices();
  }

  // Any status; callers decide what a pending or blocked device may do. A cookie counts only on the host it was issued
  // for, so a Wi-Fi cookie read off the network is no login on the internet address. The cookie just used moves to the
  // end of the device's list, so the list stays in order of use and the cap drops the address used longest ago.
  function lookup(req) {
    expirePending();
    const token = cookieToken(req);
    if (!token) return undefined;
    const hash = tokenHash(token), host = cookieHost(req);
    const device = [...devices.values()].find((d) => d.tokenHashes.some((c) => c.hash === hash && c.host === host));
    if (!device) return undefined;
    const used = device.tokenHashes.find((c) => c.hash === hash);
    if (device.tokenHashes[device.tokenHashes.length - 1] !== used) {
      device.tokenHashes.splice(device.tokenHashes.indexOf(used), 1);
      device.tokenHashes.push(used);
    }
    device.lastSeen = Date.now();
    device.ip = clientIp(req);
    saveDevicesSoon();
    return device;
  }

  // Gives the device one more cookie for `host`, the address this request arrived on, or replaces the one it sent.
  function addCookie(req, device, host = cookieHost(req)) {
    const token = crypto.randomBytes(32).toString('hex');
    const current = cookieToken(req);
    const i = current ? device.tokenHashes.findIndex((c) => c.hash === tokenHash(current)) : -1;
    const cookie = { hash: tokenHash(token), host };
    if (i >= 0) device.tokenHashes[i] = cookie;
    else device.tokenHashes.push(cookie);
    device.tokenHashes.splice(0, Math.max(0, device.tokenHashes.length - MAX_COOKIES_PER_DEVICE));
    saveDevices();
    return secureCookie(req, setCookie(token));
  }
  const hasCookieFor = (device, host) => device.tokenHashes.some((c) => c.host === host);

  function deviceFor(req) {
    const device = lookup(req);
    return device && isActive(device) ? device : undefined;
  }

  function addDevice(req, via, status) {
    const now = Date.now();
    const { ip, ua } = requestInfo(req);
    const device = { id: crypto.randomBytes(4).toString('hex'), name: deviceName(ua), ua, createdAt: now, lastSeen: now, ip, via, status, tokenHashes: [], ...(rolesEnabled() && status === 'active' && { role: 'admin' }) };
    devices.set(device.id, device);
    return { cookie: addCookie(req, device), device };
  }

  const findDevice = (id) => devices.get(id);
  const findActive = (id) => {
    const d = devices.get(id);
    return d && isActive(d) ? d : undefined;
  };

  function closeSockets(id) {
    for (const ws of sockets.get(id) ?? []) ws.terminate();
    sockets.delete(id);
  }

  // Every cookie the device holds stops working at once.
  function drop(d) {
    devices.delete(d.id);
    closeSockets(d.id);
    saveDevices();
  }

  function revoke(id, by) {
    const d = findDevice(id);
    if (!d) return false;
    drop(d);
    log('device-revoked', { ...about(d), by });
    return true;
  }

  const connections = (d) => sockets.get(d.id)?.size ?? 0;

  // A device holding a terminal open is in use right now, however long ago it connected.
  function evictLeastRecent() {
    const [victim] = [...devices.values()].filter(isActive)
      .sort((a, b) => (connections(a) > 0) - (connections(b) > 0) || a.lastSeen - b.lastSeen);
    revoke(victim.id, 'qr-eviction');
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

  function notifyPending(notice) {
    const data = JSON.stringify({ t: 'waiting', ...notice });
    // The shared WebSocket server also serves guests. Only sockets tracked for eligible owner devices hear this.
    for (const [id, clients] of sockets) {
      const device = devices.get(id);
      if (!device || !mayApprove(device)) continue;
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function deviceView(d, now) {
    const n = connections(d);
    const { id, name, createdAt, lastSeen, ip, via, status } = d;
    return {
      id, name, createdAt, lastSeen, ip, via, status,
      role: d.role || 'unreviewed',
      kind: d.ua ? deviceName(d.ua) : null,
      code: id.slice(-4),
      connections: n,
      online: n > 0 || now - lastSeen < ONLINE_WINDOW_MS,
      ...(status === 'pending' && { expiresAt: createdAt + PENDING_TTL_MS }),
    };
  }

  function listDevices(keep = () => true) {
    expirePending();
    const now = Date.now();
    return [...devices.values()].filter(keep).map((d) => deviceView(d, now))
      .sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  }

  function mintQrUrl(address) {
    const now = Date.now();
    for (const [key, expiresAt] of qrKeys) if (expiresAt <= now) qrKeys.delete(key);
    const { lan, local, remote } = urls();
    // A phone's first login should happen on the internet address when there is one; Wi-Fi then comes by handoff.
    const base = address ?? remote ?? lan ?? local;
    if (!base) throw Object.assign(new Error('No address to share yet. Turn on Wi-Fi access, or wait for the internet link to connect.'), { status: 409 });
    const key = crypto.randomBytes(32).toString('hex');
    qrKeys.set(key, now + QR_TTL_MS);
    return `${base}/?k=${key}`;
  }

  function redeemQrKey(req, key) {
    const expiresAt = qrKeys.get(key);
    qrKeys.delete(key);
    const existing = lookup(req);
    // A blocked device stays blocked; it lands on its notice.
    if (existing && existing.status !== 'pending') return redirect('/');
    if (!expiresAt || expiresAt <= Date.now()) {
      log('qr-expired', requestInfo(req));
      return redirect('/login.html?e=qr');
    }
    if (totalActiveCount() >= maxDevices()) {
      if (!activeCount()) return redirect('/login.html?e=limit');
      evictLeastRecent();
    }
    // Scanning a code from the Mac proves physical access, so it approves a waiting device.
    if (existing) {
      existing.status = 'active';
      if (rolesEnabled()) existing.role = 'admin';
      existing.via = 'qr';
      saveDevices();
      log('device-approved', { ...about(existing), by: 'qr' });
      return redirect('/');
    }
    const { cookie, device } = addDevice(req, 'qr', 'active');
    log('login', { via: 'qr', ...about(device), ua: device.ua });
    return bounceHome(cookie);
  }

  // A logged-in device asks for a handoff token on one address, then opens the other address with it to get a
  // cookie there too: 'to-lan' from the internet link to the Wi-Fi address, 'to-remote' the other way. Only the
  // hash is kept, the token works once, and it is bound to the direction and the host it was minted for.
  function mintHandoff(device, { direction, host }) {
    const now = Date.now();
    for (const [hash, h] of handoffs) if (h.expiresAt <= now) handoffs.delete(hash);
    const token = crypto.randomBytes(32).toString('hex');
    handoffs.set(tokenHash(token), { deviceId: device.id, direction, host, expiresAt: now + HANDOFF_TTL_MS });
    log('handoff-created', { ...about(device), direction, host });
    return token;
  }

  // `arrival` is how the request came in: { direction: 'to-lan', host: 'lan' } directly on the Mac's Wi-Fi address,
  // { direction: 'to-remote', host } through the tunnel on that hostname, or null. A token used on the wrong side,
  // or for a hostname the link no longer has, is refused and spent. The device keeps its identity, status and role,
  // so nothing waits for approval, is counted or evicted.
  function redeemHandoff(req, token, arrival) {
    const hash = tokenHash(token);
    const entry = handoffs.get(hash);
    handoffs.delete(hash);
    const refuse = (reason) => {
      log('handoff-failed', { reason, ...requestInfo(req) });
      return redirect('/login.html?e=handoff');
    };
    if (!entry) return refuse('unknown');
    if (!arrival || arrival.direction !== entry.direction || arrival.host !== entry.host) return refuse('route');
    if (entry.expiresAt <= Date.now()) return refuse('expired');
    const device = devices.get(entry.deviceId);
    if (!device || !isActive(device)) return refuse('device');
    const existing = lookup(req);
    if (existing && existing !== device && existing.status === 'blocked') return refuse('blocked');
    // The browser sending another device's cookie is this device: that entry came from a password login on this
    // address, so it is folded into the one being switched instead of living on as a second login.
    if (existing && existing !== device) {
      drop(existing);
      log('device-merged', { ...about(device), mergedDeviceId: existing.id, mergedName: existing.name });
    }
    log('handoff-redeemed', { ...about(device), direction: entry.direction, host: entry.host });
    return bounceHome(addCookie(req, device, entry.host), entry.direction === 'to-remote' ? '?linked=1' : '');
  }

  function noteRestart(req) {
    const { ua } = requestInfo(req);
    writePrivate(GRACE_PATH, JSON.stringify({ at: Date.now(), ua, net: networkKey(clientIp(req)) }) + '\n');
  }

  // True once for a browser that matches the last update request and asks within the window; the note is spent either way it matches.
  function takeGrace(req) {
    let note;
    try { note = JSON.parse(fs.readFileSync(GRACE_PATH, 'utf8')); } catch { return false; }
    if (Date.now() - note.at >= GRACE_MS) return false;
    const { ua } = requestInfo(req);
    if (note.ua !== ua || note.net !== networkKey(clientIp(req))) return false;
    fs.rmSync(GRACE_PATH, { force: true });
    return true;
  }

  const recoveryCodeMatches = (given) => {
    const stored = config.read().recoveryCodeHash;
    return isPasswordHash(stored) && given.length >= 8 && verifyPassword(normalizeRecoveryCode(given), stored);
  };

  const passwordMatches = (given) => (envPassword ? sameSecret(given, envPassword) : verifyPassword(given, config.read().passwordHash));

  const isLocalRequest = (req) => LOOPBACK.has(req.socket.remoteAddress)
    && !PROXY_HEADERS.some((h) => h in req.headers)
    && typeof req.headers[LOCAL_SECRET_HEADER] === 'string' && sameSecret(req.headers[LOCAL_SECRET_HEADER], localSecret);

  function setMaxDevices(n, by) {
    const from = maxDevices();
    config.update({ maxDevices: n });
    if (from !== n) log('limit-changed', { from, to: n, by });
  }

  function setApproveFromDevices(on, by) {
    if (on === approveFromDevices()) return;
    config.update({ approveFromDevices: on });
    log('device-approval-changed', { on, by });
  }

  // Blocked devices stay blocked: logging them out would let them try the password again.
  function changePassword(next, { logoutAll, keep, by }) {
    if (logoutAll) onLockdown();
    config.update({ passwordHash: hashPassword(next) });
    const out = logoutAll ? [...devices.values()].filter((d) => d.status !== 'blocked' && d.id !== keep) : [];
    for (const d of out) revoke(d.id, 'password-change');
    log('password-changed', { by, loggedOut: out.length });
    return out.length;
  }

  function rename(d, value, by) {
    const name = parseDeviceName(value);
    if (!name) return reply(400, { error: 'The name must be 1 to 40 characters on one line.' });
    if (name !== d.name) log('device-renamed', { ...about(d), name, from: d.name, by });
    d.name = name;
    saveDevices();
    return reply(200, deviceView(d, Date.now()));
  }

  const routes = {
    async 'POST /api/login'({ req, body }) {
      const { ip, ua } = requestInfo(req);
      const lockedMs = limiter.lockedForMs(ip);
      if (lockedMs) return reply(429, { error: lockedMessage(ip, lockedMs) });
      const existing = lookup(req);
      if (existing?.status === 'blocked') return reply(403, REFUSALS.blocked);
      const { password, code } = await body();
      const refuse = async (error) => {
        log('login-failed', { ip, ua });
        const lockedNow = limiter.fail(ip);
        if (lockedNow) log('login-locked', { ip, minutes: minutes(LOGIN_WINDOW_MS) });
        await sleep(1000);
        return lockedNow ? reply(429, { error: lockedMessage(ip, LOGIN_WINDOW_MS) }) : reply(401, { error });
      };
      if (typeof password !== 'string' || !(await passwordMatches(password))) return refuse('Wrong password');
      // A recovery code proves the owner set this up on the Mac; a recent update request from this browser is the other way in.
      const withCode = typeof code === 'string' && code.trim() !== '';
      if (withCode && !(await recoveryCodeMatches(code))) return refuse('Wrong recovery code');
      limiter.succeed(ip);
      const by = withCode ? 'recovery-code' : !existing && takeGrace(req) ? 'update-grace' : null;
      if (by === 'recovery-code') config.update({ recoveryCodeHash: null });
      if (existing?.status === 'pending') {
        if (!by) return reply(200, { ok: true, pending: true });
        existing.status = 'active';
        if (rolesEnabled()) existing.role = 'admin';
        existing.via = 'password';
        saveDevices();
        log('device-approved', { ...about(existing), by });
        return reply(200, { ok: true });
      }
      const max = maxDevices();
      if (totalActiveCount() >= max) {
        if (!by || !activeCount()) return reply(403, { error: `Device limit reached (${max}). Log out a device in Settings on a logged-in device, or scan the QR code from the Mac.` });
        evictLeastRecent();
      }
      const status = by || !(requireApproval() || rolesEnabled()) ? 'active' : 'pending';
      const { cookie, device } = addDevice(req, 'password', status);
      log(status === 'pending' ? 'login-pending' : 'login', { via: 'password', ...about(device), ua });
      if (by) log('device-approved', { ...about(device), by });
      if (status === 'pending' && approveFromDevices()) notifyPending({ kind: deviceName(ua), code: device.id.slice(-4) });
      return reply(200, { ok: true, ...(status === 'pending' && { pending: true }) }, { 'set-cookie': cookie });
    },
    'GET /api/status'({ req }) {
      const d = lookup(req);
      return reply(200, d ? { status: d.status, name: d.name, code: d.id.slice(-4) } : { status: 'none' });
    },
    'POST /api/qr-key'({ req }) {
      if (!isLocalRequest(req)) return reply(403, { error: 'Only the Mac itself can create login keys.' });
      return reply(200, { url: mintQrUrl(), expiresInMin: QR_TTL_MIN });
    },
    'POST /api/logout'({ device }) {
      revoke(device.id, 'self');
      return reply(204, undefined, { 'set-cookie': CLEAR_COOKIE });
    },
    'GET /api/settings'({ device }) {
      return reply(200, {
        maxDevices: maxDevices(), currentDeviceId: device.id, devices: listDevices(isActive), urls: { ...urls(), localNote },
        roleAccessEnabled: rolesEnabled(), role: device.role || 'owner', collaboratorSessions: extraActiveCount(),
        approveFromDevices: approveFromDevices(), waiting: mayApprove(device) ? listDevices((d) => d.status === 'pending') : [],
      });
    },
    // The same path as approval on the Mac, so the limit, roles and the log behave the same; `by` names the phone.
    'POST /api/devices/:id/:action'({ device, id, action }) {
      if (!approveFromDevices()) return reply(403, { error: 'Approving from a phone is off. Turn it on in Admin on the Mac.' });
      if (!mayApprove(device)) return reply(403, { error: 'Only an Admin device may approve logins.' });
      return admin.deviceAction(id, action, `device ${device.name} (${device.id.slice(-4)})`);
    },
    async 'PUT /api/settings/approve-from-devices'({ body }) {
      const { on } = await body();
      if (on !== false) return reply(403, { error: 'Only the Mac can turn this on. Use Admin on the Mac or pocket-dev config set approveFromDevices true.' });
      setApproveFromDevices(false, 'phone');
      return reply(200, { approveFromDevices: false });
    },
    async 'PUT /api/settings/max-devices'({ body }) {
      const { maxDevices: n } = await body();
      if (!isMaxDevices(n)) return reply(400, { error: 'The device limit must be a whole number from 1 to 20.' });
      setMaxDevices(n, 'phone');
      return reply(200, { maxDevices: n });
    },
    async 'PATCH /api/devices/:id'({ id, body }) {
      const d = findActive(id);
      if (!d) return reply(404, { error: 'No such device' });
      return rename(d, (await body()).name, 'phone');
    },
    'DELETE /api/devices/:id'({ id, device }) {
      if (!findActive(id) || !revoke(id, 'phone')) return reply(404, { error: 'No such device' });
      return reply(204, undefined, id === device.id ? { 'set-cookie': CLEAR_COOKIE } : {});
    },
    async 'POST /api/settings/password'({ device, body }) {
      if (envPassword) return reply(409, { error: 'The password comes from POCKET_DEV_PASSWORD on the Mac. Change it there.' });
      const { current, next, logoutOthers = false } = await body();
      if (typeof current !== 'string' || typeof next !== 'string' || typeof logoutOthers !== 'boolean') {
        return reply(400, { error: 'Send current and next as text and logoutOthers as true or false.' });
      }
      const invalid = newPasswordError(next);
      if (invalid) return reply(400, { error: invalid });
      if (!(await passwordMatches(current))) {
        await sleep(1000);
        return reply(403, { error: 'The current password is wrong.' });
      }
      const loggedOut = changePassword(next, { logoutAll: logoutOthers, keep: device.id, by: 'phone' });
      return reply(200, { ok: true, loggedOut });
    },
    async 'POST /api/settings/qr-key'() {
      if (rolesEnabled()) return reply(403, { error: 'Pair another Admin device from Admin on the Mac. Use Collaborators for restricted invitations.' });
      const url = mintQrUrl();
      return reply(200, { url, svg: await svgQr(url), expiresInMin: QR_TTL_MIN });
    },
  };
  const PUBLIC_ROUTES = new Set(['POST /api/login', 'GET /api/status', 'POST /api/qr-key']);

  // Returns null for paths it does not own, so the server can route them. Pending and blocked devices get a 403 on
  // every route, owned or not, so the page can show why.
  async function handleApi(req, pathname, readBody) {
    const deviceRoute = /^\/api\/devices\/([^/]+)(?:\/(approve|deny))?$/.exec(pathname);
    const route = `${req.method} ${deviceRoute ? `/api/devices/:id${deviceRoute[2] ? '/:action' : ''}` : pathname}`;
    const handler = routes[route];
    const body = async () => asObject(await readBody());
    if (PUBLIC_ROUTES.has(route)) return handler({ req, body });
    const device = lookup(req);
    if (device && !isActive(device) && !(route === 'POST /api/logout' && device.status === 'pending')) return reply(403, REFUSALS[device.status] || { error: 'Review this device in Admin on the Mac before giving it Admin access.', pending: true });
    if (!handler) return null;
    if (!device) return reply(401, { error: 'Not logged in' });
    return handler({ req, body, device, id: deviceRoute?.[1], action: deviceRoute?.[2] });
  }

  // Each action names the statuses it applies to; approve and unblock make a device active, so they respect the limit.
  const DEVICE_ACTIONS = {
    revoke: { from: ['active'], event: 'device-revoked', apply: drop },
    // Forgetting a blocked device lets that browser try the password again, as a new device.
    remove: { from: ['blocked'], event: 'device-removed', apply: drop },
    block: {
      from: ['active', 'pending'],
      event: 'device-blocked',
      apply: (d) => { d.status = 'blocked'; closeSockets(d.id); saveDevices(); },
    },
    unblock: { from: ['blocked'], event: 'device-unblocked', activates: true },
    approve: { from: ['pending'], event: 'device-approved', activates: true },
    deny: { from: ['pending'], event: 'device-denied', apply: drop },
  };

  // The Mac-only admin page calls these. Each returns a reply like the routes above.
  const admin = {
    log,
    recentLog: securityLog.recent,
    state() {
      return {
        devices: listDevices(),
        maxDevices: maxDevices(),
        requireApproval: requireApproval(),
        passwordFromEnv: Boolean(envPassword),
        pendingTtlMin: minutes(PENDING_TTL_MS),
        qrTtlMin: QR_TTL_MIN,
        roleAccessEnabled: rolesEnabled(),
        collaboratorSessions: extraActiveCount(),
        approveFromDevices: approveFromDevices(),
        recoveryCode: isPasswordHash(config.read().recoveryCodeHash),
      };
    },
    // Shown once; only a salted hash is kept. A new code replaces the old one, and using it spends it.
    createRecoveryCode() {
      const code = newRecoveryCode();
      config.update({ recoveryCodeHash: hashPassword(normalizeRecoveryCode(code)) });
      log('recovery-code-created', {});
      return reply(200, { code });
    },
    enableRoles(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || findDevice(id)?.status !== 'active')) return reply(400, { error: 'Select at least one active, trusted owner device to retain as Admin.' });
      for (const d of devices.values()) {
        if (d.status !== 'active') continue;
        if (ids.includes(d.id)) d.role = 'admin';
        else { d.status = 'pending'; d.createdAt = Date.now(); delete d.role; closeSockets(d.id); }
      }
      saveDevices();
      config.update({ roleAccessEnabled: true });
      qrKeys.clear();
      log('role-access-enabled', { adminDeviceIds: ids });
      return reply(200, { ok: true });
    },
    deviceAction(id, action, by = 'admin') {
      const spec = Object.hasOwn(DEVICE_ACTIONS, action) ? DEVICE_ACTIONS[action] : null;
      if (!spec) return reply(404, { error: `Unknown action: ${action}` });
      const d = findDevice(id);
      if (!d) return reply(404, { error: 'No such device' });
      if (!spec.from.includes(d.status)) return reply(409, { error: `Cannot ${action} a device that is ${d.status}.` });
      if (spec.activates) {
        const max = maxDevices();
        if (totalActiveCount() >= max) return reply(409, { error: `The device limit (${max}) is reached. Log out a device or raise the limit first.` });
        d.status = 'active';
        if (rolesEnabled()) d.role = 'admin';
        saveDevices();
      } else {
        spec.apply(d);
      }
      log(spec.event, { ...about(d), by });
      return reply(200, deviceView(d, Date.now()));
    },
    rename(id, name) {
      const d = findDevice(id);
      return d ? rename(d, name, 'admin') : reply(404, { error: 'No such device' });
    },
    setPassword({ next, logoutAll }) {
      if (envPassword) return reply(409, { error: 'The password comes from POCKET_DEV_PASSWORD. Change or remove it where Pocket Dev starts.' });
      if (typeof logoutAll !== 'boolean') return reply(400, { error: 'Send logoutAll as true or false.' });
      const invalid = newPasswordError(next);
      if (invalid) return reply(400, { error: invalid });
      return reply(200, { loggedOut: changePassword(next, { logoutAll, by: 'admin' }) });
    },
    updateSettings({ maxDevices: n, requireApproval: on, approveFromDevices: fromDevices }) {
      if (n === undefined && on === undefined && fromDevices === undefined) return reply(400, { error: 'Send maxDevices, requireApproval or approveFromDevices.' });
      if (n !== undefined && !isMaxDevices(n)) return reply(400, { error: 'The device limit must be a whole number from 1 to 20.' });
      if (on !== undefined && typeof on !== 'boolean') return reply(400, { error: 'requireApproval must be true or false.' });
      if (fromDevices !== undefined && typeof fromDevices !== 'boolean') return reply(400, { error: 'approveFromDevices must be true or false.' });
      if (n !== undefined) setMaxDevices(n, 'admin');
      if (on !== undefined && on !== requireApproval()) {
        config.update({ requireApproval: on });
        log('approval-changed', { on, by: 'admin' });
      }
      if (fromDevices !== undefined) setApproveFromDevices(fromDevices, 'admin');
      return reply(200, { maxDevices: maxDevices(), requireApproval: requireApproval(), approveFromDevices: approveFromDevices() });
    },
    async mintQr() {
      const url = mintQrUrl();
      const expiresAt = qrKeys.get(new URL(url).searchParams.get('k'));
      return { url, svg: await svgQr(url), expiresInMin: QR_TTL_MIN, expiresAt };
    },
    newPasswordError,
    // Logs out every device that is not blocked, cancels every login code, and sets `next` as the password when given.
    // Returns how many devices it logged out.
    lockdown(next) {
      onLockdown();
      const out = [...devices.values()].filter((d) => d.status !== 'blocked');
      for (const d of out) revoke(d.id, 'lockdown');
      qrKeys.clear();
      handoffs.clear();
      if (next !== undefined) changePassword(next, { logoutAll: false, by: 'lockdown' });
      return out.length;
    },
  };

  return { passwordLine, noteRestart, lookup, deviceFor, trackSocket, mintQrUrl, redeemQrKey, mintHandoff, redeemHandoff, hasCookieFor, isLocalRequest, handleApi, admin, activeCount,
    isTrustedAdmin: (req) => deviceFor(req)?.role === 'admin' };
}
