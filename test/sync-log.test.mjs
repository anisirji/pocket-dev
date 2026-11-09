import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSyncLog, reduceChanges, parseReadableId, readableId } from '../sync-log.js';

const clockAt = (t) => () => t;
const obj = (m) => Object.fromEntries([...m].sort());
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synclog-')), 'room', 'log.jsonl');

test('duplicates are ignored', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const c = a.append({ type: 'msg', key: 'm1', value: 'hi' });
  const b = createSyncLog({ device: 'B', now: clockAt(100) });
  assert.equal(b.apply([c]).length, 1);
  assert.equal(b.apply([c, c]).length, 0);
  assert.equal(b.all().length, 1);
  assert.deepEqual(obj(b.state()), { m1: 'hi' });
});

test('out-of-order arrival fills the gap before the cursor moves', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const [c1, c2, c3] = [1, 2, 3].map((i) => a.append({ type: 'msg', key: `m${i}`, value: i }));
  const b = createSyncLog({ device: 'B' });
  b.apply([c3, c1]);
  assert.deepEqual(b.cursors(), { A: 1 });
  assert.deepEqual(b.changesSince(b.cursors()).map((c) => c.id), ['A:3']);
  b.apply([c2]);
  assert.deepEqual(b.cursors(), { A: 3 });
  assert.deepEqual(obj(b.state()), obj(a.state()));
});

test('two devices editing the same key: later time wins, tie goes to the greater device id', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const b = createSyncLog({ device: 'B', now: clockAt(200) });
  const ea = a.append({ type: 'task', key: 't1.title', value: 'from A' });
  const eb = b.append({ type: 'task', key: 't1.title', value: 'from B' });
  a.apply([eb]); b.apply([ea]);
  assert.equal(a.get('t1.title'), 'from B');
  assert.equal(b.get('t1.title'), 'from B');

  const c = createSyncLog({ device: 'A', now: clockAt(500) });
  const d = createSyncLog({ device: 'B', now: clockAt(500) });
  const ec = c.append({ type: 't', key: 'k', value: 'A' });
  const ed = d.append({ type: 't', key: 'k', value: 'B' });
  c.apply([ed]); d.apply([ec]);
  assert.equal(c.get('k'), 'B');
  assert.equal(d.get('k'), 'B');
});

test('the receiving clock moves past a remote time, so a later local edit wins', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(1000) });
  const b = createSyncLog({ device: 'B', now: clockAt(10) }); // slow clock
  b.apply([a.append({ type: 't', key: 'k', value: 'A' })]);
  const e = b.append({ type: 't', key: 'k', value: 'B after seeing A' });
  a.apply([e]);
  assert.equal(a.get('k'), 'B after seeing A');
});

test('delete then a late edit made before the delete: the delete stays', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const b = createSyncLog({ device: 'B', now: clockAt(100) });
  const create = a.append({ type: 'task', key: 't1', value: 'x' });
  b.apply([create]);
  const lateEdit = b.append({ type: 'task', key: 't1', value: 'edited offline' }); // at 100,l=1
  const del = a.remove('task', 't1'); // at 100,l=1 on A; tie broken by device id, B > A
  const x = createSyncLog({ device: 'X' }); const y = createSyncLog({ device: 'Y' });
  x.apply([create, del, lateEdit]); y.apply([lateEdit, del, create]);
  assert.deepEqual(obj(x.state()), obj(y.state()));

  // an edit strictly later than the delete brings the key back, on every device
  const a2 = createSyncLog({ device: 'A', now: clockAt(100) });
  const c1 = a2.append({ type: 'task', key: 't', value: 1 });
  const d1 = a2.remove('task', 't');
  const b2 = createSyncLog({ device: 'B', now: clockAt(900) });
  const e1 = b2.append({ type: 'task', key: 't', value: 'revived' });
  const m = createSyncLog({ device: 'M' });
  m.apply([e1, d1, c1]);
  assert.equal(m.get('t'), 'revived');
  const n = createSyncLog({ device: 'N' });
  n.apply([c1, d1]);
  assert.equal(n.state().has('t'), false);
  assert.equal(n.all().find((c) => c.deleted).deleted, true);
});

test('a delete syncs to a device that had the value', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const b = createSyncLog({ device: 'B', now: clockAt(100) });
  b.apply(a.changesSince(b.cursors()).concat());
  b.apply([a.append({ type: 'm', key: 'k', value: 1 })]);
  assert.equal(b.get('k'), 1);
  a.remove('m', 'k');
  b.apply(a.changesSince(b.cursors()));
  assert.equal(b.state().has('k'), false);
});

