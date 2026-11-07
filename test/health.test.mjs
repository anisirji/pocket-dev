import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTop, parseMemoryFree, parseBatteryCondition, judge } from '../health.js';

const TOP = `Processes: 500 total
Load Avg: 9.00, 9.00, 9.00
CPU usage: 50.00% user, 40.00% sys, 10.00% idle
PhysMem: 9999M used (1M wired, 1M compressor), 1M unused.
Processes: 500 total
Load Avg: 1.86, 1.70, 1.75
CPU usage: 3.82% user, 6.88% sys, 89.28% idle
PhysMem: 7514M used (1220M wired, 3272M compressor), 97M unused.
`;

test('top is read from its last sample, because the first averages everything since boot', () => {
  const top = parseTop(TOP);
  assert.equal(top.cpuUsedPercent, 11);
  assert.deepEqual(top.memory, { usedMB: 7514, wiredMB: 1220, compressedMB: 3272 });
});

test('memory in gigabytes is converted, and unreadable output is null, not zero', () => {
  assert.equal(parseTop('CPU usage: 1.00% user, 1.00% sys, 98.00% idle\nPhysMem: 15G used (2G wired, 3G compressor), 1G unused.').memory.usedMB, 15360);
  assert.deepEqual(parseTop(''), { cpuUsedPercent: null, memory: null });
  assert.deepEqual(parseTop('garbage'), { cpuUsedPercent: null, memory: null });
});

test('memory free percentage comes from memory_pressure', () => {
  assert.equal(parseMemoryFree('The system has 17179869184 (1048576 pages)\nSystem-wide memory free percentage: 40%\n'), 40);
  assert.equal(parseMemoryFree(''), null);
});

test('battery condition is full-charge capacity against design, with cycles against rated life', () => {
  const ioreg = '"CycleCount" = 760\n"DesignCycleCount9C" = 1000\n"DesignCapacity" = 4382\n"AppleRawMaxCapacity" = 3678\n"BatteryData" = {"DesignCapacity"=4382}';
  assert.deepEqual(parseBatteryCondition(ioreg), { cycles: 760, designCycles: 1000, capacityPercent: 84 });
  assert.equal(parseBatteryCondition('"CycleCount" = 3\n"DesignCapacity" = 100\n"AppleRawMaxCapacity" = 140').capacityPercent, 100, 'never above 100%');
});

test('no battery or a missing field reads as no condition', () => {
  assert.equal(parseBatteryCondition(''), null);
  assert.equal(parseBatteryCondition('No'), null);
  assert.equal(parseBatteryCondition('"CycleCount" = 5'), null);
});

const calm = { alerts: [], condition: { cycles: 100, designCycles: 1000, capacityPercent: 95 }, cpuUsedPercent: 10, memoryFreePercent: 40, diskFreeGB: 50 };

test('a calm Mac is healthy with nothing to report', () => {
  assert.deepEqual(judge(calm), { status: 'good', issues: [] });
});

test('worn battery, busy processor, tight memory and low disk each raise a warning', () => {
  assert.equal(judge({ ...calm, condition: { cycles: 900, designCycles: 1000, capacityPercent: 79 } }).status, 'watch');
  assert.equal(judge({ ...calm, condition: { cycles: 900, designCycles: 1000, capacityPercent: 80 } }).status, 'good', '80% is the line, not below it');
  assert.match(judge({ ...calm, cpuUsedPercent: 90 }).issues[0].text, /busy \(90%/);
  assert.equal(judge({ ...calm, cpuUsedPercent: 89 }).status, 'good');
  assert.match(judge({ ...calm, memoryFreePercent: 9 }).issues[0].text, /Memory is tight/);
  assert.match(judge({ ...calm, diskFreeGB: 9.5 }).issues[0].text, /Disk space is low/);
});

test('very low memory or disk needs attention, and the most urgent issue comes first', () => {
  assert.equal(judge({ ...calm, memoryFreePercent: 4 }).status, 'attention');
  assert.equal(judge({ ...calm, diskFreeGB: 2.9 }).status, 'attention');
  const mixed = judge({ ...calm, cpuUsedPercent: 95, diskFreeGB: 1 });
  assert.deepEqual(mixed.issues.map((i) => i.level), ['critical', 'warning']);
  assert.equal(mixed.status, 'attention');
});

test('the battery and heat alerts flow into the verdict', () => {
  const alerts = [{ level: 'critical', key: 'battery', text: 'Mac battery is critically low (8%).' }];
  const verdict = judge({ ...calm, alerts });
  assert.equal(verdict.status, 'attention');
  assert.equal(verdict.issues[0].text, 'Mac battery is critically low (8%).');
});

test('a reading that could not be taken does not count as a problem or as healthy proof', () => {
  const unknown = judge({ alerts: [], condition: null, cpuUsedPercent: null, memoryFreePercent: null, diskFreeGB: null });
  assert.deepEqual(unknown, { status: 'good', issues: [] });
});
