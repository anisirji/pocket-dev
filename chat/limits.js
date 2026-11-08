// What a chat tells the owner when Claude or Codex reports how much of a usage limit is left. Each function turns one
// report into chat events: a status line for a warning, an error line when the limit is hit. `seen` remembers what
// was already said, so a report that repeats on every turn says nothing the second time.

const CLAUDE_WINDOWS = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', overage: 'extra usage' };
const CODEX_REACHED = {
  rate_limit_reached: 'Codex usage limit reached.',
  workspace_owner_credits_depleted: 'Codex workspace credits are used up.',
  workspace_member_credits_depleted: 'Codex workspace credits are used up.',
  workspace_owner_usage_limit_reached: 'Codex workspace usage limit reached.',
  workspace_member_usage_limit_reached: 'Codex workspace usage limit reached.',
};
const WARN_TIERS = [80, 90, 100];

// Both CLIs send epoch seconds; a value that large is already milliseconds.
const toDate = (epoch) => new Date(epoch > 1e12 ? epoch : epoch * 1000);

export function resetText(epoch, now = new Date()) {
  const d = toDate(epoch);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `at ${time}`;
  const days = (d - now) / 86_400_000;
  return days < 6 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
const resets = (epoch) => (Number.isFinite(epoch) ? ` Resets ${resetText(epoch)}.` : '');
const percent = (u) => (Number.isFinite(u) ? Math.round(u <= 1 ? u * 100 : u) : null);

// One Claude `rate_limit_event`: { status, rateLimitType, utilization, resetsAt, surpassedThreshold, unifiedWindows }.
// Claude sends one every turn, nearly always `allowed`, which says nothing.
export function claudeLimitNotice(info, seen) {
  const type = info?.rateLimitType ?? 'usage';
  const key = `claude:${type}`;
  const label = CLAUDE_WINDOWS[type] ?? 'usage';
  if (info?.status === 'allowed') {
    seen.delete(key);
    return null;
  }
  const used = percent(info?.utilization ?? info?.unifiedWindows?.[type]?.utilization);
  const state = info?.status === 'rejected' ? 'rejected' : `warn:${info?.surpassedThreshold ?? used}`;
  if (!['rejected', 'allowed_warning'].includes(info?.status) || seen.get(key) === state) return null;
  seen.set(key, state);
  return info.status === 'rejected'
    ? { type: 'error', message: `Claude ${label} limit reached.${resets(info.resetsAt)}` }
    : { type: 'status', text: `Claude ${label} limit: ${used === null ? 'nearly used up' : `${used}% used`}.${resets(info.resetsAt)}` };
}

const windowName = (mins) => (mins === 300 ? '5-hour' : mins === 10080 ? 'weekly' : mins === 1440 ? 'daily'
  : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`);

// One Codex `account/rateLimits/updated` snapshot: { limitId, primary, secondary, rateLimitReachedType }, each window
// { usedPercent, windowDurationMins, resetsAt }. A window speaks again only when it climbs to a higher tier.
export function codexLimitNotices(snapshot, seen) {
  const notices = [];
  const id = snapshot?.limitId ?? 'codex';
  for (const slot of ['primary', 'secondary']) {
    const w = snapshot?.[slot];
    if (!w || !Number.isFinite(w.usedPercent)) continue;
    const key = `codex:${id}:${slot}`;
    const tier = WARN_TIERS.filter((t) => w.usedPercent >= t).at(-1) ?? 0;
    const before = seen.get(key) ?? 0;
    seen.set(key, tier);
    if (tier <= before) continue;
    const name = Number.isFinite(w.windowDurationMins) ? `${windowName(w.windowDurationMins)} ` : '';
    notices.push(tier === 100
      ? { type: 'error', message: `Codex ${name}limit reached.${resets(w.resetsAt)}` }
      : { type: 'status', text: `Codex ${name}limit: ${Math.round(w.usedPercent)}% used.${resets(w.resetsAt)}` });
  }
  const reached = snapshot?.rateLimitReachedType;
  const reachedKey = `codex:${id}:reached`;
  if (!reached) seen.delete(reachedKey);
  else if (seen.get(reachedKey) !== reached) {
    seen.set(reachedKey, reached);
    // The window already said so when it hit 100%; only workspace and credit limits add something.
    if (!notices.some((n) => n.type === 'error') || reached !== 'rate_limit_reached') {
      notices.push({ type: 'error', message: CODEX_REACHED[reached] ?? 'Codex limit reached.' });
    }
  }
  return notices;
}
