import fs from 'node:fs';
import os from 'node:os';
import { powerStatus, vitals } from './power.js';
import { collectPerformance, PERFORMANCE_LIMITS } from './performance.js';
import { platform } from './platform.js';

export { parseTop, parseMemoryFree, parseBatteryCondition } from './platform.js';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

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

// What the health sheet shows; any of these this system cannot read is listed in collectHealth().unsupported.
const HEALTH_FEATURES = ['temperature', 'batteryCondition', 'lid', 'keepAwake'];

export async function collectHealth() {
  const [power, readings, parsed, performance, condition] = await Promise.all([
    powerStatus(), vitals(), platform.cpuMemory(), collectPerformance(), platform.batteryCondition(),
  ]);
  const cpuUsedPercent = performance.cpu.usedPercent ?? parsed.cpuUsedPercent;
  const memory = parsed.memory;
  const memoryFreePercent = performance.memory.freePercent;
  const disk = performance.disk;
  return {
    ...judge({ alerts: [...readings.alerts, ...performance.alerts.filter((a) => a.key === 'response')], condition, cpuUsedPercent, memoryFreePercent, diskFreeGB: disk.freeGB }),
    battery: { percent: power.battery, charging: power.charging, onAC: power.onAC, timeRemaining: power.timeRemaining, condition },
    temperature: readings.temperature,
    limits: readings.limits,
    cpu: { usedPercent: cpuUsedPercent, load: platform.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100, cores: os.cpus().length },
    memory: memory && { ...memory, freePercent: memoryFreePercent },
    memoryFreePercent,
    disk,
    eventLoopDelayMs: performance.eventLoopDelayMs,
    power: { awake: power.awake, stayingAwake: power.stayingAwake, lidClosed: power.lidClosed, lidSleepDisabled: power.lidSleepDisabled },
    mac: { name: platform.hostname(), uptimeSec: Math.round(os.uptime()) },
    network: platform.lanIps(),
    unsupported: platform.unsupported(HEALTH_FEATURES),
    pocketDev: { version: PACKAGE.version, node: process.version, uptimeSec: Math.round(process.uptime()) },
  };
}
