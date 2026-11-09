'use strict';
// Pure helpers for the Admin page layout: which group each section belongs to, what needs attention, the badge on each
// group tab, and the wording for computers that are not a Mac. Loaded as a classic script by admin.html and by node:test.
(() => {
  const GROUPS = [
    { id: 'overview', label: 'Overview', sections: ['connection', 'cards'] },
    { id: 'devices', label: 'Devices & access', sections: ['pending', 'devices', 'sharing', 'collaborators'] },
    { id: 'internet', label: 'Internet', sections: ['internet', 'quickLink'] },
    { id: 'messages', label: 'Messages', sections: ['messages'] },
    { id: 'security', label: 'Security', sections: ['guessing', 'password', 'log', 'lockdown'] },
    { id: 'computer', label: 'This computer', sections: ['settings', 'live', 'permissions', 'service'] },
  ];
  const DEFAULT_GROUP = 'overview';
  const GROUP_IDS = GROUPS.map((g) => g.id);
  const SECTION_GROUP = Object.fromEntries(GROUPS.flatMap((g) => g.sections.map((s) => [s, g.id])));

  // '#devices' opens the group; '#settings' opens the group that holds that section and names the section to scroll to.
  function resolveHash(hash, fallback = DEFAULT_GROUP) {
    const key = String(hash ?? '').replace(/^#/, '');
    if (GROUP_IDS.includes(key)) return { group: key, section: null };
    if (SECTION_GROUP[key]) return { group: SECTION_GROUP[key], section: key };
    return { group: GROUP_IDS.includes(fallback) ? fallback : DEFAULT_GROUP, section: null };
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // The things the person should look at, most urgent first. level: 'danger' (red) or 'warn' (amber). count is what the
  // group badge adds up. `to` is a section id, so the button lands on the right group and scrolls there.
  function attentionItems(state, perms = [], { isMac = true } = {}) {
    if (!state) return [];
    const items = [];
    const failed = state.overview?.failedLogins;
    const pending = state.overview?.pending ?? 0;
    const tunnel = state.network?.tunnel;
    const kind = state.network?.internet?.kind;
    if (failed?.guessing) items.push({ id: 'guessing', level: 'danger', group: 'security', to: 'guessing', count: 1, text: `Someone may be guessing your password: ${plural(failed.count, 'failed login')} in the last hour.`, action: 'Review' });
    if (pending > 0) items.push({ id: 'pending', level: 'warn', group: 'devices', to: 'pending', count: pending, text: `${plural(pending, 'device is', 'devices are')} waiting for your approval.`, action: 'Review' });
    if (failed?.count > 0 && !failed.guessing) items.push({ id: 'failed', level: 'warn', group: 'security', to: 'log', count: 1, text: `${plural(failed.count, 'failed login')} in the last hour.`, action: 'See the log' });
    if (kind && kind !== 'off' && tunnel?.status === 'error') items.push({ id: 'tunnel', level: 'danger', group: 'internet', to: 'internet', count: 1, text: `The internet link failed${tunnel.error ? `: ${tunnel.error}` : '.'}`, action: 'Fix' });
    else if (kind === 'domain' && tunnel?.status === 'off' && state.access?.connected) items.push({ id: 'tunnel', level: 'warn', group: 'internet', to: 'internet', count: 1, text: 'Your own domain is set up but not connected.', action: 'Connect' });
    const missing = perms.filter((p) => p.group === 'mac' && (p.state === 'missing' || p.state === 'waiting'));
    if (missing.length) items.push({ id: 'permissions', level: 'warn', group: 'computer', to: 'permissions', count: missing.length, text: `${plural(missing.length, 'permission needs', 'permissions need')} to be allowed: ${missing.map((p) => p.title).join(', ')}.`, action: 'Open' });
    if (state.service && state.service.installed === false) items.push({ id: 'service', level: 'warn', group: 'computer', to: 'service', count: 1, text: `Pocket Dev is not installed as a service, so it stops when ${isMac ? 'the Mac restarts' : 'this computer restarts'}.`, action: 'Open' });
    return items;
  }

  // { devices: { count: 2, level: 'warn' } } for the groups that have something to show.
  function groupBadges(items) {
    const badges = {};
    for (const item of items) {
      const b = badges[item.group] ??= { count: 0, level: 'warn' };
      b.count += item.count;
      if (item.level === 'danger') b.level = 'danger';
    }
    return badges;
  }

  const isMacHost = (platform = '') => /^Mac/i.test(platform);

  // Pages say "this Mac" because they started on a Mac. On any other system the same words say "this computer".
  function say(text, isMac = true) {
    const s = String(text);
    return isMac ? s : s.replace(/\bMacs?\b/g, 'computer').replace(/\blaunchd service\b/g, 'background service');
  }

  const api = { GROUPS, DEFAULT_GROUP, SECTION_GROUP, resolveHash, attentionItems, groupBadges, isMacHost, say };
  globalThis.AdminNav = api;
})();
