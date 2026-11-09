import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.js';

export const MODES = ['read-only', 'plan', 'ask', 'auto', 'bypass'];
const HOURS = [1, 2, 3, 4];
const APPROVAL_MS = 5 * 60_000;
const GRANT_MS = 10 * 60_000;
const CONFIRM_MS = 60_000;
const HISTORY = 50;
const BIG_BYTES = 50 * 1024 * 1024;
const fail = (status, message, extra) => { throw Object.assign(new Error(message), { status, ...extra }); };
const within = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Routes that change the machine or who can reach it, whatever the folder.
const SYSTEM = /^\/api\/(power|apps|forwards|admin|devices|collaborators|handoff|connection|network|settings|local)(\/|$)/;
const READ_POST = /^\/api\/files\/(places|list|download|zip|search)$/;
const DOWNLOAD_RUN = /\b(curl|wget|scp|rsync|nc|ncat)\b|\|\s*(sudo\s+)?(ba|z)?sh\b|\bchmod\s+(-\w+\s+)?\+?[0-7x]*x|\bsh\s+-c\b|\beval\b|\bnpx\b|\bdocker\s+run\b|\bgit\s+clone\b|(^|[;&|]\s*)\.\/\S+/;
const INSTALL = /\b(brew|apt|apt-get|dnf|yum|pacman|choco|winget|port)\s+(install|upgrade|remove|uninstall)\b|\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\b(pip3?|gem|cargo|go)\s+install\b|\bnpm\s+(i|install)\b|\bsudo\b|\bdefaults\s+write\b|\b(launchctl|systemsetup|networksetup|pmset|scutil|csrutil|spctl)\b/;
const BIG_DELETE = /\brm\s+(-\w*[rf]\w*\s+)+/;

// What a request from a room member means on this device, given the member's mode. A pure function, so tests and the
// server use the same rules.
//   verdict: allow | ask | propose | deny      risks: why it counts as risky (empty when it does not)
export function classify({ method, path: pathname, query = {}, body, mode, folders = [], statSync = fs.statSync, home = os.homedir() }) {
  const m = String(method).toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || READ_POST.test(pathname)) return { verdict: 'allow', risks: [], read: true };
  if (mode === 'bypass') return { verdict: 'allow', risks: [] };
  if (mode === 'read-only') return { verdict: 'deny', risks: [], why: 'This device only lets you look (read-only).' };

  const risks = [];
  const given = [];
  const take = (v) => { if (typeof v === 'string' && path.isAbsolute(v)) given.push(path.resolve(v)); };
  const b = body && typeof body === 'object' ? body : {};
  for (const k of ['path', 'cwd', 'from', 'to', 'dest', 'dir', 'repo']) { take(b[k]); take(query[k]); }
  for (const k of ['paths']) if (Array.isArray(b[k])) b[k].forEach(take);
  if (pathname === '/api/sessions' && m === 'POST' && b.cwd === undefined) given.push(home);
  const roots = folders.map((f) => path.resolve(f));
  const outside = roots.length ? given.filter((p) => !roots.some((r) => within(p, r))) : [];
  if (outside.length) risks.push(`touches ${outside[0]}, outside the granted folders`);

  const deleting = pathname === '/api/files/trash' || (m === 'DELETE' && pathname.startsWith('/api/files'));
  if (deleting) {
    if (outside.length) risks.push('deletes outside the granted folders');
    for (const p of given) {
      try { const st = statSync(p); if (st.isDirectory() || st.size > BIG_BYTES) { risks.push(`deletes a large item (${p})`); break; } } catch { /* gone: nothing to protect */ }
    }
  }
  const command = [b.command, b.text, b.message].filter((v) => typeof v === 'string').join('\n');
  if (command) {
    if (BIG_DELETE.test(command)) risks.push('a command that deletes recursively');
    if (INSTALL.test(command)) risks.push('installs software or changes system settings');
    if (DOWNLOAD_RUN.test(command)) risks.push('downloads or runs a program that may be unknown');
  }
  if (SYSTEM.test(pathname)) risks.push('changes system or access settings');
  if (/^\/api\/git\/clone/.test(pathname)) risks.push('downloads a repository');

  if (mode === 'ask') return { verdict: 'ask', risks, why: risks.join('; ') || 'Every change asks in Ask mode.' };
  if (mode === 'plan') return { verdict: 'propose', risks, why: risks.join('; ') || 'Plan mode: this is a proposal until it is approved.' };
  return risks.length ? { verdict: 'ask', risks, why: risks.join('; ') } : { verdict: 'allow', risks };
}

