import fs from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { platform } from './platform.js';

export { parseMemoryFree } from './platform.js';

const GB = 1024 ** 3;
export const PERFORMANCE_LIMITS = { cpuBusy: 90, memoryLow: 10, memoryCritical: 5, diskLowGB: 10, diskCriticalGB: 3, responseDelayMs: 1000 };
export const SAMPLE_MS = 5000;
const MEMORY_MS = 20_000;
const BUSY_ALERT_MS = 15_000;

export function cpuSnapshot(cores) {
  if (!Array.isArray(cores) || !cores.length) return null;
  let total = 0, idle = 0;
  for (const core of cores) {
    const values = ['user', 'nice', 'sys', 'idle', 'irq'].map((key) => core.times?.[key]);
    if (values.some((v) => !Number.isFinite(v) || v < 0)) return null;
    total += values.reduce((sum, value) => sum + value, 0);
    idle += core.times.idle;
  }
  return { total, idle, cores: cores.length };
}

export function cpuPercent(before, after) {
  if (!before || !after || before.cores !== after.cores) return null;
  const total = after.total - before.total, idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round((1 - idle / total) * 100);
}

export async function readDiskSpace({ location = os.homedir(), statfs = fs.statfs } = {}) {
  try {
    const s = await statfs(location);
    if (![s.bsize, s.blocks, s.bavail].every(Number.isFinite) || !(s.bsize > 0) || !(s.blocks > 0) || s.bavail < 0) throw new Error('No disk reading');
    return { freeGB: Math.round(s.bavail * s.bsize / GB * 10) / 10, totalGB: Math.round(s.blocks * s.bsize / GB) };
  } catch { return { freeGB: null, totalGB: null }; }
}

function bounded(read, fallback, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(read).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function performanceState({ cpu, memory, disk, eventLoopDelayMs, busyForMs = 0 }) {
  const limit = PERFORMANCE_LIMITS;
  const alerts = [];
  if (memory.freePercent !== null && memory.freePercent < limit.memoryLow) alerts.push({ key: 'memory', level: memory.freePercent < limit.memoryCritical ? 'critical' : 'warning', text: `${platform.host.Mac} memory is tight (${memory.freePercent}% free). Open apps to find what is using it.` });
  if (disk.freeGB !== null && disk.freeGB < limit.diskLowGB) alerts.push({ key: 'disk', level: disk.freeGB < limit.diskCriticalGB ? 'critical' : 'warning', text: `${platform.host.Mac} storage is low (${disk.freeGB.toFixed(1)} GB free). Free up space on ${platform.host.the}.` });
  if (eventLoopDelayMs !== null && eventLoopDelayMs >= limit.responseDelayMs) alerts.push({ key: 'response', level: 'warning', text: `Pocket Dev has been slow to respond. ${platform.host.The} may be under heavy load.` });
  if (cpu.usedPercent !== null && cpu.usedPercent >= limit.cpuBusy && busyForMs >= BUSY_ALERT_MS) alerts.push({ key: 'cpu', level: 'warning', text: `${platform.host.Mac} CPU has stayed busy (${cpu.usedPercent}% in use). Open apps to check what is running.` });
  alerts.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  const first = alerts[0];
  if (first) return { status: first.key, level: first.level, alerts };
  if (cpu.usedPercent !== null && cpu.usedPercent >= limit.cpuBusy) return { status: 'cpu', level: 'warning', alerts };
  if (cpu.usedPercent === null || memory.freePercent === null || disk.freeGB === null) return { status: 'unknown', level: 'unknown', alerts };
  return { status: 'normal', level: 'ok', alerts };
}

// All clients share one in-flight sample and a five-second cache. Memory pressure is sampled less often, never with
// its stress-test flags. CPU comes from counter deltas rather than repeatedly spawning top.
export function createPerformanceMonitor({ cpus = os.cpus, load = () => (platform.platform === 'win32' ? null : os.loadavg()[0]), disk = readDiskSpace,
  memory = () => platform.memoryFreePercent(), lag = () => null, now = Date.now, timeoutMs = 2500 } = {}) {
  let cached = null, pending = null, before = null, beforeAt = null, busySince = null;
  let memoryAt = -Infinity, memoryValue = null;
  async function sample() {
    const at = now();
    let after;
    try { after = cpuSnapshot(cpus()); } catch { after = null; }
    const continuous = beforeAt !== null && at - beforeAt <= 15_000;
    const usedPercent = continuous ? cpuPercent(before, after) : null;
    before = after; beforeAt = at;
    busySince = usedPercent !== null && usedPercent >= PERFORMANCE_LIMITS.cpuBusy ? busySince ?? at : null;
    const memoryReading = at - memoryAt >= MEMORY_MS ? bounded(memory, null, timeoutMs).then((value) => {
      memoryValue = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      memoryAt = now();
      return memoryValue;
    }) : Promise.resolve(memoryValue);
    const [diskReading, freePercent] = await Promise.all([bounded(disk, { freeGB: null, totalGB: null }, timeoutMs), memoryReading]);
    let delay = null, load1m = null;
    try { const value = lag(); if (continuous && Number.isFinite(value) && value >= 0) delay = Math.round(value); } catch {}
    try { const value = load(); if (Number.isFinite(value) && value >= 0) load1m = Math.round(value * 100) / 100; } catch {}
    const data = { sampledAt: now(), cpu: { usedPercent, cores: after?.cores ?? null, load1m },
      memory: { freePercent }, disk: diskReading, eventLoopDelayMs: delay };
    cached = { ...data, ...performanceState({ ...data, busyForMs: busySince === null ? 0 : at - busySince }), limits: PERFORMANCE_LIMITS };
    return cached;
  }
  return { read() {
    if (cached && now() - cached.sampledAt < SAMPLE_MS) return Promise.resolve(cached);
    pending ??= sample().finally(() => { pending = null; });
    return pending;
  } };
}

let monitor;
export function collectPerformance() {
  if (!monitor) {
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    monitor = createPerformanceMonitor({ lag: () => { const ms = delay.max / 1e6; delay.reset(); return ms; } });
  }
  return monitor.read();
}
