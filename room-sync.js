import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { createSyncLog } from './sync-log.js';

const PEER_TIMEOUT_MS = 5000;
const BLOB_TIMEOUT_MS = 30_000;
const PAGE = 500;
const PUSH_BYTES = 40_000; // the server refuses bodies over 64 KB
// Pictures and attachments travel on request, never inside a sync. Bigger ones stay on their device.
export const BLOB_MAX = Number(process.env.POCKET_DEV_BLOB_MAX) || 10 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Syncing shared room data over the room star. Each kind of data is a channel with its own sync-log file
// ("tasks", "messages", "chats"). The room is a star: a member only holds a secret for the host, the host holds one per
// member. So a member sends to the host, and the host passes what it learned on to the other members. Catch-up is a pull
// with sync-log cursors, then a push of whatever the other side lacks, run at start and on a timer.
//
// A channel may restrict who gets its changes (`shares`), check what arrives (`accept`), react to new changes
// (`onApplied`), and serve bytes on request (`blob`). When this device leaves the room every channel is wiped.
export function createRoomSync({ room, stateDir = STATE_DIR, fetchImpl = fetch, intervalMs = Number(process.env.POCKET_DEV_TASK_SYNC_MS) || 30_000 }) {
  const channels = new Map();
  const busy = new Set();

  // shares(originDevice, recipientDevice, info): may changes made on originDevice go to recipientDevice?
  // accept(change, info): is an incoming change acceptable? onClear(): the room is gone, delete derived data.
  function register(name, { shares = () => true, accept = () => true, onApplied = () => {}, onClear = () => {}, blob = null } = {}) {
    const ch = { name, file: path.join(stateDir, `${name}.jsonl`), shares, accept, onApplied, onClear, blob, log: null };
    channels.set(name, ch);
    return {
      log: () => createLog(ch),
      changed: () => changed(ch),
      syncAll: () => syncChannel(ch),
      fetchBlob: (origin, ref) => fetchBlob(ch, origin, ref),
      inRoom: () => Boolean(room.peers()),
    };
  }

  // ---- sending to peers ----
  async function raw(peer, route, body, timeout = PEER_TIMEOUT_MS) {
    let last = { status: 0, body: {} };
    for (const address of peer.addresses) {
      try {
        const res = await fetchImpl(`${address}/api/room/sync/${route}`, { method: 'POST', signal: AbortSignal.timeout(timeout),
          headers: { 'content-type': 'application/json', 'x-pocket-dev': '1' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      } catch { /* try the next address */ }
    }
    return last;
  }
  const call = async (peer, route, body) => { const r = await raw(peer, route, body); return r.status === 200 ? r.body : null; };
  const auth = (info, peer) => ({ roomId: info.roomId, from: info.deviceId, secret: peer.secret });

  function batches(changes) {
    const out = [];
    let cur = [], size = 0;
    for (const c of changes) {
      const n = JSON.stringify(c).length;
      if (cur.length && size + n > PUSH_BYTES) { out.push(cur); cur = []; size = 0; }
      cur.push(c); size += n;
    }
    if (cur.length) out.push(cur);
    return out;
  }
  const visible = (ch, info, to, changes) => changes.filter((c) => ch.shares(c.device, to, info));
  async function pushTo(ch, info, peer, changes) {
    let cursors = null;
    for (const batch of batches(visible(ch, info, peer.deviceId, changes))) {
      const r = await call(peer, `${ch.name}/push`, { ...auth(info, peer), changes: batch });
      if (!r) return null;
      cursors = r.cursors;
    }
    return cursors;
  }
  const stillThere = (info) => room.peers()?.roomId === info.roomId;
  // Counters of a room that was left are never reused: devices that stayed still hold those changes and would ignore new ones.
  const floorFile = (ch) => `${ch.file}.floor`;
  const readFloor = (ch) => { try { return Number(fs.readFileSync(floorFile(ch), 'utf8')) || 0; } catch { return 0; } };
  const createLog = (ch) => ch.log ||= createSyncLog({ device: room.deviceId(), file: ch.file, floor: readFloor(ch) });
  function applyIncoming(ch, info, changes) {
    const ok = (Array.isArray(changes) ? changes : []).filter((c) => c && typeof c === 'object' && ch.accept(c, info));
    const added = createLog(ch).apply(ok);
    if (added.length) ch.onApplied(added);
    return added;
  }

  // Pull what the peer has that we lack, then push what it lacks. Safe to repeat.
  async function exchange(ch, info, peer) {
    const key = `${ch.name}:${peer.deviceId}`;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      let theirs = null;
      for (let i = 0; i < 40; i++) {
        const r = await call(peer, `${ch.name}/pull`, { ...auth(info, peer), cursors: createLog(ch).cursors() });
        if (!r || !stillThere(info)) return;
        theirs = r.cursors;
        const added = applyIncoming(ch, info, r.changes);
        if (info.isHost) relay(ch, info, added, peer.deviceId);
        if (!r.more) break;
      }
      if (stillThere(info)) await pushTo(ch, info, peer, createLog(ch).changesSince(theirs || {}));
    } finally { busy.delete(key); }
  }

  // Tell everyone we can reach (except `skip`) about new changes. Failures are fine: the timer catches them up.
  function relay(ch, info, changes, skip) {
    if (!changes.length) return Promise.resolve();
    const targets = room.peers()?.list.filter((p) => p.deviceId !== skip) || [];
    return Promise.all(targets.map((p) => pushTo(ch, info, p, changes).catch(() => null)));
  }

  async function syncChannel(ch) {
    const info = room.peers();
    if (!info) return;
    await Promise.all(info.list.map((p) => exchange(ch, info, p).catch(() => {})));
  }
  const syncAll = () => Promise.all([...channels.values()].map(syncChannel));
  // Push everything the other devices have not acknowledged yet; exchange() works out the difference.
  function changed(ch) {
    const info = room.peers();
    if (info) for (const p of info.list) exchange(ch, info, p).catch(() => {});
  }

  // ---- bytes on request ----
  // A member asks the host, and the host asks the device the bytes live on: members hold no secret for each other.
  async function fetchBlob(ch, origin, ref) {
    const info = room.peers() || fail(409, 'This device is not in a room.');
    const target = info.isHost ? info.list.find((p) => p.deviceId === origin) : info.list[0];
    if (!target) fail(404, 'That device is not in this room.');
    const r = await raw(target, `${ch.name}/blob`, { ...auth(info, target), origin, ref }, BLOB_TIMEOUT_MS);
    if (r.status !== 200) fail(r.status === 0 ? 502 : r.status, r.body.error || 'Could not fetch it.');
    return { ...r.body, data: Buffer.from(r.body.data || '', 'base64') };
  }

  // ---- receiving from peers ----
  async function peerRoute(ch, route, body) {
    const from = room.authPeer(body);
    if (!from) fail(403, 'Not a member of this room.');
    const info = room.peers();
    if (route === 'push') {
      const added = applyIncoming(ch, info, body.changes);
      if (info.isHost) relay(ch, info, added, from);
      return { ok: true, added: added.length, cursors: createLog(ch).cursors() };
    }
    if (route === 'pull') {
      const all = visible(ch, info, from, createLog(ch).changesSince(body.cursors && typeof body.cursors === 'object' ? body.cursors : {}));
      return { changes: all.slice(0, PAGE), more: all.length > PAGE, cursors: createLog(ch).cursors() };
    }
    if (route === 'blob' && ch.blob) {
      const origin = typeof body.origin === 'string' && body.origin ? body.origin : info.deviceId;
      if (!ch.shares(origin, from, info)) fail(403, 'Not shared with you.');
      if (origin === info.deviceId) {
        const b = await ch.blob(body.ref);
        return { type: b.type, size: b.data.length, data: b.data.toString('base64') };
      }
      if (!info.isHost) fail(404, 'Ask the host for this.');
      const r = await fetchBlob(ch, origin, body.ref);
      return { type: r.type, size: r.data.length, data: r.data.toString('base64') };
    }
    return fail(404, 'Not found');
  }

  async function handleApi(req, res, url, { readJson, sendJson, guard }) {
    const parts = url.pathname.split('/'); // '', api, room, sync, channel, route   (old tasks route: sync/push)
    const legacy = ['push', 'pull'].includes(parts[4]);
    const ch = channels.get(legacy ? 'tasks' : parts[4]);
    const locked = guard?.refuse(req);
    if (locked) return sendJson(res, locked.status, { error: locked.error });
    let sender;
    try {
      if (!ch) fail(404, 'Not found');
      const body = await readJson(req);
      sender = body.from;
      const again = guard?.refuse(req, sender);
      if (again) return sendJson(res, again.status, { error: again.error });
      return sendJson(res, 200, await peerRoute(ch, legacy ? parts[4] : parts[5], body));
    } catch (err) {
      if (err.status === 403) guard?.fail(req, sender);
      return sendJson(res, err.status || 400, { error: err.message });
    }
  }

  // Leaving or being kicked: the data of that room goes, so it can never sync into another room.
  function clear() {
    for (const ch of channels.values()) {
      const used = Math.max(readFloor(ch), ...createLog(ch).all().filter((c) => c.device === room.deviceId()).map((c) => c.counter));
      fs.writeFileSync(floorFile(ch), String(used), { mode: 0o600 });
      ch.log = null;
      fs.rmSync(ch.file, { force: true });
      ch.onClear();
    }
  }
  room.onDrop?.(clear);

  function start() {
    setTimeout(() => syncAll().catch(() => {}), 300).unref();
    setInterval(() => syncAll().catch(() => {}), intervalMs).unref();
  }

  return { register, handleApi, start, syncAll, clear };
}