test('an offline device catches up from its cursors and then sends its own', () => {
  const a = createSyncLog({ device: 'A', now: clockAt(100) });
  const b = createSyncLog({ device: 'B', now: clockAt(100) });
  const c = createSyncLog({ device: 'C', now: clockAt(100) });
  for (const l of [a, b]) l.apply(c.changesSince({}));
  a.append({ type: 'msg', key: 'a1', value: 1 });
  b.apply(a.changesSince(b.cursors()));
  b.append({ type: 'msg', key: 'b1', value: 2 });
  a.apply(b.changesSince(a.cursors()));
  // C was off the whole time
  const missed = a.changesSince(c.cursors());
  assert.deepEqual(missed.map((x) => x.id).sort(), ['A:1', 'B:1']);
  c.apply(missed);
  const own = c.append({ type: 'msg', key: 'c1', value: 3 });
  assert.equal(own.id, 'C:1');
  a.apply(c.changesSince(a.cursors())); b.apply(c.changesSince(b.cursors()));
  assert.deepEqual(obj(a.state()), obj(c.state()));
  assert.deepEqual(obj(b.state()), obj(c.state()));
  assert.deepEqual(a.changesSince(c.cursors()), []);
});

test('persistence: reload restores state, cursors and the local counter', () => {
  const file = tmpFile();
  const a = createSyncLog({ device: 'A', file, now: clockAt(100) });
  a.append({ type: 'm', key: 'k', value: 'v1' });
  a.append({ type: 'm', key: 'k', value: 'v2' });
  const other = createSyncLog({ device: 'B', now: clockAt(100) });
  a.apply([other.append({ type: 'm', key: 'j', value: 'b' })]);
  a.remove('m', 'j');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.appendFileSync(file, '{"torn":'); // crash mid-write

  const r = createSyncLog({ device: 'A', file, now: clockAt(50) }); // clock went backwards
  assert.deepEqual(obj(r.state()), { k: 'v2' });
  assert.deepEqual(r.cursors(), { A: 3, B: 1 });
  const next = r.append({ type: 'm', key: 'k', value: 'v3' });
  assert.equal(next.id, 'A:4');
  assert.equal(r.get('k'), 'v3'); // hybrid time did not go backwards

  r.compact();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  const r2 = createSyncLog({ device: 'A', file });
  assert.deepEqual(obj(r2.state()), obj(r.state()));
  assert.equal(r2.all().length, 5);
});

test('readable ids: device code plus counter, distinct across offline devices', () => {
  const a = createSyncLog({ device: 'dev-a', code: 'MAC', now: clockAt(1) });
  const b = createSyncLog({ device: 'dev-b', code: 'LNX', now: clockAt(1) });
  assert.equal(a.nextReadableId(), 'MAC-1');
  const c = a.append({ type: 'task', key: 'task:1', value: {} });
  assert.equal(a.readableId(c), 'MAC-1');
  for (let i = 0; i < 13; i++) a.append({ type: 'task', key: `task:${i + 2}`, value: {} });
  assert.equal(a.nextReadableId(), 'MAC-15');
  b.append({ type: 'task', key: 'task:x', value: {} });
  assert.equal(b.nextReadableId(), 'LNX-2');
  assert.deepEqual(parseReadableId('MAC-14'), { code: 'MAC', counter: 14 });
  assert.equal(parseReadableId('nope'), null);
  assert.equal(readableId('MAC', 14), 'MAC-14');
  assert.match(createSyncLog({ device: 'x' }).code, /^[0-9A-F]{4}$/);
});

test('convergence: random interleavings, duplicates and batching give identical state', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = (n) => Math.floor(rand() * n);
  for (let round = 0; round < 30; round++) {
    const devs = ['A', 'B', 'C', 'D'].map((d) => createSyncLog({ device: d, now: () => 100 + pick(5) }));
    const keys = ['k1', 'k2', 'k3', 'k4'];
    const made = [];
    for (let i = 0; i < 40; i++) {
      const d = devs[pick(devs.length)];
      if (rand() < 0.3) d.apply(made.filter(() => rand() < 0.3)); // partial sync
      const key = keys[pick(keys.length)];
      made.push(rand() < 0.25 ? d.remove('t', key) : d.append({ type: 't', key, value: `${d.device}${i}` }));
    }
    const expected = obj(reduceChanges(made));
    for (let k = 0; k < 8; k++) {
      const shuffled = made.concat(made.filter(() => rand() < 0.4)).sort(() => rand() - 0.5);
      const r = createSyncLog({ device: 'R' });
      for (let i = 0; i < shuffled.length;) { const n = 1 + pick(6); r.apply(shuffled.slice(i, i + n)); i += n; }
      assert.deepEqual(obj(r.state()), expected);
      assert.deepEqual(r.cursors(), Object.fromEntries(['A', 'B', 'C', 'D'].map((d) => [d, made.filter((c) => c.device === d).length]).filter(([, n]) => n)));
    }
  }
});
