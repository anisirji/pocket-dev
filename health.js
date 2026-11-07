import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { powerStatus, vitals } from './power.js';

const TOP = process.env.POCKET_DEV_TOP || '/usr/bin/top';
const MEMORY_PRESSURE = process.env.POCKET_DEV_MEMORY_PRESSURE || '/usr/bin/memory_pressure';
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

// "System-wide memory free percentage: 40%". Used memory alone misleads, because macOS fills spare RAM with cache.
export function parseMemoryFree(text) {
  const free = /free percentage: (\d+)%/.exec(text)?.[1];
  return free === undefined ? null : Number(free);
}

// How worn the battery is: its full-charge capacity against what it was built with, and cycles against its rated life.
export function parseBatteryCondition(text) {
  const number = (key) => Number(new RegExp(`"${key}" = (\\d+)`).exec(text)?.[1]);
  const [cycles, designCycles, current, design] = ['CycleCount', 'DesignCycleCount9C', 'AppleRawMaxCapacity', 'DesignCapacity'].map(number);
  if (!Number.isFinite(cycles) || !(design > 0) || !(current > 0)) return null;
  return { cycles, designCycles: Number.isFinite(designCycles) ? designCycles : null, capacityPercent: Math.min(100, Math.round((current / design) * 100)) };
}

const GB = 1024 ** 3;
const WORN_BELOW = 80;
const CPU_BUSY = 90;
const MEMORY_TIGHT = 10;
const MEMORY_CRITICAL = 5;
const DISK_LOW_GB = 10;
const DISK_CRITICAL_GB = 3;

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

function diskSpace() {
  try {
    const s = fs.statfsSync('/');
    return { freeGB: Math.round((s.bavail * s.bsize / GB) * 10) / 10, totalGB: Math.round(s.blocks * s.bsize / GB) };
  } catch {
    return { freeGB: null, totalGB: null };
  }
}

export async function collectHealth() {
  const [power, readings, top, pressure, ioreg] = await Promise.all([
    powerStatus(), vitals(), run(TOP, ['-l', '2', '-n', '0', '-s', '1']), run(MEMORY_PRESSURE), run(IOREG, ['-r', '-n', 'AppleSmartBattery']),
  ]);
  const { cpuUsedPercent, memory } = parseTop(top);
  const memoryFreePercent = parseMemoryFree(pressure);
  const condition = parseBatteryCondition(ioreg);
  const disk = diskSpace();
  return {
    ...judge({ alerts: readings.alerts, condition, cpuUsedPercent, memoryFreePercent, diskFreeGB: disk.freeGB }),
    battery: { percent: power.battery, charging: power.charging, onAC: power.onAC, timeRemaining: power.timeRemaining, condition },
    temperature: readings.temperature,
    limits: readings.limits,
    cpu: { usedPercent: cpuUsedPercent, load: Math.round(os.loadavg()[0] * 100) / 100, cores: os.cpus().length },
    memory: memory && { ...memory, freePercent: memoryFreePercent },
    disk,
    power: { awake: power.awake, stayingAwake: power.stayingAwake, lidClosed: power.lidClosed, lidSleepDisabled: power.lidSleepDisabled },
    mac: { name: os.hostname(), uptimeSec: Math.round(os.uptime()) },
    network: Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address),
    pocketDev: { version: PACKAGE.version, node: process.version, uptimeSec: Math.round(process.uptime()) },
  };
}
