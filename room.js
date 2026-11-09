import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.js';

const INVITE_MS = 10 * 60_000;
const PEER_TIMEOUT_MS = 5000;
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 80) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;

// A room is a permanent group of devices with one host. Every device stores room.json in its own state folder.
// Control flows host to member only: the host keeps one secret per member (hostSecret) and presents it when it tells
// a member something. A member keeps only the secret the host minted for it at join (memberSecret), which lets it
// report liveness or leave. Leaving or being kicked deletes the room from room.json, secrets included.
export function createRoom({ stateDir = STATE_DIR, config, urls = () => ({}), grants, fetchImpl = fetch, now = Date.now, intervalMs = 30_000,
  every = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return () => clearInterval(timer); } }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'room.json');
  let data = { deviceId: crypto.randomBytes(8).toString('hex'), room: null, outbox: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceId !== 'string') throw new Error('Invalid room state');
    data = { deviceId: saved.deviceId, room: saved.room ?? null, outbox: Array.isArray(saved.outbox) ? saved.outbox : [] };
  } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot load room state safely: ${err.message}`); }
  const invitations = new Map();
  // Peers this device could not reach on its last try. Local only; the lastSeen age covers a device that stays silent.
  const unreachable = new Set();
  // A peer that has not answered for two intervals (plus a little slack for a slow answer) counts as offline.
  const offlineAfter = () => 2 * intervalMs + Math.min(intervalMs, PEER_TIMEOUT_MS);

  function persist() {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  persist();

  const me = () => data.room?.members.find((m) => m.deviceId === data.deviceId);
  const isHost = () => data.room?.hostId === data.deviceId;
  const need = () => data.room || fail(409, 'This device is not in a room.');
  const needHost = () => { need(); if (!isHost()) fail(403, 'Only the host can do this.'); };
  const myAddresses = () => [urls().remote, urls().lan, urls().local].filter(Boolean);
  const publicMember = ({ deviceId, name, addresses, role, joinedAt, level, folders, grantRole, lastSeen }) => ({ deviceId, name, addresses, role, joinedAt, level, folders, ...(grantRole && { grantRole }), ...(lastSeen && { lastSeen }) });
  const statusOf = (m) => m.deviceId === data.deviceId || (!unreachable.has(m.deviceId) && m.lastSeen && now() - m.lastSeen <= offlineAfter()) ? 'online' : 'offline';
  const publicMembers = () => data.room.members.map((m) => {
    const entry = publicMember(m);
    return { ...entry, ...(m.deviceId === data.deviceId && { lastSeen: now() }), status: statusOf(m) };
  });
  // What this device's owner gave the other members: full admin, or a grant on chosen folders. Both exist only while the
  // member is in the room.
  const trustedAdmins = () => data.room && me()?.level === 'admin' ? data.room.members.filter((m) => m.deviceId !== data.deviceId).map((m) => m.deviceId) : [];
  const view = () => data.room
    ? { deviceId: data.deviceId, room: { id: data.room.id, hostId: data.room.hostId, role: me().role, members: publicMembers(), revoked: data.room.revoked,
      trustedAdmins: trustedAdmins(), ...(accessErrors.size && { accessErrors: Object.fromEntries(accessErrors) }) } }
    : { deviceId: data.deviceId, room: null };
  const accessErrors = new Map();

  // Makes this device's grants match the room. Ending access is immediate; creating a grant can take a moment (a developer
  // gets a copy of the project), so creations run one at a time and look again at the room before each one.
  let grantQueue = Promise.resolve();
  function reconcile() {
    if (!grants) return grantQueue;
    const roomId = data.room?.id ?? null;
    const others = data.room ? data.room.members.filter((m) => m.deviceId !== data.deviceId) : [];
    grants.revokeRoom(roomId, new Set(others.map((m) => m.deviceId)));
    for (const id of accessErrors.keys()) if (!others.some((m) => m.deviceId === id)) accessErrors.delete(id);
    const self = me();
    if (self?.level !== 'collaborator') return grantQueue;
    grantQueue = grantQueue.then(async () => {
      for (const member of others) {
        if (data.room?.id !== roomId || !data.room.members.some((m) => m.deviceId === member.deviceId)) continue;
        try {
          await grants.roomGrant({ roomId, deviceId: member.deviceId, label: member.name, role: self.grantRole, folders: self.folders });
          accessErrors.delete(member.deviceId);
        } catch (err) { accessErrors.set(member.deviceId, err.message); }
      }
    });
    return grantQueue;
  }

  function access(body) {
    const level = body.level === 'admin' || body.level === 'collaborator' ? body.level : fail(400, 'Choose admin or collaborator.');
    const folders = level === 'admin' ? [] : Array.isArray(body.folders) && body.folders.length && body.folders.every((f) => typeof f === 'string' && path.isAbsolute(f)) ? body.folders : fail(400, 'A collaborator needs at least one folder (absolute paths).');
    if (folders.length > 6) fail(400, 'Choose one repository and up to five related folders.');
    if (level === 'admin') return { level, folders };
    const grantRole = body.grantRole === undefined ? 'viewer' : ['viewer', 'developer'].includes(body.grantRole) ? body.grantRole : fail(400, 'Choose viewer or developer.');
    return { level, folders, grantRole };
  }
  function addresses(list) {
    return Array.isArray(list) && list.length && list.every((a) => { try { return /^https?:$/.test(new URL(a).protocol); } catch { return false; } }) ? list.map((a) => new URL(a).origin) : fail(400, 'Give this device at least one http or https address.');
  }

  async function send(member, route, body) {
    let last;
    for (const address of member.addresses) {
      try {
        const res = await fetchImpl(`${address}/api/room/${route}`, { method: 'POST', signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
          headers: { 'content-type': 'application/json', 'x-pocket-dev': '1' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      } catch (err) { last = err; }
    }
    return { status: 0, body: { error: last?.message || 'unreachable' } };
  }
  // The host tells one member something. The room id and the member's own secret travel with it.
  const tell = (member, type, extra = {}) => send(member, 'notify', { roomId: data.room.id, from: data.deviceId, secret: member.hostSecret, type, ...extra });

  // Anything that gets an answer is done, even a refusal: the device decided. No answer, or a server error, means try again later.
  const arrived = (r) => r.status > 0 && r.status < 500;
  // A message nobody could receive waits in the outbox (saved in room.json, so a restart keeps it) and goes out on the timer.
  // A newer 'members' list replaces an older one for the same device.
  function queue(to, body) {
    data.outbox = data.outbox.filter((i) => !(i.deviceId === to.deviceId && i.body.type === 'members' && body.type === 'members'));
    data.outbox.push({ deviceId: to.deviceId, addresses: to.addresses, body });
    persist();
  }
  async function tellOrQueue(member, type, extra) {
    const r = await tell(member, type, extra);
    if (!arrived(r)) queue(member, { roomId: data.room.id, from: data.deviceId, secret: member.hostSecret, type, ...extra });
    return r;
  }
  // A list or handover for a device that is no longer in the room is moot. A kick or a leave still has to arrive.
  const moot = (item) => ['members', 'handover'].includes(item.body.type) && !data.room?.members.some((m) => m.deviceId === item.deviceId);
  async function flush() {
    if (!data.outbox.length) return;
    const items = data.outbox.filter((i) => !moot(i));
    for (const item of items) {
      if (item.body.type === 'members' && data.room && isHost()) Object.assign(item.body, { hostId: data.room.hostId, members: publicMembers(), revoked: data.room.revoked });
    }
    const results = await Promise.all(items.map((item) => send(item, 'notify', item.body)));
    const pending = items.filter((_, i) => !arrived(results[i]));
    // Items queued while we were sending stay.
    data.outbox = data.outbox.filter((i) => pending.includes(i) || (!items.includes(i) && !moot(i)));
    persist();
  }
  const hostName = () => data.room.members.find((m) => m.deviceId === data.room.hostId);
  const announce = (skip) => Promise.all(data.room.members.filter((m) => m.deviceId !== data.deviceId && m.deviceId !== skip)
    .map((m) => tellOrQueue(m, 'members', { hostId: data.room.hostId, members: publicMembers(), revoked: data.room.revoked })));

  function drop() { data.room = null; persist(); reconcile(); }

  async function create(body) {
    if (data.room) fail(409, 'This device is already in a room. Leave it first.');
    const name = text(body.name) || os.hostname();
    const list = body.addresses === undefined ? myAddresses() : body.addresses;
    data.room = { id: crypto.randomBytes(8).toString('hex'), hostId: data.deviceId, revoked: [], members: [
      { deviceId: data.deviceId, name, addresses: addresses(list), role: 'host', joinedAt: now(), ...access({ level: 'admin' }) }] };
    persist();
    return view();
  }

  function invite() {
    needHost();
    for (const [key, expiresAt] of invitations) if (expiresAt <= now()) invitations.delete(key);
    const code = crypto.randomBytes(24).toString('base64url');
    invitations.set(hash(code), now() + INVITE_MS);
    return { code, expiresInSeconds: INVITE_MS / 1000, roomId: data.room.id, addresses: me().addresses };
  }

  // On the joining device: its owner picks the level and folders other room members get on this device.
  async function join(body) {
    if (data.room) fail(409, 'This device is already in a room. Leave it first.');
    const code = text(body.code, 200) || fail(400, 'Give the join code.');
    const hostAddresses = addresses(Array.isArray(body.host) ? body.host : [body.host]);
    const self = { deviceId: data.deviceId, name: text(body.name) || os.hostname(), addresses: addresses(body.addresses ?? myAddresses()), ...access(body) };
    const hostSecret = secret();
    const r = await send({ addresses: hostAddresses }, 'accept', { code, hostSecret, ...self });
    if (r.status !== 200) fail(r.status === 0 ? 502 : r.status, r.body.error || 'The host did not accept the code.');
    const { roomId, hostId, memberSecret, members, revoked } = r.body;
    data.room = { id: roomId, hostId, revoked, memberSecret, hostSecretHash: hash(hostSecret), members };
    persist();
    await reconcile();
    return view();
  }

  // On the host: a device presents a join code. Public route, the code is the credential.
  async function accept(body) {
    needHost();
    const key = hash(String(body.code ?? ''));
    const expiresAt = invitations.get(key);
    if (!expiresAt || expiresAt <= now()) fail(403, 'That join code is not valid. Ask the host for a new one.');
    const info = { name: text(body.name) || fail(400, 'Give a name.'), addresses: addresses(body.addresses), ...access(body) };
    const deviceId = text(body.deviceId, 64) || fail(400, 'Give a device id.');
    const hostSecret = typeof body.hostSecret === 'string' && body.hostSecret.length >= 32 ? body.hostSecret : fail(400, 'Give a secret.');
    if (data.room.members.some((m) => m.deviceId === deviceId)) fail(409, 'This device is already in the room.');
    invitations.delete(key);
    const memberSecret = secret();
    data.outbox = data.outbox.filter((i) => !(i.deviceId === deviceId && i.body.type === 'kicked'));
    data.room.revoked = data.room.revoked.filter((r) => r.deviceId !== deviceId);
    data.room.members.push({ deviceId, ...info, role: 'member', joinedAt: now(), hostSecret, secretHash: hash(memberSecret) });
    persist();
    announce(deviceId);
    reconcile();
    return { roomId: data.room.id, hostId: data.room.hostId, memberSecret, members: publicMembers(), revoked: data.room.revoked };
  }

  async function leave() {
    need();
    if (isHost()) {
      if (data.room.members.length > 1) fail(409, 'Hand the room over to another device before leaving.');
      return drop(), view();
    }
    const host = hostName();
    const note = { roomId: data.room.id, from: data.deviceId, secret: data.room.memberSecret, type: 'leave' };
    drop();
    const r = await send(host, 'notify', note);
    if (!arrived(r)) queue(host, note);
    return view();
  }

  async function kick(body) {
    needHost();
    const target = data.room.members.find((m) => m.deviceId === body.deviceId);
    if (!target) fail(404, 'No such device in the room.');
    if (target.deviceId === data.deviceId) fail(400, 'The host cannot kick itself. Hand over or leave.');
    const told = await tellOrQueue(target, 'kicked');
    removeMember(target, 'kicked');
    await announce();
    return { ...view(), notified: told.status === 200 };
  }
  function removeMember(target, reason) {
    data.room.members = data.room.members.filter((m) => m !== target);
    data.room.revoked.push({ deviceId: target.deviceId, name: target.name, reason, at: now() });
    persist();
    reconcile();
  }

  async function handover(body) {
    needHost();
    const target = data.room.members.find((m) => m.deviceId === body.deviceId);
    if (!target) fail(404, 'No such device in the room.');
    if (target.deviceId === data.deviceId) fail(400, 'This device is already the host.');
    const oldHostSecret = secret();
    const r = await tell(target, 'handover', { oldHostSecret, room: { members: data.room.members, revoked: data.room.revoked } });
    if (r.status !== 200) fail(r.status === 0 ? 502 : r.status, r.body.error || 'The new host did not take over.');
    data.room.hostId = target.deviceId;
    data.room.memberSecret = oldHostSecret;
    data.room.hostSecretHash = hash(r.body.hostSecret);
    await announce(target.deviceId);
    for (const m of data.room.members) { delete m.hostSecret; delete m.secretHash; }
    me().role = 'member'; target.role = 'host';
    persist();
    return view();
  }

  const asMember = (body) => {
    const member = data.room?.members.find((m) => m.deviceId === body.from);
    return data.room && body.roomId === data.room.id && member && same(hash(body.secret), member.secretHash) ? member : null;
  };
  const fromHost = (body) => data.room && !isHost() && body.roomId === data.room.id && body.from === data.room.hostId && same(hash(body.secret), data.room.hostSecretHash);

  // Peer liveness. A member proves itself to the host; the host proves itself to a member.
  function ping(body) {
    if (data.room && isHost()) {
      const member = asMember(body);
      if (!member) {
        if (data.room.revoked.some((r) => r.deviceId === body.from)) fail(403, 'This device was removed from the room.');
        fail(403, 'Not a member of this room.');
      }
      member.lastSeen = now();
      persist();
      return { ok: true, deviceId: data.deviceId, roomId: data.room.id, hostId: data.room.hostId, members: publicMembers(), revoked: data.room.revoked };
    } else if (!fromHost(body)) fail(403, 'Not the host of this room.');
    return { ok: true, deviceId: data.deviceId, roomId: data.room.id, hostId: data.room.hostId };
  }

  // One ping to one peer. A success refreshes lastSeen; a member also takes the host's current list from the answer, which is
  // how a member that missed an announcement catches up. A host that says this device was removed ends its access here too.
  async function pingPeer(peer) {
    const host = isHost();
    const r = await send(peer, 'ping', { roomId: data.room.id, from: data.deviceId, secret: host ? peer.hostSecret : data.room.memberSecret });
    if (!host && r.status === 403 && /removed/.test(r.body.error || '')) { drop(); return r; }
    if (r.status === 200) {
      unreachable.delete(peer.deviceId);
      if (!host && Array.isArray(r.body.members) && r.body.members.some((m) => m.deviceId === data.deviceId)) {
        data.room.members = r.body.members.map(publicMember);
        data.room.revoked = Array.isArray(r.body.revoked) ? r.body.revoked : data.room.revoked;
        data.room.hostId = r.body.hostId;
        await reconcile();
      }
      const entry = data.room.members.find((m) => m.deviceId === peer.deviceId);
      if (entry) entry.lastSeen = now();
      persist();
    } else if (r.status === 0) unreachable.add(peer.deviceId);
    return r;
  }

  // The timer. The host pings every member; a member pings the host.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await flush();
      if (!data.room) return;
      const peers = isHost() ? data.room.members.filter((m) => m.deviceId !== data.deviceId) : [hostName()];
      await Promise.all(peers.map((m) => pingPeer(m).catch(() => {})));
    } finally { ticking = false; }
  }
  const stopTimer = every(() => { tick().catch(() => {}); }, intervalMs);

  async function notify(body) {
    if (data.room && isHost()) {
      const member = asMember(body);
      if (!member || body.type !== 'leave') fail(403, 'Not allowed.');
      removeMember(member, 'left');
      announce();
      return { ok: true };
    }
    if (!fromHost(body)) fail(403, 'Only the host can tell a member something.');
    if (body.type === 'kicked') { drop(); return { ok: true }; }
    if (body.type === 'members') {
      if (!Array.isArray(body.members) || !body.members.some((m) => m.deviceId === data.deviceId)) fail(400, 'Bad member list.');
      data.room.members = body.members.map(publicMember);
      data.room.revoked = Array.isArray(body.revoked) ? body.revoked : [];
      data.room.hostId = body.hostId;
      persist();
      await reconcile();
      return { ok: true };
    }
    if (body.type === 'handover') {
      const list = body.room?.members;
      if (!Array.isArray(list) || !list.some((m) => m.deviceId === data.deviceId) || typeof body.oldHostSecret !== 'string') fail(400, 'Bad handover.');
      const hostSecret = secret();
      const oldHost = list.find((m) => m.deviceId === data.room.hostId);
      oldHost.secretHash = hash(body.oldHostSecret);
      oldHost.hostSecret = hostSecret;
      oldHost.role = 'member';
      const mine = list.find((m) => m.deviceId === data.deviceId);
      mine.role = 'host'; delete mine.hostSecret; delete mine.secretHash;
      data.room = { id: data.room.id, hostId: data.deviceId, revoked: body.room.revoked || [], members: list };
      persist();
      await reconcile();
      return { ok: true, hostSecret };
    }
    fail(400, 'Unknown message.');
  }

  // Asks every other device whether it answers. A host that says this device was removed ends its access here too.
  async function live() {
    if (!data.room) return view();
    const peers = isHost() ? data.room.members.filter((m) => m.deviceId !== data.deviceId) : [hostName()];
    const results = await Promise.all(peers.map((m) => pingPeer(m)));
    if (!data.room) return view();
    const out = view();
    peers.forEach((m, i) => { out.room.members.find((x) => x.deviceId === m.deviceId).online = results[i].status === 200; });
    return out;
  }

  async function handleApi(req, res, url, { readJson, sendJson, loggedIn }) {
    const name = url.pathname.split('/')[3];
    const peer = req.method === 'POST' && (name === 'ping' || name === 'accept' || name === 'notify');
    if (!peer && !loggedIn) return sendJson(res, 401, { error: 'Not logged in' });
    try {
      const body = req.method === 'POST' && req.headers['content-type'] ? await readJson(req) : {};
      const routes = {
        'GET ': () => url.searchParams.get('live') ? live() : view(),
        'POST create': () => create(body), 'POST invite': invite, 'POST join': () => join(body), 'POST leave': leave,
        'POST kick': () => kick(body), 'POST handover': () => handover(body),
        'POST ping': () => ping(body), 'POST accept': () => accept(body), 'POST notify': () => notify(body),
      };
      const route = routes[`${req.method} ${name ?? ''}`];
      if (!route) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, await route());
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  }

  reconcile();

  return { handleApi, view, tick, isTrustedAdmin: (deviceId) => trustedAdmins().includes(deviceId), grantsReady: () => grantQueue, close: stopTimer, deviceId: () => data.deviceId };
}
