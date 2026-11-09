import { defaultCode, readableId, parseReadableId } from './sync-log.js';

const STATUSES = ['todo', 'doing', 'done'];
const FIELDS = ['title', 'description', 'status', 'assignee'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Room tasks (MAC-14). Every device keeps all tasks in tasks.jsonl, a sync-log. One task is several keys, so two
// devices editing different fields both win: "MAC-14" (exists; a tombstone deletes it) and "MAC-14/title",
// "MAC-14/description", "MAC-14/status", "MAC-14/assignee" (last edit wins per field).
//
// The transport (star, cursors, catch-up) is room-sync.js; this file is the task model on top of it.
export function createTasks({ room, sync }) {
  const channel = sync.register('tasks');
  const theLog = () => channel.log();
  const need = () => room.peers() || fail(409, 'This device is not in a room.');

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
    changed();
    return getTask(id);
  }
  function edit(id, body) {
    const info = need();
    getTask(id);
    const fields = checked(body, info, true);
    if (!Object.keys(fields).length) fail(400, 'Nothing to change.');
    write(id, fields);
    changed();
    return getTask(id);
  }
  function remove(id) {
    const info = need();
    getTask(id);
    theLog().remove('task', id);
    changed();
    return { ok: true, id };
  }
  // Push everything the other devices have not acknowledged yet; exchange() works out the difference.
  const changed = () => channel.changed();

  async function handleApi(req, res, url, { readJson, sendJson, loggedIn }) {
    const parts = url.pathname.split('/'); // '', api, room, tasks|sync, id?
    try {
      if (!loggedIn) return sendJson(res, 401, { error: 'Not logged in' });
      const id = parts[4] && decodeURIComponent(parts[4]);
      const body = ['POST', 'PATCH'].includes(req.method) && req.headers['content-type'] ? await readJson(req) : {};
      if (!id) {
        if (req.method === 'GET') { need(); return sendJson(res, 200, { tasks: [...readAll().values()].sort((a, b) => a.updatedAt - b.updatedAt) }); }
        if (req.method === 'POST') return sendJson(res, 200, create(body));
      } else if (id === 'sync' && req.method === 'POST') {
        need();
        await channel.syncAll();
        return sendJson(res, 200, { ok: true });
      } else {
        if (req.method === 'GET') { need(); return sendJson(res, 200, getTask(id)); }
        if (req.method === 'PATCH') return sendJson(res, 200, edit(id, body));
        if (req.method === 'DELETE') return sendJson(res, 200, remove(id));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  }

  return { handleApi };
}
