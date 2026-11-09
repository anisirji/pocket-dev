import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { createSyncLog, defaultCode, readableId, parseReadableId } from './sync-log.js';

const STATUSES = ['todo', 'doing', 'done'];
const FIELDS = ['title', 'description', 'status', 'assignee'];
const PEER_TIMEOUT_MS = 5000;
const PAGE = 500;
const PUSH_BYTES = 40_000; // the server refuses bodies over 64 KB
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Room tasks (MAC-14). Every device keeps all tasks in tasks.jsonl, a sync-log. One task is several keys, so two
// devices editing different fields both win: "MAC-14" (exists; a tombstone deletes it) and "MAC-14/title",
// "MAC-14/description", "MAC-14/status", "MAC-14/assignee" (last edit wins per field).
//
// The room is a star: a member only holds a secret for the host, the host holds one per member. So a member sends to
// the host, and the host passes what it learned on to the other members. Catch-up is a pull with sync-log cursors,
// then a push of whatever the other side lacks, run at start and on a timer.
export function createTasks({ room, stateDir = STATE_DIR, fetchImpl = fetch, intervalMs = Number(process.env.POCKET_DEV_TASK_SYNC_MS) || 30_000 }) {
  let log = null;
  const busy = new Set();
  const theLog = () => log ||= createSyncLog({ device: room.deviceId(), file: path.join(stateDir, 'tasks.jsonl') });
  const need = () => room.peers() || fail(409, 'This device is not in a room.');

  // ---- sending to peers ----
  async function call(peer, route, body) {
    for (const address of peer.addresses) {
      try {
        const res = await fetchImpl(`${address}/api/room/sync/${route}`, { method: 'POST', signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
          headers: { 'content-type': 'application/json', 'x-pocket-dev': '1' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => ({}));
        return res.ok ? json : null;
      } catch { /* try the next address */ }
    }
    return null;
  }
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
  async function pushTo(info, peer, changes) {
    let cursors = null;
    for (const batch of batches(changes)) {
      const r = await call(peer, 'push', { ...auth(info, peer), changes: batch });
      if (!r) return null;
      cursors = r.cursors;
    }
    return cursors;
  }

  // Pull what the peer has that we lack, then push what it lacks. Safe to repeat.
  async function exchange(info, peer) {
    if (busy.has(peer.deviceId)) return;
    busy.add(peer.deviceId);
    try {
      let theirs = null;
      for (let i = 0; i < 40; i++) {
        const r = await call(peer, 'pull', { ...auth(info, peer), cursors: theLog().cursors() });
        if (!r) return;
        theirs = r.cursors;
        const added = theLog().apply(Array.isArray(r.changes) ? r.changes : []);
        if (info.isHost) relay(info, added, peer.deviceId);
        if (!r.more) break;
      }
      await pushTo(info, peer, theLog().changesSince(theirs || {}));
    } finally { busy.delete(peer.deviceId); }
  }

  // Tell everyone we can reach (except `skip`) about new changes. Failures are fine: the timer catches them up.
  function relay(info, changes, skip) {
    if (!changes.length) return Promise.resolve();
    const targets = room.peers()?.list.filter((p) => p.deviceId !== skip) || [];
    return Promise.all(targets.map((p) => pushTo(info, p, changes).catch(() => null)));
  }

  async function syncAll() {
    const info = room.peers();
    if (!info) return;
    await Promise.all(info.list.map((p) => exchange(info, p).catch(() => {})));
  }

  // ---- receiving from peers ----
  function peerRoute(route, body) {
    const from = room.authPeer(body);
    if (!from) fail(403, 'Not a member of this room.');
    const info = room.peers();
    if (route === 'push') {
      const added = theLog().apply(Array.isArray(body.changes) ? body.changes : []);
      if (info.isHost) relay(info, added, from);
      return { ok: true, added: added.length, cursors: theLog().cursors() };
    }
    if (route === 'pull') {
      const all = theLog().changesSince(body.cursors && typeof body.cursors === 'object' ? body.cursors : {});
      return { changes: all.slice(0, PAGE), more: all.length > PAGE, cursors: theLog().cursors() };
    }
    return fail(404, 'Not found');
  }

  // ---- tasks ----
  function codeFor(info) {
    const mine = info.members.find((m) => m.deviceId === info.deviceId);
    const letters = (name) => (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    const code = letters(mine?.name);
    const clash = info.members.some((m) => m.deviceId !== info.deviceId && letters(m.name) === code);
    return code.length >= 2 && !clash ? code : defaultCode(info.deviceId);
  }

  // Folds the log into task objects in one pass (changes come oldest first, so the last one per key wins).
  function readAll() {
    const won = new Map();
    for (const c of theLog().all()) won.set(c.key, c);
    const out = new Map();
    for (const [key, c] of won) {
      if (c.type === 'task' && !c.deleted && !key.includes('/')) out.set(key, { id: key, title: '', description: '', status: 'todo', assignee: null, ...c.value, updatedAt: c.at.w });
    }
    for (const [key, c] of won) {
      const [id, field] = key.split('/');
      const task = field && !c.deleted && out.get(id);
      if (!task || !FIELDS.includes(field)) continue;
      task[field] = c.value;
      task.updatedAt = Math.max(task.updatedAt, c.at.w);
    }
    return out;
  }
  const getTask = (id) => readAll().get(id) || fail(404, 'No such task.');

  function checked(body, info, partial) {
    const out = {};
    if (!partial || body.title !== undefined) {
      out.title = typeof body.title === 'string' && body.title.trim() && body.title.length <= 200 ? body.title.trim() : fail(400, 'Give the task a title (up to 200 characters).');
    }
    if (body.description !== undefined) out.description = typeof body.description === 'string' && body.description.length <= 4000 ? body.description : fail(400, 'The description must be text up to 4000 characters.');
    if (body.status !== undefined) out.status = STATUSES.includes(body.status) ? body.status : fail(400, `Status must be one of ${STATUSES.join(', ')}.`);
    if (body.assignee !== undefined) {
      out.assignee = body.assignee === null || info.members.some((m) => m.deviceId === body.assignee) ? body.assignee : fail(400, 'The assignee must be a device in this room, or null.');
    }
    return out;
  }
  const write = (id, fields) => { for (const [f, v] of Object.entries(fields)) theLog().append({ type: 'task', key: `${id}/${f}`, value: v }); };

  function create(body) {
    const info = need();
    const fields = { description: '', status: 'todo', assignee: null, ...checked(body, info, false) };
    const code = codeFor(info);
    const taken = (n) => theLog().all().some((c) => c.key === readableId(code, n) && c.device !== info.deviceId);
    let n = 1 + Math.max(0, ...theLog().all().map((c) => { const p = c.type === 'task' && parseReadableId(c.key); return p && p.code === code ? p.counter : 0; }));
    while (taken(n)) n++;
    const id = readableId(code, n);
    const me = info.members.find((m) => m.deviceId === info.deviceId);
    theLog().append({ type: 'task', key: id, value: { createdBy: info.deviceId, createdByName: me?.name || null, createdAt: Date.now() } });
    write(id, fields);
    changed(info);
    return getTask(id);
  }
  function edit(id, body) {
    const info = need();
    getTask(id);
    const fields = checked(body, info, true);
    if (!Object.keys(fields).length) fail(400, 'Nothing to change.');
    write(id, fields);
    changed(info);
    return getTask(id);
  }
  function remove(id) {
    const info = need();
    getTask(id);
    theLog().remove('task', id);
    changed(info);
    return { ok: true, id };
  }
  // Push everything the other devices have not acknowledged yet; exchange() works out the difference.
  const changed = (info) => { for (const p of info.list) exchange(info, p).catch(() => {}); };

  async function handleApi(req, res, url, { readJson, sendJson, loggedIn }) {
    const parts = url.pathname.split('/'); // '', api, room, tasks|sync, id?
    try {
      if (parts[3] === 'sync') {
        const body = await readJson(req);
        return sendJson(res, 200, peerRoute(parts[4], body));
      }
      if (!loggedIn) return sendJson(res, 401, { error: 'Not logged in' });
      const id = parts[4] && decodeURIComponent(parts[4]);
      const body = ['POST', 'PATCH'].includes(req.method) && req.headers['content-type'] ? await readJson(req) : {};
      if (!id) {
        if (req.method === 'GET') { need(); return sendJson(res, 200, { tasks: [...readAll().values()].sort((a, b) => a.updatedAt - b.updatedAt) }); }
        if (req.method === 'POST') return sendJson(res, 200, create(body));
      } else if (id === 'sync' && req.method === 'POST') {
        need();
        await syncAll();
        return sendJson(res, 200, { ok: true });
      } else {
        if (req.method === 'GET') { need(); return sendJson(res, 200, getTask(id)); }
        if (req.method === 'PATCH') return sendJson(res, 200, edit(id, body));
        if (req.method === 'DELETE') return sendJson(res, 200, remove(id));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  }

  // Catch up now and then on a timer (a device that was off pulls what it missed; the host retries failed pushes).
  function start() {
    setTimeout(() => syncAll().catch(() => {}), 300).unref();
    setInterval(() => syncAll().catch(() => {}), intervalMs).unref();
  }

  return { handleApi, start, syncAll };
}
