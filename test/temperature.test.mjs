import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatteryC, parseThermal, alertsFor } from '../power.js';

const LIMITS = { batteryPercent: 20, temperatureC: 40 };
const mac = (over = {}) => ({ onAC: false, charging: false, battery: 80, temperature: { batteryC: 31, thermal: 'nominal' }, ...over });

test('battery temperature is read from ioreg in hundredths of a degree', () => {
  assert.equal(parseBatteryC('    "Temperature" = 3068\n    "VirtualTemperature" = 3359'), 30.68);
  assert.equal(parseBatteryC('"Temperature" = 4510'), 45.1);
});

test('no battery, a zero, or junk reads as no temperature rather than 0 °C', () => {
  assert.equal(parseBatteryC(''), null);
  assert.equal(parseBatteryC('"Temperature" = 0'), null);
  assert.equal(parseBatteryC('No'), null);
});

test('thermal state maps macOS levels 0 to 3 and rejects anything else', () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => parseThermal(`${n}\n`)), ['nominal', 'fair', 'serious', 'critical']);
  assert.equal(parseThermal('4'), null);
  assert.equal(parseThermal('not a number'), null);
  assert.equal(parseThermal(''), null, 'an empty answer is not nominal');
});

test('a healthy Mac raises no alert', () => {
  assert.deepEqual(alertsFor(mac(), LIMITS), []);
});

test('low battery alerts only when not charging, and escalates at 10%', () => {
  assert.equal(alertsFor(mac({ battery: 20 }), LIMITS)[0].level, 'warning');
  assert.deepEqual(alertsFor(mac({ battery: 21 }), LIMITS), []);
  assert.equal(alertsFor(mac({ battery: 10 }), LIMITS)[0].level, 'critical');
  assert.match(alertsFor(mac({ battery: 8 }), LIMITS)[0].text, /lose open work/);
  assert.deepEqual(alertsFor(mac({ battery: 5, onAC: true }), LIMITS), [], 'plugged in is not an emergency');
  assert.deepEqual(alertsFor(mac({ battery: 5, charging: true }), LIMITS), []);
  assert.deepEqual(alertsFor(mac({ battery: null }), LIMITS), [], 'a Mac with no battery never alerts about it');
});

test('heat alerts on the battery temperature limit or on macOS thermal pressure', () => {
  assert.equal(alertsFor(mac({ temperature: { batteryC: 40, thermal: 'nominal' } }), LIMITS)[0].level, 'warning');
  assert.equal(alertsFor(mac({ temperature: { batteryC: 45, thermal: 'nominal' } }), LIMITS)[0].level, 'critical');
  assert.deepEqual(alertsFor(mac({ temperature: { batteryC: 39.9, thermal: 'fair' } }), LIMITS), [], 'fair is only warm');
  assert.equal(alertsFor(mac({ temperature: { batteryC: null, thermal: 'serious' } }), LIMITS)[0].level, 'warning');
  assert.equal(alertsFor(mac({ temperature: { batteryC: 30, thermal: 'critical' } }), LIMITS)[0].level, 'critical');
  assert.deepEqual(alertsFor(mac({ temperature: { batteryC: null, thermal: null } }), LIMITS), [], 'no reading, no alert');
});

test('limits come from the settings, and the most urgent alert comes first', () => {
  const both = alertsFor(mac({ battery: 9, temperature: { batteryC: 41, thermal: 'nominal' } }), LIMITS);
  assert.deepEqual(both.map((a) => `${a.level}:${a.key}`), ['critical:battery', 'warning:hot']);
  assert.equal(alertsFor(mac({ battery: 30 }), { ...LIMITS, batteryPercent: 30 }).length, 1);
  assert.equal(alertsFor(mac({ temperature: { batteryC: 36, thermal: 'nominal' } }), { ...LIMITS, temperatureC: 35 }).length, 1);
});
