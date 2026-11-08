import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { powerStatus, vitals } from './power.js';
import { collectPerformance, PERFORMANCE_LIMITS } from './performance.js';
export { parseMemoryFree } from './performance.js';

const TOP = process.env.POCKET_DEV_TOP || '/usr/bin/top';
const IOREG = process.env.POCKET_DEV_IOREG || '/usr/sbin/ioreg';
const PACKAGE = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// A reading that cannot be taken is null, never a guess: a panel that shows 0% for "unknown" would look healthy.
const run = (file, args = []) => new Promise((resolve) => {
  execFile(file, args, { timeout: 10_000, maxBuffer: 4_000_000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

const toMB = (n, unit) => Math.round(Number(n) * (unit === 'G' ? 1024 : 1));

// "CPU usage: 3.82% user, 6.88% sys, 89.28% idle" and "PhysMem: 7514M used (1220M wired, 3272M compressor), 97M unused."
// top is sampled twice, so only the last of each line counts: the first is an average since boot.
export function parseTop(text) {
  const cpu = [...text.matchAll(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/g)].at(-1);
  const mem = [...text.matchAll(/PhysMem: (\d+)([MG]) used \((\d+)([MG]) wired, (\d+)([MG]) compressor\), (\d+)([MG]) unused/g)].at(-1);
  return {
    cpuUsedPercent: cpu ? Math.round(100 - Number(cpu[3])) : null,
    memory: mem ? { usedMB: toMB(mem[1], mem[2]), wiredMB: toMB(mem[3], mem[4]), compressedMB: toMB(mem[5], mem[6]) } : null,
  };
}

// How worn the battery is: its full-charge capacity against what it was built with, and cycles against its rated life.
export function parseBatteryCondition(text) {
  const number = (key) => Number(new RegExp(`"${key}" = (\\d+)`).exec(text)?.[1]);
  const [cycles, designCycles, current, design] = ['CycleCount', 'DesignCycleCount9C', 'AppleRawMaxCapacity', 'DesignCapacity'].map(number);
  if (!Number.isFinite(cycles) || !(design > 0) || !(current > 0)) return null;
  return { cycles, designCycles: Number.isFinite(designCycles) ? designCycles : null, capacityPercent: Math.min(100, Math.round((current / design) * 100)) };
}

const WORN_BELOW = 80;
const { cpuBusy: CPU_BUSY, memoryLow: MEMORY_TIGHT, memoryCritical: MEMORY_CRITICAL, diskLowGB: DISK_LOW_GB, diskCriticalGB: DISK_CRITICAL_GB } = PERFORMANCE_LIMITS;

// One verdict for the whole panel, from the same alert rules the phone banner uses plus the load and wear checks.
export function judge({ alerts, condition, cpuUsedPercent, memoryFreePercent, diskFreeGB }) {
  const issues = alerts.map(({ level, text }) => ({ level, text }));
  const add = (level, text) => issues.push({ level, text });
  if (condition && condition.capacityPercent < WORN_BELOW) add('warning', `The battery has worn to ${condition.capacityPercent}% of its original capacity (${condition.cycles} charge cycles).`);
  if (cpuUsedPercent !== null && cpuUsedPercent >= CPU_BUSY) add('warning', `The processor is busy (${cpuUsedPercent}% in use).`);
  if (memoryFreePercent !== null && memoryFreePercent < MEMORY_TIGHT) add(memoryFreePercent < MEMORY_CRITICAL ? 'critical' : 'warning', `Memory is tight (${memoryFreePercent}% free). Close heavy apps.`);
  if (diskFreeGB !== null && diskFreeGB < DISK_LOW_GB) add(diskFreeGB < DISK_CRITICAL_GB ? 'critical' : 'warning', `Disk space is low (${diskFreeGB.toFixed(1)} GB free).`);
  issues.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  const status = issues.some((i) => i.level === 'critical') ? 'attention' : issues.length ? 'watch' : 'good';
  return { status, issues };
}

export async function collectHealth() {
  const [power, readings, top, performance, ioreg] = await Promise.all([
    powerStatus(), vitals(), run(TOP, ['-l', '2', '-n', '0', '-s', '1']), collectPerformance(), run(IOREG, ['-r', '-n', 'AppleSmartBattery']),
  ]);
  const parsed = parseTop(top);
  const cpuUsedPercent = performance.cpu.usedPercent ?? parsed.cpuUsedPercent;
  const memory = parsed.memory;
  const memoryFreePercent = performance.memory.freePercent;
  const condition = parseBatteryCondition(ioreg);
  const disk = performance.disk;
  return {
    ...judge({ alerts: [...readings.alerts, ...performance.alerts.filter((a) => a.key === 'response')], condition, cpuUsedPercent, memoryFreePercent, diskFreeGB: disk.freeGB }),
    battery: { percent: power.battery, charging: power.charging, onAC: power.onAC, timeRemaining: power.timeRemaining, condition },
    temperature: readings.temperature,
    limits: readings.limits,
    cpu: { usedPercent: cpuUsedPercent, load: Math.round(os.loadavg()[0] * 100) / 100, cores: os.cpus().length },
    memory: memory && { ...memory, freePercent: memoryFreePercent },
    memoryFreePercent,
    disk,
    eventLoopDelayMs: performance.eventLoopDelayMs,
    power: { awake: power.awake, stayingAwake: power.stayingAwake, lidClosed: power.lidClosed, lidSleepDisabled: power.lidSleepDisabled },
    mac: { name: os.hostname(), uptimeSec: Math.round(os.uptime()) },
    network: Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address),
    pocketDev: { version: PACKAGE.version, node: process.version, uptimeSec: Math.round(process.uptime()) },
  };
}
