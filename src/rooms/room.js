import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from '../core/paths.js';
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode, formatCode, isLoopbackHost, inviteLine } from '../../public/room-invite.js';

const INVITE_MS = 10 * 60_000;
const PEER_TIMEOUT_MS = 5000;
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, ...(code && { code }) }); };
const text = (v, max = 80) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
const newCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
// Loopback addresses name the device they are used on, so another device can never reach them. Tests run every server on
// 127.0.0.1 and opt in with POCKET_DEV_ROOM_ALLOW_LOOPBACK=1.
const loopbackAllowed = () => process.env.POCKET_DEV_ROOM_ALLOW_LOOPBACK === '1';
const loopbackIn = (address) => { try { return isLoopbackHost(new URL(address).hostname); } catch { return false; } };

// The addresses other devices can use to reach this one, best first: the address this request came in on (when it is not
// loopback), then the Wi-Fi address, the internet address, the .local name. Loopback never appears unless allowed.
export function reachableAddresses({ req, urls = {}, allowLoopback = loopbackAllowed() } = {}) {
  const host = req?.headers?.host;
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
  let asked = null;
  try { asked = host ? new URL(`${proto}://${host}`).origin : null; } catch { /* a bad Host header names nothing */ }
  const list = [asked, urls.lan, urls.remote, urls.local].filter(Boolean).map((a) => { try { return new URL(a).origin; } catch { return null; } }).filter(Boolean);
  return [...new Set(list)].filter((a) => allowLoopback || !loopbackIn(a));
}

