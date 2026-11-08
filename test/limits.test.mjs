import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLimitNotice, codexLimitNotices, resetText } from '../chat/limits.js';

const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

test('Claude: a warning says how much is used and when it resets, once per level', () => {
  const seen = new Map();
  const warn = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.92, surpassedThreshold: 0.9, resetsAt: inHours(2) };
  const first = claudeLimitNotice(warn, seen);
  assert.equal(first.type, 'status');
  assert.match(first.text, /^Claude 5-hour limit: 92% used\. Resets /);
  assert.equal(claudeLimitNotice(warn, seen), null, 'the same report says nothing twice');
  assert.match(claudeLimitNotice({ ...warn, surpassedThreshold: 0.95, utilization: 0.96 }, seen).text, /96% used/, 'a higher level speaks again');
});

test('Claude: a real event that carries the percentage only in unifiedWindows still reads', () => {
  const info = { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: inHours(1), unifiedWindows: { five_hour: { utilization: 0.81, status: 'allowed_warning' } } };
  assert.match(claudeLimitNotice(info, new Map()).text, /81% used/);
});

test('Claude: hitting the limit is an error with the reset time; allowed clears it so it can speak again', () => {
  const seen = new Map();
  const hit = { status: 'rejected', rateLimitType: 'seven_day', resetsAt: inHours(30) };
  const notice = claudeLimitNotice(hit, seen);
  assert.equal(notice.type, 'error');
  assert.match(notice.message, /^Claude weekly limit reached\. Resets /);
  assert.equal(claudeLimitNotice(hit, seen), null);
  assert.equal(claudeLimitNotice({ status: 'allowed', rateLimitType: 'seven_day' }, seen), null);
  assert.equal(claudeLimitNotice(hit, seen).type, 'error', 'after the window reopened, hitting it again is news');
  assert.equal(claudeLimitNotice({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }, new Map()), null, 'an allowed report is silent');
});

test('Codex: warns at 80, 90 and 100 percent, each once, and says which window', () => {
  const seen = new Map();
  const at = (usedPercent) => codexLimitNotices({ limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: inHours(1) } }, seen);
  assert.deepEqual(at(14), []);
  assert.match(at(82)[0].text, /^Codex 5-hour limit: 82% used\. Resets /);
  assert.deepEqual(at(85), [], 'same tier, silent');
  assert.match(at(91)[0].text, /91% used/);
  const full = at(100);
  assert.equal(full[0].type, 'error');
  assert.match(full[0].message, /^Codex 5-hour limit reached\. Resets /);
  assert.deepEqual(at(100), []);
  assert.deepEqual(at(5), [], 'the window reset');
  assert.match(at(81)[0].text, /81% used/, 'and warns again on the next climb');
});

test('Codex: a weekly window is named, and a workspace limit adds its own message', () => {
  const seen = new Map();
  const weekly = codexLimitNotices({ limitId: 'codex', primary: { usedPercent: 93, windowDurationMins: 10080, resetsAt: inHours(70) } }, seen);
  assert.match(weekly[0].text, /^Codex weekly limit: 93% used\./);
  const ws = codexLimitNotices({ limitId: 'codex', primary: { usedPercent: 40 }, rateLimitReachedType: 'workspace_member_credits_depleted' }, seen);
  assert.deepEqual(ws, [{ type: 'error', message: 'Codex workspace credits are used up.' }]);
  assert.deepEqual(codexLimitNotices({ limitId: 'codex', rateLimitReachedType: 'workspace_member_credits_depleted' }, seen), []);
  assert.deepEqual(codexLimitNotices(null, seen), []);
});

test('reset times read as a clock time today, a weekday soon, a date later; seconds or milliseconds', () => {
  const now = new Date(2026, 10, 8, 10, 0);
  assert.match(resetText(new Date(2026, 10, 8, 15, 0).getTime() / 1000, now), /^at \d{1,2}:00/);
  assert.match(resetText(new Date(2026, 10, 10, 15, 0).getTime() / 1000, now), /^[A-Z][a-z]{2} \d{1,2}:00/);
  assert.match(resetText(new Date(2026, 10, 20, 15, 0).getTime(), now), /^\d{1,2} Nov|Nov \d{1,2}/);
});
