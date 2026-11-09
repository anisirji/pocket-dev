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
export function createRoom({ stateDir = STATE_DIR, config, urls = () => ({}), fetchImpl = fetch, now = Date.now, intervalMs = 30_000,
  every = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return () => clearInterval(timer); } }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'room.json');
  let data = { deviceId: crypto.randomBytes(8).toString('hex'), room: null };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceId !== 'string') throw new Error('Invalid room state');
    data = { deviceId: saved.deviceId, room: saved.room ?? null };
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
  const publicMember = ({ deviceId, name, addresses, role, joinedAt, level, folders, lastSeen }) => ({ deviceId, name, addresses, role, joinedAt, level, folders, ...(lastSeen && { lastSeen }) });
  const statusOf = (m) => m.deviceId === data.deviceId || (!unreachable.has(m.deviceId) && m.lastSeen && now() - m.lastSeen <= offlineAfter()) ? 'online' : 'offline';
  const publicMembers = () => data.room.members.map((m) => {
    const entry = publicMember(m);
    return { ...entry, ...(m.deviceId === data.deviceId && { lastSeen: now() }), status: statusOf(m) };
  });
  const view = () => data.room
    ? { deviceId: data.deviceId, room: { id: data.room.id, hostId: data.room.hostId, role: me().role, members: publicMembers(), revoked: data.room.revoked } }
    : { deviceId: data.deviceId, room: null };

  function access(body) {
    const level = body.level === 'admin' || body.level === 'collaborator' ? body.level : fail(400, 'Choose admin or collaborator.');
    const folders = level === 'admin' ? [] : Array.isArray(body.folders) && body.folders.length && body.folders.every((f) => typeof f === 'string' && path.isAbsolute(f)) ? body.folders : fail(400, 'A collaborator needs at least one folder (absolute paths).');
    return { level, folders };
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
  const hostName = () => data.room.members.find((m) => m.deviceId === data.room.hostId);
  const announce = (skip) => Promise.all(data.room.members.filter((m) => m.deviceId !== data.deviceId && m.deviceId !== skip)
    .map((m) => tell(m, 'members', { hostId: data.room.hostId, members: publicMembers(), revoked: data.room.revoked })));

  function drop() { data.room = null; persist(); }

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
    data.room.revoked = data.room.revoked.filter((r) => r.deviceId !== deviceId);
    data.room.members.push({ deviceId, ...info, role: 'member', joinedAt: now(), hostSecret, secretHash: hash(memberSecret) });
    persist();
    announce(deviceId);
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
    await send(host, 'notify', note);
    return view();
  }

  async function kick(body) {
    needHost();
    const target = data.room.members.find((m) => m.deviceId === body.deviceId);
    if (!target) fail(404, 'No such device in the room.');
    if (target.deviceId === data.deviceId) fail(400, 'The host cannot kick itself. Hand over or leave.');
    const told = await tell(target, 'kicked');
    removeMember(target, 'kicked');
    await announce();
    return { ...view(), notified: told.status === 200 };
  }
  function removeMember(target, reason) {
    data.room.members = data.room.members.filter((m) => m !== target);
    data.room.revoked.push({ deviceId: target.deviceId, name: target.name, reason, at: now() });
    persist();
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
    if (ticking || !data.room) return;
    ticking = true;
    try {
      const peers = isHost() ? data.room.members.filter((m) => m.deviceId !== data.deviceId) : [hostName()];
      await Promise.all(peers.map((m) => pingPeer(m).catch(() => {})));
    } finally { ticking = false; }
  }
  const stopTimer = every(() => { tick().catch(() => {}); }, intervalMs);

  function notify(body) {
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

  return { handleApi, view, tick, close: stopTimer, deviceId: () => data.deviceId };
}