// A room is a permanent group of devices with one host. Every device stores room.json in its own state folder.
// Control flows host to member only: the host keeps one secret per member (hostSecret) and presents it when it tells
// a member something. A member keeps only the secret the host minted for it at join (memberSecret), which lets it
// report liveness or leave. Leaving or being kicked deletes the room from room.json, secrets included.
export function createRoom({ stateDir = STATE_DIR, config, urls = () => ({}), fetchImpl = fetch, now = Date.now, intervalMs = 30_000, allowLoopback = loopbackAllowed,
  every = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return () => clearInterval(timer); } }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'room.json');
  let data = { deviceId: crypto.randomBytes(8).toString('hex'), room: null, outbox: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceId !== 'string') throw new Error('Invalid room state');
    data = { deviceId: saved.deviceId, room: saved.room ?? null, identity: saved.identity, outbox: Array.isArray(saved.outbox) ? saved.outbox : [] };
  } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot load room state safely: ${err.message}`); }
  const legacyMembers = data.room ? JSON.parse(JSON.stringify(data.room.members)) : [];
  if (!data.identity) {
    const keys = crypto.generateKeyPairSync('ed25519');
    data.identity = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  }
  if (data.room) {
    const self = data.room.members.find((m) => m.deviceId === data.deviceId);
    if (self) self.publicKey = data.identity.publicKey;
  }
  let accessResolver = null, keyResolver = null;
  const nonces = new Map();
  const invitations = new Map();
  let joining = false;
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
  const myAddresses = (req) => reachableAddresses({ req, urls: urls(), allowLoopback: allowLoopback() });
  const publicMember = ({ deviceId, name, addresses, role, joinedAt, level, folders, grantRole, lastSeen, publicKey, access }) => ({ deviceId, name, addresses, role, joinedAt, level, folders, publicKey, access, ...(grantRole && { grantRole }), ...(lastSeen && { lastSeen }) });
  // A member only reaches the other members through the host, so while the host is out of reach they all count as offline.
  const statusOf = (m) => {
    if (m.deviceId === data.deviceId) return 'online';
    if (!isHost() && m.deviceId !== data.room.hostId && statusOf(hostName()) !== 'online') return 'offline';
    return !unreachable.has(m.deviceId) && m.lastSeen && now() - m.lastSeen <= offlineAfter() ? 'online' : 'offline';
  };
  const publicMembers = () => data.room.members.map((m) => {
    const entry = publicMember(m);
    return { ...entry, ...(m.deviceId === data.deviceId && { lastSeen: now() }), status: statusOf(m) };
  });
  // Target-owned grants are authoritative; membership never grants computer access.
  const trustedAdmins = () => (data.room?.members || []).filter((m) => m.deviceId !== data.deviceId && accessResolver?.(m.deviceId).computerAccess).map((m) => m.deviceId);
  const view = () => data.room
    ? { deviceId: data.deviceId, room: { id: data.room.id, hostId: data.room.hostId, role: me().role, members: publicMembers(), revoked: data.room.revoked,
      trustedAdmins: trustedAdmins() } }
    : { deviceId: data.deviceId, room: null };

  const access = () => ({ level: 'external', folders: [] });
  const NO_ADDRESS = 'This device has no address that other devices can reach. Connect it to Wi-Fi (or turn on internet access) and try again.';
  function addresses(list, { host = false } = {}) {
    if (Array.isArray(list) && !list.length && !host) fail(400, NO_ADDRESS, 'no-address');
    const urlsOk = Array.isArray(list) && list.length && list.every((a) => { try { return /^https?:$/.test(new URL(a).protocol); } catch { return false; } });
    if (!urlsOk) fail(400, 'Give this device at least one http or https address.');
    const clean = list.map((a) => new URL(a).origin);
    const bad = clean.find(loopbackIn);
    if (bad && !allowLoopback()) {
      fail(400, host ? `${bad} means the device you are on, not the host. Use the host's Wi-Fi address, like 192.168.1.24:7777.`
        : `${bad} means this device itself, so no other device can reach it. Use this device's Wi-Fi address, like 192.168.1.24:7777.`, 'loopback');
    }
    return clean;
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
  const arrived = (r) => r.status > 0 && r.status < 500 && r.status !== 429;
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

  // Whoever keeps data of the room (task, message and chat copies) registers here and wipes it when this device is out.
  const dropHandlers = [];
  const pairHandlers = [];
  function drop() { data.room = null; persist(); for (const fn of dropHandlers) fn(); changed(); }
  // Whoever holds a connection that was opened because of the room (forward.js) looks again when the members or the host change.
  const changeHandlers = [];
  const changed = () => { for (const fn of changeHandlers) { try { fn(); } catch { /* a listener must not break the room */ } } };

  async function create(body, req) {
    if (data.room) fail(409, 'This device is already in a room. Leave it first.');
    const name = text(body.name) || os.hostname();
    const list = body.addresses === undefined ? myAddresses(req) : body.addresses;
    data.room = { id: crypto.randomBytes(8).toString('hex'), hostId: data.deviceId, revoked: [], members: [
      { deviceId: data.deviceId, name, publicKey: data.identity.publicKey, addresses: addresses(list), role: 'host', joinedAt: now(), ...access({ level: 'admin' }) }] };
    persist();
    return view();
  }

  function invite(req, body = {}) {
    if (joining) fail(409, 'A computer connection is already in progress. Try again when it finishes.');
    needHost();
    // Spent and expired codes are remembered for an hour so the joiner is told which it was.
    for (const [key, entry] of invitations) if (now() - entry.expiresAt > 60 * 60_000) invitations.delete(key);
    const reachable = myAddresses(req);
    if (!reachable.length) reachable.push(...me().addresses.filter((a) => allowLoopback() || !loopbackIn(a)));
    if (!reachable.length) fail(409, NO_ADDRESS, 'no-address');
    const code = newCode();
    invitations.set(hash(code), { expiresAt: now() + INVITE_MS, personal: body.connectionType === 'personal' });
    return { code: formatCode(code), expiresInSeconds: INVITE_MS / 1000, roomId: data.room.id, addresses: reachable, address: reachable[0], invite: inviteLine(reachable[0], code) };
  }

  // On the joining device: its owner picks the level and folders other room members get on this device.
  async function join(body, req) {
    if (joining) fail(409, 'A computer connection is already in progress.');
    // Showing an invite creates a host with no peers. It must not prevent that
    // same computer from scanning the other computer's invite instead.
    if (data.room && !(isHost() && data.room.members.length === 1)) {
      fail(409, 'This computer already has connections. Show its QR and scan it from the new computer instead. Existing connections have been kept.', 'existing-connections');
    }
    joining = true;
    try {
      const code = text(body.code, 200) || fail(400, 'Give the join code.');
      const hostAddresses = addresses(Array.isArray(body.host) ? body.host : [body.host], { host: true });
      const self = { deviceId: data.deviceId, name: text(body.name) || os.hostname(), publicKey: data.identity.publicKey, addresses: addresses(body.addresses ?? myAddresses(req)), ...access(body) };
      const hostSecret = secret();
      const r = await send({ addresses: hostAddresses }, 'accept', { code, hostSecret, ...self, connectionType: body.connectionType });
      if (r.status === 0) fail(502, `Could not reach the host at ${hostAddresses.join(' or ')}.`, 'unreachable');
      if (r.status !== 200) fail(r.status, r.body.error || 'The host did not accept the code.', r.body.code);
      const { roomId, hostId, memberSecret, members, revoked } = r.body;
      invitations.clear();
      data.room = { id: roomId, hostId, revoked, memberSecret, hostSecretHash: hash(hostSecret), members };
      persist();
      changed();

      // The host now calls this device back. A device the host cannot reach is in the room but cut off, so say so.
      const host = hostName();
      const check = await send(host, 'ping', { roomId, from: data.deviceId, secret: memberSecret, check: true });
      return { ...view(), pairing: { deviceId: hostId, personal: body.connectionType === 'personal' && r.body.personal === true }, callback: check.body.callback ?? { ok: false, address: self.addresses[0], tried: self.addresses, error: 'The host did not answer the check.' } };
    } finally { joining = false; }
  }

  // This device's own addresses changed, or were wrong at join. The host is told and calls back again.
  async function setAddress(body, req) {
    need();
    const list = addresses(body.addresses ?? myAddresses(req));
    me().addresses = list;
    persist();
    if (isHost()) { announce(); changed(); return { ...view(), callback: { ok: true, address: list[0], tried: list } }; }
    const host = hostName();
    const r = await send(host, 'notify', { roomId: data.room.id, from: data.deviceId, secret: data.room.memberSecret, type: 'address', addresses: list });
    if (r.status !== 200) fail(r.status === 0 ? 502 : r.status, r.status === 0 ? `Could not reach the host at ${host.addresses.join(' or ')}.` : r.body.error || 'The host did not accept the address.', r.status === 0 ? 'unreachable' : r.body.code);
    const check = await send(host, 'ping', { roomId: data.room.id, from: data.deviceId, secret: data.room.memberSecret, check: true });
    return { ...view(), callback: check.body.callback ?? { ok: false, address: list[0], tried: list, error: 'The host did not answer the check.' } };
  }

  // Calls a member back on each of its addresses, the way the host talks to it later. Says which address worked or which failed.
  async function probe(member) {
    const tried = [];
    for (const address of member.addresses) {
      const r = await send({ addresses: [address] }, 'ping', { roomId: data.room.id, from: data.deviceId, secret: member.hostSecret });
      if (r.status === 200) { unreachable.delete(member.deviceId); member.lastSeen = now(); persist(); return { ok: true, address, tried: [...tried, address] }; }
      tried.push(address);
    }
    unreachable.add(member.deviceId);
    return { ok: false, address: member.addresses[0], tried, error: 'No answer from this device.' };
  }

  // On the host: a device presents a join code. Public route, the code is the credential.
  async function accept(body) {
    if (joining) fail(409, 'A computer connection is already in progress. Try again when it finishes.');
    needHost();
    const key = hash(normalizeCode(body.code));
    const entry = invitations.get(key);
    if (!entry) fail(403, 'That code is not right. Check it and try again.', 'wrong-code');
    if (entry.usedAt) fail(403, 'That code was already used. Ask the host for a new code.', 'used-code');
    if (entry.expiresAt <= now()) fail(403, 'That code has expired. Ask the host for a new code.', 'expired-code');
    const info = { publicKey: body.publicKey, name: text(body.name) || fail(400, 'Give a name.'), addresses: addresses(body.addresses), ...access(body) };
    const deviceId = text(body.deviceId, 64) || fail(400, 'Give a device id.');
    if (accessResolver && (!/^[0-9a-f]{4,64}$/.test(deviceId) || typeof body.publicKey !== 'string' || body.publicKey.length > 1000)) fail(400, 'A verified device identity is required.');
    if (accessResolver) { try { if (crypto.createPublicKey(body.publicKey).asymmetricKeyType !== 'ed25519') throw new Error(); } catch { fail(400, 'Invalid device identity.'); } }
    const hostSecret = typeof body.hostSecret === 'string' && body.hostSecret.length >= 32 ? body.hostSecret : fail(400, 'Give a secret.');
    if (data.room.members.some((m) => m.deviceId === deviceId)) fail(409, 'This device is already in the room.');
    entry.usedAt = now();
    const memberSecret = secret();
    data.outbox = data.outbox.filter((i) => !(i.deviceId === deviceId && i.body.type === 'kicked'));
    data.room.revoked = data.room.revoked.filter((r) => r.deviceId !== deviceId);
    data.room.members.push({ deviceId, ...info, role: 'member', joinedAt: now(), hostSecret, secretHash: hash(memberSecret) });
    persist();
    announce(deviceId);

    changed();
    const personal = entry.personal === true && body.connectionType === 'personal';
    for (const fn of pairHandlers) fn({ deviceId, personal });
    return { personal, roomId: data.room.id, hostId: data.room.hostId, memberSecret, members: publicMembers(), revoked: data.room.revoked };
  }

  async function leave() {
    if (joining) fail(409, 'A computer connection is already in progress.');
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

    changed();
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
    changed();
    return view();
  }

  const asMember = (body) => {
    const member = data.room?.members.find((m) => m.deviceId === body.from);
    return data.room && body.roomId === data.room.id && member && same(hash(body.secret), member.secretHash) ? member : null;
  };
  const fromHost = (body) => data.room && !isHost() && body.roomId === data.room.id && body.from === data.room.hostId && same(hash(body.secret), data.room.hostSecretHash);

  // Peer liveness. A member proves itself to the host; the host proves itself to a member.
  async function ping(body) {
    if (data.room && isHost()) {
      const member = asMember(body);
      if (!member) {
        if (data.room.revoked.some((r) => r.deviceId === body.from)) fail(403, 'This device was removed from the room.');
        fail(403, 'Not a member of this room.');
      }
      if (typeof body.publicKey === 'string' && body.publicKey.length < 1000 && !member.publicKey) {
        try { if (crypto.createPublicKey(body.publicKey).asymmetricKeyType === 'ed25519') member.publicKey = body.publicKey; } catch {}
      }
      member.lastSeen = now();
      persist();
      const callback = body.check === true ? await probe(member) : undefined;
      return { ok: true, deviceId: data.deviceId, roomId: data.room.id, hostId: data.room.hostId, members: publicMembers(), revoked: data.room.revoked, ...(callback && { callback }) };
    } else if (!fromHost(body)) fail(403, 'Not the host of this room.');
    return { ok: true, deviceId: data.deviceId, roomId: data.room.id, hostId: data.room.hostId };
  }

  // One ping to one peer. A success refreshes lastSeen; a member also takes the host's current list from the answer, which is
  // how a member that missed an announcement catches up. A host that says this device was removed ends its access here too.
  async function pingPeer(peer) {
    const host = isHost();
    const r = await send(peer, 'ping', { roomId: data.room.id, from: data.deviceId, secret: host ? peer.hostSecret : data.room.memberSecret, publicKey: data.identity.publicKey });
    if (!host && r.status === 403 && /removed/.test(r.body.error || '')) { drop(); return r; }
    if (r.status === 200) {
      unreachable.delete(peer.deviceId);
      if (!host && Array.isArray(r.body.members) && r.body.members.some((m) => m.deviceId === data.deviceId)) {
        data.room.members = r.body.members.map(publicMember);
        me().publicKey = data.identity.publicKey;
        data.room.revoked = Array.isArray(r.body.revoked) ? r.body.revoked : data.room.revoked;
        data.room.hostId = r.body.hostId;
        changed();

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
      if (!member || !['leave', 'address', 'access'].includes(body.type)) fail(403, 'Not allowed.');
      if (body.type === 'access') { member.access = body.access; persist(); announce(member.deviceId); return { ok: true }; }
      if (body.type === 'address') {
        member.addresses = addresses(body.addresses);
        persist();
        announce(member.deviceId);
        return { ok: true };
      }
      removeMember(member, 'left');
      announce();
      return { ok: true };
    }
    if (!fromHost(body)) fail(403, 'Only the host can tell a member something.');
    if (body.type === 'kicked') { drop(); return { ok: true }; }
    if (body.type === 'members') {
      if (!Array.isArray(body.members) || !body.members.some((m) => m.deviceId === data.deviceId)) fail(400, 'Bad member list.');
      data.room.members = body.members.map(publicMember);
      me().publicKey = data.identity.publicKey;
      data.room.revoked = Array.isArray(body.revoked) ? body.revoked : [];
      data.room.hostId = body.hostId;
      persist();
      changed();

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
      changed();

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

  // A request from another device of this room, proven by headers instead of a login. The sender is the device that holds
  // the secret; the origin is the member on whose behalf it acts. A member sending to the host acts only for itself. The host
  // sending to a member may vouch for any member (or itself). The destination checks the originating signature and its own grants.
  function authPeerRequest(h, request = {}) {
    const [roomId, sender, secret, from] = ['x-room-id', 'x-room-sender', 'x-room-secret', 'x-room-from'].map((k) => h[k]);
    if (![roomId, sender, secret, from].every((v) => typeof v === 'string' && v)) fail(403, 'Not a member of this room.');
    if (!data.room || roomId !== data.room.id) fail(403, 'Not a member of this room.');
    const mine = me();
    const principal = (origin) => {
      if (accessResolver && h['x-connection-target'] === data.deviceId) verifyRequest(h, request, origin);
      else if (accessResolver && (!isHost() || !/^[0-9a-f]{4,64}$/.test(h['x-connection-target'] || '') || !request.path?.startsWith(`/m/${h['x-connection-target']}/`))) fail(403, 'A signed device request is required.');
      const access = accessResolver?.(origin.deviceId);
      return { roomId, origin: origin.deviceId, name: origin.name,
        level: access ? (h['x-connection-target'] === data.deviceId && access.computerAccess ? 'admin' : 'external') : mine.level,
        folders: access ? [] : mine.folders };
    };
    if (isHost()) {
      const member = asMember({ roomId, from: sender, secret });
      if (!member) fail(403, data.room.revoked.some((r) => r.deviceId === sender) ? 'This device was removed from the room.' : 'Not a member of this room.');
      if (from !== sender) fail(403, 'A member can only act for itself.');
      return { ...principal(member), relay: true };
    }
    if (!fromHost({ roomId, from: sender, secret })) fail(403, 'Only the host can vouch for a member.');
    const origin = data.room.members.find((m) => m.deviceId === from);
    if (!origin || origin.deviceId === data.deviceId) fail(403, 'Not a member of this room.');
    return { ...principal(origin), relay: false };
  }

  // End-to-end identity proof: the network host may relay, but cannot impersonate another computer.
  function signRequest(targetId, method, pathname, channelKey = '') {
    const stamp = String(now()), nonce = crypto.randomBytes(16).toString('hex');
    const payload = JSON.stringify([data.deviceId, targetId, method, pathname, stamp, nonce, channelKey]);
    return { ...(channelKey && { 'x-connection-channel-key': channelKey }), 'x-connection-target': targetId, 'x-connection-time': stamp, 'x-connection-nonce': nonce,
      'x-connection-signature': crypto.sign(null, Buffer.from(payload), data.identity.privateKey).toString('base64') };
  }
  function verifyRequest(h, request, origin) {
    const stamp = h['x-connection-time'], nonce = h['x-connection-nonce'], signature = h['x-connection-signature'];
    if (Math.abs(now() - Number(stamp)) > 60_000 || !/^\d{10,16}$/.test(stamp || '') || !/^[0-9a-f]{32}$/.test(nonce || '') || typeof signature !== 'string') fail(403, 'Invalid device signature.');
    for (const [key, at] of nonces) if (now() - at > 60_000) nonces.delete(key);
    const key = `${origin.deviceId}:${nonce}`;
    if (nonces.has(key)) fail(403, 'Device request was already used.');
    const publicKey = keyResolver?.(origin.deviceId) || origin.publicKey;
    const payload = JSON.stringify([origin.deviceId, data.deviceId, request.method, request.path, stamp, nonce, h['x-connection-channel-key'] || '']);
    let valid = false;
    try { valid = crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64')); } catch {}
    if (!valid) fail(403, 'Invalid device signature.');
    nonces.set(key, now());
  }

  // How this device reaches `targetId`: straight, or through the host (a member holds a secret for the host only).
  function route(targetId) {
    need();
    const target = data.room.members.find((m) => m.deviceId === targetId);
    if (!target) fail(404, 'No such device in the room.');
    if (target.deviceId === data.deviceId) fail(400, 'That is this device.');
    const base = { roomId: data.room.id, sender: data.deviceId, deviceId: target.deviceId, name: target.name };
    if (isHost()) return target.hostSecret ? { ...base, addresses: target.addresses, secret: target.hostSecret, relayTo: null } : fail(409, 'This device has no secret for that member.');
    const host = hostName();
    return { ...base, addresses: host.addresses, secret: data.room.memberSecret, relayTo: target === host ? null : target.deviceId, ...(target !== host && { via: host.name }) };
  }

  // For the machine switcher: every device, whether it answers, and the rank this device's user has there.
  async function devices(fresh) {
    if (!data.room) return { deviceId: data.deviceId, devices: [{ deviceId: data.deviceId, name: os.hostname(), self: true, rank: 'owner', online: true, path: 'direct' }] };
    if (fresh) await live();
    return { deviceId: data.deviceId, devices: publicMembers().map((m) => ({ deviceId: m.deviceId, name: m.name, role: m.role, online: m.status === 'online',
      self: m.deviceId === data.deviceId, rank: m.deviceId === data.deviceId ? 'owner' : accessResolver ? (m.access?.[data.deviceId]?.computerAccess ? 'admin' : 'external') : m.level, ...(m.level === 'collaborator' && m.deviceId !== data.deviceId && { folders: m.folders }),
      path: m.deviceId === data.deviceId || isHost() || m.role === 'host' ? 'direct' : 'host' })) };
  }

  async function handleApi(req, res, url, { readJson, sendJson, loggedIn, guard }) {
    const name = url.pathname.split('/')[3];
    const peer = req.method === 'POST' && (name === 'ping' || name === 'accept' || name === 'notify');
    if (!peer && !loggedIn) return sendJson(res, 401, { error: 'Not logged in' });
    const locked = peer && guard?.refuse(req);
    if (locked) return sendJson(res, locked.status, { error: locked.error });
    let sender;
    try {
      const body = req.method === 'POST' && req.headers['content-type'] ? await readJson(req) : {};
      sender = body.from ?? body.deviceId;
      const again = peer && guard?.refuse(req, sender);
      if (again) return sendJson(res, again.status, { error: again.error });
      const routes = {
        'GET ': async () => ({ ...(url.searchParams.get('live') ? await live() : view()), advertised: myAddresses(req), allowLoopback: allowLoopback() }),
        'GET devices': () => devices(url.searchParams.get('live')),
        'POST create': () => create(body, req), 'POST invite': () => invite(req, body), 'POST join': () => join(body, req), 'POST leave': leave, 'POST address': () => setAddress(body, req),
        'POST kick': () => kick(body), 'POST handover': () => handover(body),
        'POST ping': () => ping(body), 'POST accept': () => accept(body), 'POST notify': () => notify(body),
      };
      const route = routes[`${req.method} ${name ?? ''}`];
      if (!route) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, await route());
    } catch (err) {
      if (peer && err.status === 403) guard?.fail(req, sender);
      return sendJson(res, err.status || 400, { error: err.message, ...(err.code && typeof err.code === 'string' && err.status && { code: err.code }) });
    }
  }

  function setLocalAccess(access) {
    if (!data.room) return;
    me().access = access;
    persist();
    changed();
    if (isHost()) announce();
    else send(hostName(), 'notify', { roomId: data.room.id, from: data.deviceId, secret: data.room.memberSecret, type: 'access', access }).catch(() => {});
  }


  return { handleApi, view, tick, members: () => data.room ? publicMembers() : [],
    signMessage: (message) => crypto.sign(null, Buffer.from(message), data.identity.privateKey).toString('base64'),
    verifyMessage: (id, message, signature) => { try { return typeof signature === 'string' && crypto.verify(null, Buffer.from(message), keyResolver?.(id) || data.room?.members.find((m) => m.deviceId === id)?.publicKey, Buffer.from(signature, 'base64')); } catch { return false; } },
    create, invite, join, leave, kick, handover, devices, signRequest, legacyMembers, setLocalAccess,
    setAccessResolver: (resolve, keys) => { accessResolver = resolve; keyResolver = keys; },
    onPair: (fn) => pairHandlers.push(fn),
 isTrustedAdmin: (deviceId) => trustedAdmins().includes(deviceId), close: stopTimer, deviceId: () => data.deviceId, authPeerRequest, route, onDrop: (fn) => dropHandlers.push(fn),
    onChange: (fn) => changeHandlers.push(fn), snapshot: () => data.room && { id: data.room.id, hostId: data.room.hostId, ids: data.room.members.map((m) => m.deviceId) } };
}
