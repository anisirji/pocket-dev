// Sync log: every device keeps a full local copy of shared room data as an
// append-only list of changes. No network and no database; the transport comes later.
//
// change = { id: 'deviceId:counter', device, counter, at: {w, l}, type, key, value, deleted? }
//   at is a hybrid logical time: w is wall-clock ms (never goes backwards), l breaks ties inside one ms.
//
// Per key the change with the greatest (at, device, counter) wins; a winning change with
// deleted:true is a tombstone, so the key is absent from the state and the delete syncs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function compareAt(a, b) {
  return a.w - b.w || a.l - b.l;
}

// Total order over all changes: the same on every device, so every device picks the same winner.
export function compareChanges(a, b) {
  return compareAt(a.at, b.at) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.counter - b.counter;
}

// Fold changes (any order, duplicates allowed) into current state: key -> value.
export function reduceChanges(changes) {
  const winners = new Map();
  for (const c of changes) {
    const cur = winners.get(c.key);
    if (!cur || compareChanges(c, cur) > 0) winners.set(c.key, c);
  }
  const state = new Map();
  for (const [key, c] of winners) if (!c.deleted) state.set(key, c.value);
  return state;
}

// Short code for readable ids (MAC-14). Pass your own (e.g. from the machine name) or take one derived from the device id.
export function defaultCode(deviceId) {
  return crypto.createHash('sha1').update(String(deviceId)).digest('hex').slice(0, 4).toUpperCase();
}
export const readableId = (code, counter) => `${code}-${counter}`;
export function parseReadableId(text) {
  const m = /^([A-Z0-9]+)-(\d+)$/.exec(text);
  return m ? { code: m[1], counter: Number(m[2]) } : null;
}

const valid = (c) => c && typeof c.device === 'string' && Number.isInteger(c.counter) && c.counter > 0
  && c.id === `${c.device}:${c.counter}` && c.at && Number.isFinite(c.at.w) && Number.isFinite(c.at.l)
  && typeof c.type === 'string' && typeof c.key === 'string';

// `floor`: counters up to this number were used by an earlier copy of this log (a room that was left), so never reuse them.
export function createSyncLog({ device, code = defaultCode(device), file = null, now = Date.now, floor = 0 } = {}) {
  if (!device) throw new Error('device id required');
  const byId = new Map();
  const cursors = {}; // device -> highest counter n with 1..n all present
  const clock = { w: 0, l: 0 };
  let own = floor;
  let state = new Map();
  let winners = new Map();

  function advanceCursor(dev) {
    let n = cursors[dev] || 0;
    while (byId.has(`${dev}:${n + 1}`)) n++;
    if (n) cursors[dev] = n;
  }

  function observe(at) {
    if (compareAt(at, clock) > 0) { clock.w = at.w; clock.l = at.l; }
  }

  function absorb(c) {
    byId.set(c.id, c);
    observe(c.at);
    if (c.device === device && c.counter > own) own = c.counter;
    const cur = winners.get(c.key);
    if (!cur || compareChanges(c, cur) > 0) {
      winners.set(c.key, c);
      if (c.deleted) state.delete(c.key); else state.set(c.key, c.value);
    }
  }

  function persist(list) {
    if (!file || !list.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, list.map((c) => JSON.stringify(c) + '\n').join(''), { mode: 0o600 });
  }

  // Apply changes from anywhere. Idempotent and order-independent. Returns the ones that were new.
  function apply(changes) {
    const added = [];
    for (const c of changes) {
      if (!valid(c) || byId.has(c.id)) continue;
      const copy = { ...c, at: { w: c.at.w, l: c.at.l } };
      absorb(copy);
      added.push(copy);
    }
    for (const dev of new Set(added.map((c) => c.device))) advanceCursor(dev);
    persist(added);
    return added;
  }

  // A new local change: next counter, next hybrid time.
  function append({ type, key, value, deleted = false }) {
    const wall = now();
    if (wall > clock.w) { clock.w = wall; clock.l = 0; } else clock.l++;
    const counter = own + 1;
    const c = { id: `${device}:${counter}`, device, counter, at: { w: clock.w, l: clock.l }, type, key, value };
    if (deleted) { c.deleted = true; delete c.value; }
    apply([c]);
    return byId.get(c.id);
  }

  const remove = (type, key) => append({ type, key, deleted: true });

  // "What did I miss?" Everything newer than the asker's cursors, in a stable order.
  function changesSince(theirs = {}) {
    return [...byId.values()].filter((c) => c.counter > (theirs[c.device] || 0)).sort(compareChanges);
  }

  // Rewrite the file without duplicate or damaged lines, via temp file then rename, mode 0600.
  function compact() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, [...byId.values()].sort(compareChanges).map((c) => JSON.stringify(c) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    const parsed = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { parsed.push(JSON.parse(line)); } catch { /* torn last line after a crash */ }
    }
    for (const c of parsed) if (valid(c) && !byId.has(c.id)) absorb(c);
    for (const dev of new Set([...byId.values()].map((c) => c.device))) advanceCursor(dev);
  }
  load();

  return {
    device, code,
    append, remove, apply, changesSince, compact,
    cursors: () => ({ ...cursors }),
    state: () => new Map(state),
    get: (key) => state.get(key),
    all: () => [...byId.values()].sort(compareChanges),
    nextReadableId: () => readableId(code, own + 1),
    readableId: (c) => readableId(code, c.counter),
  };
}