// Per member-device modes, the approval inbox and the Bypass timer for one device. Persisted in modes.json (0600).
// `who` of a request is the room principal (req.roomPeer); an owner is a logged-in owner of this device (not a peer).
export function createModes({ stateDir = STATE_DIR, room, log = () => {}, now = Date.now, approvalMs = APPROVAL_MS,
  every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); },
  after = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); }, statSync } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'modes.json');
  let data = { roomId: null, assigned: null, modes: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { roomId: saved.roomId ?? null, assigned: saved.assigned ?? null, modes: saved.modes && typeof saved.modes === 'object' ? saved.modes : {} };
  } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot load modes safely: ${err.message}`); }
  const save = () => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const pending = new Map(); // id -> approval (with private hold)
  const recent = [];
  const grants = new Map(); // single-use yes for a proposal: key -> expiresAt
  const confirms = new Map(); // room-wide bypass confirmation tokens

  // The room this device is in, or null. Everything resets when the room changes or this device leaves it.
  const roomView = () => room.view().room;
  const reset = () => {
    data = { roomId: null, assigned: null, modes: {} };
    for (const a of [...pending.values()]) settle(a, 'cancelled', 'system', 'This device left the room.');
    grants.clear(); confirms.clear();
    save();
  };
  room.onDrop(reset);
  function current() {
    const r = roomView();
    if (!r) return null;
    if (data.roomId !== r.id) { data = { roomId: r.id, assigned: null, modes: {} }; save(); }
    return r;
  }
  const memberOf = (id) => roomView()?.members.find((m) => m.deviceId === id);
  const selfMember = () => { const r = roomView(); return r?.members.find((m) => m.deviceId === room.deviceId()); };

  // The mode of a member here. A Bypass whose time ended turns into Auto on the next look (and on the timer).
  function modeOf(id) {
    current();
    const e = data.modes[id];
    if (e?.mode === 'bypass' && e.until !== null && e.until <= now()) {
      data.modes[id] = { mode: 'auto', at: now(), by: 'timer' };
      save();
      log('room-mode-changed', { device: room.deviceId(), member: id, from: 'bypass', to: 'auto', by: 'timer', result: 'bypass expired' });
      return data.modes[id];
    }
    if (e) return e;
    return { mode: selfMember()?.level === 'admin' ? 'auto' : 'ask', default: true };
  }
  const isBypass = (id) => modeOf(id).mode === 'bypass';
  const stopTimer = every(() => { for (const id of Object.keys(data.modes)) if (data.modes[id].mode === 'bypass') modeOf(id); }, 30_000);

  const isAssigned = (req) => Boolean(req.roomPeer && data.assigned && req.roomPeer.origin === data.assigned && memberOf(data.assigned));
  const actor = (req, isOwner) => isOwner ? { role: 'owner', id: room.deviceId(), name: 'owner' } : isAssigned(req) ? { role: 'assigned', id: req.roomPeer.origin, name: req.roomPeer.name } : null;

  // ---- approvals ----
  const view = (a) => ({ id: a.id, kind: a.kind, status: a.status, from: a.from, method: a.method, path: a.path, summary: a.summary, why: a.why, risks: a.risks,
    createdAt: a.createdAt, expiresAt: a.expiresAt, ...(a.answeredBy && { answeredBy: a.answeredBy }), ...(a.answeredAt && { answeredAt: a.answeredAt }) });
  function settle(a, status, by, note) {
    if (a.status !== 'pending') return false;
    Object.assign(a, { status, answeredBy: by, answeredAt: now(), note });
    a.cancelTimer?.();
    pending.delete(a.id);
    recent.unshift(a);
    recent.length = Math.min(recent.length, HISTORY);
    a.settled?.(a);
    log('room-approval', { device: room.deviceId(), approval: a.id, member: a.from.deviceId, name: a.from.name, action: a.summary, kind: a.kind, result: status, by });
    return true;
  }
  function open(kind, principal, req, verdict, summary, key) {
    const a = { id: crypto.randomBytes(6).toString('hex'), kind, status: 'pending', from: { deviceId: principal.origin, name: principal.name },
      method: req.method, path: req.path, summary, why: verdict.why, risks: verdict.risks, createdAt: now(), expiresAt: now() + approvalMs, key };
    a.settled = null;
    pending.set(a.id, a);
    a.cancelTimer = after(() => settle(a, 'expired', 'timer', 'Nobody answered in time.'), approvalMs);
    return a;
  }

  const bodyKey = (principal, r) => crypto.createHash('sha256').update(JSON.stringify([principal.origin, r.method, r.path, r.search ?? '', r.body ?? null])).digest('hex');

  // Decides one peer request. Resolves to null (let it through) or { status, body } (refuse). For Ask this waits for an answer.
  async function gate(req, r) {
    const principal = req.roomPeer;
    const entry = modeOf(principal.origin);
    const verdict = classify({ method: r.method, path: r.path, query: r.query, body: r.body, mode: entry.mode, folders: principal.folders, statSync });
    const summary = `${r.method} ${r.path}${r.body?.path ? ` ${r.body.path}` : r.body?.paths ? ` ${r.body.paths.join(', ')}` : ''}${typeof r.body?.command === 'string' ? ` : ${r.body.command}` : ''}`.slice(0, 300);
    const audit = (result, extra = {}) => log('room-action', { device: room.deviceId(), member: principal.origin, name: principal.name, mode: entry.mode, action: summary, result, ...extra });
    if (verdict.read) return null;
    if (verdict.verdict === 'allow') { audit('allowed', verdict.risks.length ? { risks: verdict.risks } : {}); return null; }
    if (verdict.verdict === 'deny') { audit('denied by mode'); return { status: 403, body: { error: verdict.why, code: 'mode-denied', mode: entry.mode } }; }

    const key = bodyKey(principal, r);
    if (verdict.verdict === 'propose') {
      const g = grants.get(key);
      if (g && g > now()) { grants.delete(key); audit('allowed (approved proposal)'); return null; }
      const dup = [...pending.values()].find((a) => a.key === key);
      const a = dup ?? open('proposal', principal, r, verdict, summary, key);
      if (!dup) a.settled = (done) => { if (done.status === 'allowed') grants.set(key, now() + GRANT_MS); };
      audit('proposed', { approval: a.id });
      return { status: 202, body: { status: 'proposed', approvalId: a.id, message: 'Recorded as a proposal. Once the owner or assigned person says yes, send the same request again.', expiresAt: a.expiresAt } };
    }
    const a = open('request', principal, r, verdict, summary, key);
    audit('waiting for approval', { approval: a.id });
    const done = await new Promise((resolve) => {
      a.settled = resolve;
      r.onAbort?.(() => settle(a, 'cancelled', 'requester', 'The requester gave up.'));
    });
    if (done.status === 'allowed') return null;
    const text = { denied: 'was denied', expired: 'expired: nobody answered in time', cancelled: 'was cancelled' }[done.status] || done.status;
    return { status: done.status === 'expired' ? 408 : 403, body: { error: `This request ${text}.`, code: `approval-${done.status}`, approvalId: a.id } };
  }

  // The terminal socket cannot be inspected per keystroke: Read-only and Plan refuse it, Ask holds one question for opening it.
  async function gateSocket(req, pathname, onAbort) {
    return gate(req, { method: 'WS', path: pathname, query: {}, body: undefined, onAbort }, true);
  }

  function decide(req, isOwner, id, decision) {
    const who = actor(req, isOwner) ?? fail(403, 'Only this device’s owner or the person assigned to it can answer.');
    if (!['allow', 'deny'].includes(decision)) fail(400, 'Decision must be allow or deny.');
    const a = pending.get(id);
    if (!a) {
      const old = recent.find((x) => x.id === id);
      if (old) fail(409, `Already ${old.status}${old.answeredBy ? ` by ${old.answeredBy}` : ''}. The first answer wins.`, { approval: view(old) });
      fail(404, 'No such approval.');
    }
    if (who.role !== 'owner' && who.id === a.from.deviceId) fail(403, 'You cannot answer your own request.');
    settle(a, decision === 'allow' ? 'allowed' : 'denied', who.role === 'owner' ? 'owner' : `assigned:${who.name}`);
    return view(a);
  }
  const listApprovals = () => ({ pending: [...pending.values()].map(view), recent: recent.map(view) });

  // ---- modes ----
  function entryView(id) {
    const e = modeOf(id), m = memberOf(id);
    return { deviceId: id, name: m?.name, mode: e.mode, default: Boolean(e.default), bypassUntil: e.mode === 'bypass' ? (e.until ?? 'always') : null, banner: e.mode === 'bypass' };
  }
  function listModes() {
    const r = current();
    if (!r) return { members: [], assigned: null, banner: false };
    const members = r.members.filter((m) => m.deviceId !== room.deviceId()).map((m) => entryView(m.deviceId));
    return { members, assigned: data.assigned, banner: members.some((x) => x.banner) };
  }
  function bypassUntil(hours) {
    if (hours === 'always') return null;
    if (!HOURS.includes(hours)) fail(400, 'Bypass lasts 1, 2, 3 or 4 hours, or always (bypassHours).');
    return now() + hours * 3_600_000;
  }
  function setMode(req, isOwner, id, body) {
    const who = actor(req, isOwner) ?? fail(403, 'Only this device’s owner or the person assigned to it can change modes.');
    const r = current() ?? fail(409, 'This device is not in a room.');
    const mode = MODES.includes(body.mode) ? body.mode : fail(400, `Mode must be one of ${MODES.join(', ')}.`);
    if (mode === 'bypass' && who.role !== 'owner') fail(403, 'Only the owner of this device can turn Bypass on.');
    const ids = id === 'all' ? r.members.filter((m) => m.deviceId !== room.deviceId()).map((m) => m.deviceId) : [id];
    if (id !== 'all') {
      if (!memberOf(id) || id === room.deviceId()) fail(404, 'No such other device in the room.');
      if (who.role === 'assigned' && id === who.id) fail(403, 'You cannot change your own mode.');
    } else if (who.role === 'assigned') ids.splice(0, ids.length, ...ids.filter((x) => x !== who.id));
    const until = mode === 'bypass' ? bypassUntil(body.bypassHours) : undefined;
    if (mode === 'bypass' && id === 'all') {
      // Two steps: the first call hands out a token, only a second call that quotes it applies.
      if (body.confirm !== true) fail(400, 'Bypass for the whole room needs confirm: true.');
      for (const [t, exp] of confirms) if (exp <= now()) confirms.delete(t);
      const token = body.confirmToken;
      if (typeof token !== 'string' || !confirms.has(token)) {
        const fresh = crypto.randomBytes(12).toString('hex');
        confirms.set(fresh, now() + CONFIRM_MS);
        return { status: 202, body: { confirmationRequired: true, confirmToken: fresh, expiresInSeconds: CONFIRM_MS / 1000, message: 'Send the same request again with confirm: true and this confirmToken to turn Bypass on for everyone.' } };
      }
      confirms.delete(token);
    }
    for (const t of ids) {
      const from = modeOf(t).mode;
      data.modes[t] = { mode, ...(mode === 'bypass' && { until }), at: now(), by: who.role === 'owner' ? 'owner' : `assigned:${who.name}` };
      log('room-mode-changed', { device: room.deviceId(), member: t, from, to: mode, by: data.modes[t].by, result: 'changed', ...(mode === 'bypass' && { until: until ?? 'always' }) });
    }
    save();
    return { status: 200, body: id === 'all' ? listModes() : entryView(id) };
  }
  function setAssigned(isOwner, body) {
    if (!isOwner) fail(403, 'Only the owner of this device can assign a person.');
    current() ?? fail(409, 'This device is not in a room.');
    const id = body.deviceId ?? null;
    if (id !== null && (!memberOf(id) || id === room.deviceId())) fail(404, 'No such other device in the room.');
    data.assigned = id;
    save();
    log('room-mode-changed', { device: room.deviceId(), member: id, by: 'owner', result: id ? 'assigned person set' : 'assigned person cleared' });
    return { assigned: id };
  }

  // GET/PUT/POST under /api/room/{approvals,modes,assigned}. `isOwner`: a logged-in owner of this device, not a room peer.
  async function handleApi(req, res, url, { readJson, sendJson, isOwner }) {
    const [, , , name, id] = url.pathname.split('/');
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const who = actor(req, isOwner);
      if (name === 'approvals') {
        if (!who) fail(403, 'Only this device’s owner or the person assigned to it can see approvals.');
        if (req.method === 'GET' && !id) return sendJson(res, 200, listApprovals());
        if (req.method === 'POST' && id) return sendJson(res, 200, decide(req, isOwner, id, body.decision));
      } else if (name === 'modes') {
        if (req.method === 'GET' && !id) {
          const all = listModes();
          if (who) return sendJson(res, 200, all);
          if (!req.roomPeer) fail(403, 'Not allowed.');
          const mine = all.members.find((m) => m.deviceId === req.roomPeer.origin);
          return sendJson(res, 200, { members: mine ? [mine] : [], banner: Boolean(mine?.banner) });
        }
        if (req.method === 'PUT' && id) { const r = setMode(req, isOwner, id, body); return sendJson(res, r.status ?? 200, r.body ?? r); }
      } else if (name === 'assigned') {
        if (req.method === 'GET') return sendJson(res, 200, { assigned: data.assigned });
        if (req.method === 'PUT') return sendJson(res, 200, setAssigned(isOwner, body));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message, ...(err.approval && { approval: err.approval }) }); }
  }

  return { gate, gateSocket, handleApi, modeOf, isBypass, setMode, close: stopTimer, pending: () => [...pending.values()].map(view) };
}
