import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATE_DIR } from '../core/paths.js';
import { peerJson } from '../network/peer-client.js';

export const PROVIDERS = ['claude', 'codex', 'antigravity', 'copilot'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const none = () => ({ computerAccess: false, ai: [] });

// Only the target computer owns these grants. Network announcements are display hints, never authority.
export function createConnections({ room, stateDir = STATE_DIR, installed = () => ({}), schemas = async () => ({}), supported = () => ['claude', 'codex'], requestPeer = peerJson }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'connections.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data.version !== 1 || !data.grants || !data.providers) throw new Error('Invalid connection state'); }
  catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot load connection permissions safely: ${err.message}`);
    data = { version: 1, grants: {}, providers: {}, migration: { at: Date.now(), legacyDeviceIds: room.legacyMembers.map((m) => m.deviceId) } };
    // Legacy room access was implicitly granted to all members. Require fresh approval instead of trusting
    // identities that never had a public key. Existing collaborator project copies and history stay on disk.
  }
  const changes = new Set();
  const members = () => room.members();
  const member = (id) => members().find((m) => m.deviceId === id && id !== room.deviceId());
  const persist = () => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
  const connected = (id) => !!member(id) && data.grants[id]?.disconnected !== true;
  const grant = (id) => connected(id) ? data.grants[id] || none() : none();
  const allowed = (id, type) => Boolean(member(id) && supported().includes(type) && installed()[type] && data.providers[type] === true && grant(id).ai.includes(type));
  function announce() {
    room.setLocalAccess(Object.fromEntries(members().filter((m) => m.deviceId !== room.deviceId()).map((m) => [m.deviceId, {
      computerAccess: grant(m.deviceId).computerAccess, ai: PROVIDERS.filter((type) => allowed(m.deviceId, type)),
    }])));
  }
  const changed = () => { persist(); announce(); for (const fn of changes) fn(); };
  room.setAccessResolver(grant, (id) => data.grants[id]?.publicKey);
  room.onPair(({ deviceId, personal }) => {
    const peer = member(deviceId);
    if (peer?.publicKey) data.grants[deviceId] = { ...none(), computerAccess: personal === true, publicKey: peer.publicKey };
    changed();
  });
  room.onChange(() => {
    let removed = false;
    for (const id of Object.keys(data.grants)) if (!member(id)) { delete data.grants[id]; removed = true; }
    if (removed) persist();
    for (const fn of changes) fn();
  });
  room.onDrop(() => { data.grants = {}; changed(); });
  persist();

  async function directory(origin) {
    const types = PROVIDERS.filter((type) => allowed(origin, type));
    const catalog = types.length ? await schemas(types) : {};
    return { deviceId: room.deviceId(), name: members().find((m) => m.deviceId === room.deviceId())?.name || os.hostname(),
      providers: types.map((type) => ({ type, deviceId: room.deviceId(), settings: (catalog[type] || []).filter((setting) => setting.key !== 'browser').map((setting) => type === 'claude' && setting.key === 'mode' ? { ...setting, choices: setting.choices.filter((choice) => choice.value !== 'auto') } : setting) })) };
  }
  async function available() {
    const results = await Promise.allSettled(members().filter((m) => m.deviceId !== room.deviceId() && connected(m.deviceId) && m.status === 'online')
      .map(async (m) => { const result = await requestPeer(room, m.deviceId, '/api/ai/providers'); return result.deviceId === m.deviceId ? { ...result, name: m.name } : { providers: [] }; }));
    return results.filter((r) => r.status === 'fulfilled' && Array.isArray(r.value.providers)).flatMap((r) =>
      r.value.providers.filter((p) => p && PROVIDERS.includes(p.type) && p.deviceId === r.value.deviceId && Array.isArray(p.settings)
        && p.settings.every((s) => s && typeof s.key === 'string' && Array.isArray(s.choices)))
        .map((p) => ({ type: p.type, deviceId: p.deviceId, settings: p.settings, name: r.value.name, online: true })));

  }
  async function summary() {
    const shared = await available();
    return { deviceId: room.deviceId(), migration: data.migration, computers: (members().length ? members() : [{ deviceId: room.deviceId(), name: os.hostname(), status: 'online', addresses: [] }]).map((m) => {
      const self = m.deviceId === room.deviceId(), local = grant(m.deviceId);
      const remote = m.access?.[room.deviceId()];
      return { deviceId: m.deviceId, name: m.name, self, online: m.status === 'online', transport: m.addresses?.some((a) => a.startsWith('https:')) ? 'internet' : 'wifi',
        connectionType: self || local.computerAccess || remote?.computerAccess ? 'personal' : 'external',
        computerAccess: local.computerAccess, disconnected: data.grants[m.deviceId]?.disconnected === true,
        needsApproval: data.migration?.legacyDeviceIds?.includes(m.deviceId) && !local.computerAccess,
        canOpen: self || (connected(m.deviceId) && remote?.computerAccess === true),
        sharing: local.ai, receiving: shared.filter((p) => p.deviceId === m.deviceId).map((p) => p.type) };
    }), providers: Object.fromEntries(PROVIDERS.map((type) => [type, { installed: !!installed()[type], enabled: data.providers[type] === true, supported: supported().includes(type) }])), shared };
  }
  async function handleApi(req, res, url, { readJson, sendJson, owner }) {
    try {
      if (url.pathname === '/api/ai/providers' && req.method === 'GET' && req.roomPeer) return sendJson(res, 200, await directory(req.roomPeer.origin));
      if (!owner || req.roomPeer) return sendJson(res, 403, { error: 'Connection permissions must be approved on this computer.' });
      const [, , , id, action] = url.pathname.split('/');
      if (req.method === 'POST' && id === 'invite') {
        const body = await readJson(req);
        if (!room.view().room) await room.create({}, req);
        return sendJson(res, 200, room.invite(req, body));
      }
      if (req.method === 'POST' && id === 'join') {
        const body = await readJson(req);
        const result = await room.join(body, req);
        const peer = member(result.pairing.deviceId);
        if (peer?.publicKey) data.grants[peer.deviceId] = { ...none(), computerAccess: result.pairing.personal, publicKey: peer.publicKey };
        changed();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && id === 'leave') return sendJson(res, 200, await room.leave());
      if (req.method === 'POST' && id === 'handover') return sendJson(res, 200, await room.handover(await readJson(req)));
      if (req.method === 'GET' && !id) return sendJson(res, 200, await summary());
      if (req.method === 'PATCH' && id === 'providers' && PROVIDERS.includes(action)) {
        const body = await readJson(req);
        if (typeof body.enabled !== 'boolean') fail(400, 'Choose whether sharing is enabled.');
        if (body.enabled && (!installed()[action] || !supported().includes(action))) fail(409, 'Sharing is not supported for this provider on this computer yet.');
        data.providers[action] = body.enabled; changed();
        return sendJson(res, 200, { enabled: body.enabled });
      }
      if (req.method === 'POST' && action === 'reconnect' && member(id)) {
        data.grants[id] = { ...none(), publicKey: data.grants[id]?.publicKey || member(id).publicKey }; changed();
        return sendJson(res, 200, { connected: true });
      }
      if (req.method === 'PATCH' && member(id)) {
        const body = await readJson(req), peer = member(id), prev = grant(id);
        if (body.computerAccess !== undefined && typeof body.computerAccess !== 'boolean') fail(400, 'Invalid computer access.');
        if (body.computerAccess === true && body.confirmOwnership !== true) fail(400, 'Confirm that you own this computer before approving access.');
        if (body.ai !== undefined && (!Array.isArray(body.ai) || body.ai.some((type) => !PROVIDERS.includes(type)))) fail(400, 'Choose installed AI providers.');
        if (!peer.publicKey) fail(409, 'Reconnect this computer to verify its identity before granting access.');
        data.grants[id] = { computerAccess: body.computerAccess ?? prev.computerAccess, ai: [...new Set(body.ai ?? prev.ai)], publicKey: prev.publicKey || peer.publicKey };
        changed();
        return sendJson(res, 200, { ...data.grants[id], publicKey: undefined });
      }
      if (req.method === 'DELETE' && member(id)) {
        data.grants[id] = { ...none(), disconnected: true, publicKey: data.grants[id]?.publicKey || member(id).publicKey }; changed();
        return sendJson(res, 200, { disconnected: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  }
  return { grant, connected, allowed, directory, available, summary, handleApi, announce, onChange: (fn) => changes.add(fn) };
}
