import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuSnapshot, cpuPercent, parseMemoryFree, readDiskSpace, performanceState, createPerformanceMonitor } from '../performance.js';

const core = (user, idle, sys = 0) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });
const calm = { cpu: { usedPercent: 20 }, memory: { freePercent: 40 }, disk: { freeGB: 50, totalGB: 256 }, eventLoopDelayMs: 10 };

test('CPU is total-machine usage between samples, with unknown for reset or absent counters', () => {
  const before = cpuSnapshot([core(100, 900), core(100, 900)]);
  const after = cpuSnapshot([core(150, 950), core(125, 975)]);
  assert.equal(cpuPercent(before, after), 38);
  assert.equal(cpuPercent(before, before), null);
  assert.equal(cpuPercent(after, before), null);
  assert.equal(cpuPercent(before, cpuSnapshot([core(200, 1000)])), null);
  assert.equal(cpuSnapshot([]), null);
  assert.equal(cpuSnapshot([core(NaN, 1)]), null);
});

test('free disk space uses available blocks on the home disk and unreadable sensors stay unknown', async () => {
  let location;
  const disk = await readDiskSpace({ location: '/fixture/home', statfs: async (value) => { location = value; return { bavail: 2 * 1024 ** 2, blocks: 256 * 1024 ** 2, bsize: 1024 }; } });
  assert.equal(location, '/fixture/home');
  assert.deepEqual(disk, { freeGB: 2, totalGB: 256 });
  assert.deepEqual(await readDiskSpace({ statfs: async () => { throw new Error('denied'); } }), { freeGB: null, totalGB: null });
  assert.deepEqual(await readDiskSpace({ statfs: async () => ({ bavail: NaN, blocks: 1, bsize: 1 }) }), { freeGB: null, totalGB: null });
  assert.equal(parseMemoryFree('System-wide memory free percentage: 101%'), null);
  assert.equal(parseMemoryFree(''), null);
  assert.equal(parseMemoryFree('System-wide memory free percentage: 0%'), 0);
});

test('load states distinguish transient CPU, sustained CPU, low storage, tight memory and response delays', () => {
  assert.equal(performanceState(calm).status, 'normal');
  assert.deepEqual(performanceState({ ...calm, cpu: { usedPercent: 95 } }).alerts, []);
  assert.equal(performanceState({ ...calm, cpu: { usedPercent: 95 }, busyForMs: 15000 }).alerts[0].key, 'cpu');
  assert.equal(performanceState({ ...calm, memory: { freePercent: 9 } }).status, 'memory');
  assert.equal(performanceState({ ...calm, memory: { freePercent: 4 } }).level, 'critical');
  assert.equal(performanceState({ ...calm, disk: { freeGB: 2.9 } }).level, 'critical');
  assert.equal(performanceState({ ...calm, eventLoopDelayMs: 1500 }).status, 'response');
  assert.equal(performanceState({ ...calm, cpu: { usedPercent: null } }).status, 'unknown');
  assert.equal(performanceState({ ...calm, memory: { freePercent: null } }).status, 'unknown');
});

test('clients share in-flight work and cached samples; memory pressure is checked less often', async () => {
  let clock = 1000, reads = 0, memoryReads = 0, user = 0, idle = 0;
  let release;
  const firstDisk = new Promise((resolve) => { release = resolve; });
  const monitor = createPerformanceMonitor({ now: () => clock, cpus: () => [core(user, idle)], load: () => 2,
    memory: async () => { memoryReads++; return 40; }, lag: () => 10,
    disk: async () => { reads++; return reads === 1 ? firstDisk : calm.disk; } });
  const one = monitor.read(), two = monitor.read();
  assert.equal(one, two);
  release(calm.disk);
  assert.equal((await one).cpu.usedPercent, null);
  assert.equal((await monitor.read()).cpu.usedPercent, null);
  assert.equal(reads, 1);
  for (let n = 0; n < 4; n++) { clock += 5000; user += 95; idle += 5; await monitor.read(); }
  assert.equal(reads, 5);
  assert.equal(memoryReads, 2);
  assert.equal((await monitor.read()).alerts[0].key, 'cpu');
  clock += 60_000; user += 95; idle += 5;
  const afterSleep = await monitor.read();
  assert.equal(afterSleep.cpu.usedPercent, null, 'a long gap is not a fresh CPU interval');
  assert.ok(!afterSleep.alerts.some((a) => a.key === 'cpu'));
});

test('a stuck sensor times out without wedging monitoring and later readings can recover', async () => {
  let clock = 1000, stuck = true;
  const monitor = createPerformanceMonitor({ now: () => clock, cpus: () => [core(clock, clock)], load: () => 0, lag: () => 0,
    timeoutMs: 10, memory: async () => 40, disk: () => stuck ? new Promise(() => {}) : calm.disk });
  const first = await monitor.read();
  assert.equal(first.disk.freeGB, null);
  assert.equal(first.status, 'unknown');
  clock += 5000; stuck = false;
  const recovered = await monitor.read();
  assert.equal(recovered.disk.freeGB, 50);
  assert.equal(recovered.status, 'normal');
});

test('the production performance route checks owner access before taking a reading', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const dispatcher = source.slice(source.indexOf('async function handleApi('), source.indexOf('const handleGit ='));
  let allowed = false, guest = false, readings = 0;
  const runtime = {
    MUTATING: new Set(), CSRF_HEADER: 'x-pocket-dev', collaborators: { guest: () => guest ? {} : null },
    auth: { handleApi: async () => null, deviceFor: () => allowed ? {} : null },
    admin: { phoneApi: async () => null }, readJson: async () => ({}),
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    collectPerformance: async () => { readings++; return calm; },
  };
  vm.runInNewContext(`${dispatcher}\nthis.handle = handleApi;`, runtime);
  const call = () => runtime.handle({ method: 'GET', headers: {} }, {}, new URL('http://fixture/api/performance'));
  assert.equal((await call()).status, 401);
  allowed = true; assert.equal((await call()).status, 200);
  guest = true; assert.equal((await call()).status, 403);
  assert.equal(readings, 1);
});
