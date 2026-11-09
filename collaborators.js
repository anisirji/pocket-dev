import fs from 'node:fs';
import { secureCookie } from './transport.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.js';
import { svgQr } from './qr.js';

const COOKIE = 'pd_collaborator';
const INVITE_MS = 10 * 60_000;
const DURATIONS = new Set([3600, 86400, 604800]);
const within = (p, root) => p === root || p.startsWith(root + path.sep);
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const secretName = (name) => /^\.(git|ssh|aws|codex|claude|gnupg|pocket-dev|docker|kube|azure|config)$/i.test(name)
  || /^\.env(?:\.|$)/i.test(name) || /^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.gitconfig|\.zsh_history|\.bash_history|config\.json\.migrated|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|credentials\.json)$/i.test(name) || /\.(pem|key)$/i.test(name);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const readCookie = (req) => (req.headers.cookie || '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
const cookie = (token, seconds = 604800) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`;

// Guest sessions have a separate cookie and cannot become owner device sessions.
// They are routed through a default-deny policy before any owner/auth handler.
export function createCollaborators({ config, auth, urls, stateDir = STATE_DIR, now = Date.now }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'collaborators.json');
  const workspaceDir = path.join(fs.realpathSync(stateDir), 'collaborator-workspaces');
  const home = fs.realpathSync(os.homedir());
  const invitations = new Map(), transfers = new Map();
  let data = { grants: [], sessions: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved.grants) || !Array.isArray(saved.sessions)) throw new Error('Invalid collaborator state');
    data = saved;
  } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot load collaborator access safely: ${err.message}`); }

  function persist() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  const enabled = () => config.read().roleAccessEnabled === true;
  const active = (grant) => enabled() && grant && !grant.revoked && (grant.room || grant.expiresAt > now());
  const find = (id) => data.grants.find((g) => g.id === id);
  const sessionCount = () => data.sessions.filter((s) => active(find(s.grantId))).length;
  const log = (type, fields) => auth.admin.log(type, fields);
  const status = (g) => g.revoked ? 'revoked' : g.room ? (active(g) ? 'active' : 'inactive') : !g.expiresAt ? 'invited' : active(g) ? 'active' : 'expired';
  const view = (g) => ({ ...g, status: status(g), sessions: data.sessions.filter((s) => s.grantId === g.id).length });
  const ai = { available: false, reason: 'Collaborator AI needs a validated isolated runner. Owner AI sessions are never shared.' };

  function stopTransfers(id) {
    for (const res of transfers.get(id) || []) res.destroy();
    transfers.delete(id);
  }
  function invalidate(id, closeTransfers = true) {
    if (closeTransfers) stopTransfers(id);
    for (const [key, invite] of invitations) if (invite.grantId === id) invitations.delete(key);
  }
  const expiryTimer = setInterval(() => {
    for (const id of transfers.keys()) if (!active(find(id))) stopTransfers(id);
    let changed = false;
    for (const grant of data.grants) if (grant.expiresAt && grant.expiresAt <= now() && !grant.revoked && !grant.expiryLogged) {
      grant.expiryLogged = true; changed = true;
      log('collaborator-expired', { grantId: grant.id });
    }
    if (changed) persist();
  }, 1000).unref();

  const protectedRoots = [STATE_DIR, stateDir, path.join(home, 'Library'), ...['.ssh', '.aws', '.codex', '.claude', '.gnupg'].map((n) => path.join(home, n))].map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
  function blocked(p, workspace = false) {
    const relative = workspace && within(p, workspaceDir) ? path.relative(workspaceDir, p) : p;
    if (relative.split(path.sep).some(secretName)) return true;
    return protectedRoots.some((r) => within(p, r)) && !(workspace && within(p, workspaceDir));
  }
  function ownerRoots() {
    const given = config.read().fileRoots;
    return (Array.isArray(given) && given.length ? given : [os.homedir()]).flatMap((p) => {
      try { const given = path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir())); return [{ given, real: fs.realpathSync(given) }]; } catch { return []; }
    });
  }
  function sourceRoot(given) {
    if (typeof given !== 'string' || !given.trim() || given.includes('\0')) fail(400, 'Choose a folder path.');
    const lexical = path.resolve(given.trim().replace(/^~(?=\/|$)/, os.homedir()));
    if (blocked(lexical)) fail(403, 'Credentials, application state and personal Library folders cannot be shared.');
    let real;
    try { real = fs.realpathSync(lexical); } catch { fail(400, 'That folder is not available.'); }
    if (!fs.statSync(real).isDirectory() || blocked(real)) fail(403, 'That folder cannot be shared.');
    if ([path.parse(real).root, home, path.join(home, 'Downloads')].includes(real)) fail(403, 'Choose a specific project or related folder, not the whole home or Downloads folder.');
    if (!ownerRoots().some((r) => (within(lexical, r.given) || within(lexical, r.real)) && within(real, r.real))) fail(403, 'That folder is outside the owner’s file-sharing policy.');
    return { given: lexical, real };
  }
  function checkSources(grant) {
    for (const source of [grant.repository, ...grant.extraFolders]) {
      const current = sourceRoot(source.given);
      if (current.real !== source.real) fail(403, 'A shared folder moved or changed. Ask the owner to update access.');
    }
  }

  // File-only Developer work uses copies, so guest edits cannot change running
  // host code. Never execute these copies or reuse the owner's AI credentials.
  async function copyWorkspace(source, dest, budget) {
    await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
    for (const item of await fsp.readdir(source, { withFileTypes: true })) {
      if (secretName(item.name) || ['node_modules', '.venv', 'venv', '.DS_Store'].includes(item.name)) continue;
      if (++budget.entries > 20000) fail(413, 'Project copy exceeds 20,000 entries. Choose a smaller project.');
      const from = path.join(source, item.name), to = path.join(dest, item.name);
      const stat = await fsp.lstat(from);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await copyWorkspace(from, to, budget);
      else if (stat.isFile()) {
        budget.bytes += stat.size;
        if (budget.bytes > 256 * 1024 * 1024) fail(413, 'Project copy exceeds 256 MB. Remove generated files before inviting a developer.');
        const real = await fsp.realpath(from);
        if (!within(real, budget.root) || blocked(real)) fail(403, 'Project contains a path outside its shared folder.');
        await fsp.copyFile(real, to, fs.constants.COPYFILE_EXCL);
        await fsp.chmod(to, 0o600);
      }
    }
  }

  async function parseGrant(body, id) {
    if (!body || !['viewer', 'developer'].includes(body.role)) fail(400, 'Choose Viewer or Developer.');
    if (body.ai !== undefined && body.ai !== false) fail(409, ai.reason);
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || /[\r\n\x00]/.test(body.label)) fail(400, 'Enter a collaborator name, up to 80 characters.');
    if (!DURATIONS.has(body.duration)) fail(400, 'Choose access for 1 hour, 1 day, or 7 days.');
    if (!Array.isArray(body.extraFolders || []) || (body.extraFolders || []).length > 5) fail(400, 'Choose up to five related folders.');
    const repository = sourceRoot(body.repository);
    if (!fs.existsSync(path.join(repository.real, '.git'))) fail(400, 'Choose a Git repository.');
    const extraFolders = (body.extraFolders || []).map((folder) => {
      if (!folder || !['read', 'write'].includes(folder.mode)) fail(400, 'Folder access must be read-only or read/write.');
      if (body.role === 'viewer' && folder.mode !== 'read') fail(400, 'Viewers have read-only access.');
      return { ...sourceRoot(folder.path), mode: folder.mode };
    });
    const sources = [repository, ...extraFolders];
    if (sources.some((a, i) => sources.some((b, j) => i !== j && (within(a.real, b.real) || within(b.real, a.real))))) fail(400, 'Shared folders must not overlap.');
    const roots = [];
    let workspace = null;
    try {
      if (body.role === 'developer') {
        workspace = path.join(workspaceDir, `${id}-${crypto.randomBytes(6).toString('hex')}`);
        for (const [i, source] of sources.entries()) {
          const writable = i === 0 || source.mode === 'write';
          const target = path.join(workspace, i === 0 ? 'project' : `folder-${i}`);
          if (writable) await copyWorkspace(source.real, target, { root: source.real, entries: 0, bytes: 0 });
          roots.push({ given: writable ? target : source.given, real: writable ? target : source.real, readOnly: !writable, workspace: writable });
        }
      } else roots.push(...sources.map((s) => ({ given: s.given, real: s.real, readOnly: true, workspace: false })));
    } catch (err) { if (workspace) await fsp.rm(workspace, { recursive: true, force: true }); throw err; }
    return { label: body.label.trim(), role: body.role, ai: false, duration: body.duration, repository, extraFolders, roots, workspace };
  }

  function guest(req) {
    const token = readCookie(req);
    if (token === undefined) return null;
    const session = /^[0-9a-f]{64}$/.test(token) && data.sessions.find((s) => s.tokenHash === hash(token));
    const grant = session && find(session.grantId);
    return { session, grant, active: !!active(grant) };
  }
  function assertGuest(req) {
    const current = guest(req);
    if (!current?.active) fail(403, 'Your collaborator access expired or was revoked.');
    try { checkSources(current.grant); }
    catch { fail(403, 'A shared folder is no longer available under the owner’s sharing policy. Ask the owner to update your access.'); }
    return current;
  }
  function scope(req, res) {
    const { grant } = assertGuest(req);
    if (!transfers.has(grant.id)) transfers.set(grant.id, new Set());
    transfers.get(grant.id).add(res);
    res.once('close', () => transfers.get(grant.id)?.delete(res));
    return {
      roots: grant.roots, role: grant.role,
      blocked: (p) => blocked(p, grant.roots.some((r) => r.workspace && within(p, r.real))),
      assertActive: () => {
        const current = assertGuest(req);
        if (current.grant !== grant) fail(403, 'Your access changed. Reload your project.');
      },
    };
  }
  function currentAccess(req) {
    const { grant } = assertGuest(req);
    return { role: grant.role, label: grant.label, repository: path.basename(grant.repository.real), roots: grant.roots.map((r, i) => ({ path: r.real, name: i === 0 ? path.basename(grant.repository.real) : path.basename(grant.extraFolders[i - 1].real), readOnly: r.readOnly })), ai: false, aiReason: ai.reason, expiresAt: grant.expiresAt };
  }

  async function ownerApi(method, pathname, body = {}, local = false) {
    if (pathname === '/api/collaborators/enable' && method === 'POST') {
      if (!local) fail(403, 'Review trusted Admin devices on the Mac before enabling role-based sharing.');
      const result = auth.admin.enableRoles(body.adminDeviceIds);
      if (result.status !== 200) return result;
      return { status: 200, body: summary() };
    }
    if (pathname === '/api/collaborators' && method === 'GET') return { status: 200, body: summary() };
    if (!enabled()) fail(409, 'Enable role-based sharing from Admin on the Mac first.');
    const match = /^\/api\/collaborators(?:\/([0-9a-f]{16})(?:\/(invite))?)?$/.exec(pathname);
    if (!match) fail(404, 'Not found');
    const grant = match[1] && find(match[1]);
    if (match[1] && !grant) fail(404, 'No such collaborator');
    if (!match[1] && method === 'POST') {
      if (data.grants.filter((g) => !g.revoked).length >= 50) fail(429, 'Revoke an unused collaborator before adding another.');
      const id = crypto.randomBytes(8).toString('hex');
      const parsed = await parseGrant(body, id);
      const next = { id, ...parsed, createdAt: now(), expiresAt: null, revoked: false };
      data.grants.push(next); persist();
      log('collaborator-created', { grantId: id, role: next.role });
      return { status: 201, body: view(next) };
    }
    if (grant && !match[2] && method === 'PATCH') {
      const parsed = await parseGrant(body, grant.id);
      if (find(grant.id) !== grant) {
        if (parsed.workspace) await fsp.rm(parsed.workspace, { recursive: true, force: true });
        fail(409, 'Access changed while the project copy was being prepared. Reload and try again.');
      }
      invalidate(grant.id);
      const revive = grant.revoked || (grant.expiresAt && !active(grant));
      if (revive) data.sessions = data.sessions.filter((s) => s.grantId !== grant.id);
      const next = { ...grant, ...parsed, revoked: false, expiryLogged: false, expiresAt: !revive && grant.expiresAt ? now() + parsed.duration * 1000 : null };
      data.grants[data.grants.indexOf(grant)] = next; persist();
      log('collaborator-updated', { grantId: grant.id, role: next.role });
      return { status: 200, body: view(next) };
    }
    if (grant && !match[2] && method === 'DELETE') {
      data.sessions = data.sessions.filter((s) => s.grantId !== grant.id);
      data.grants[data.grants.indexOf(grant)] = { ...grant, revoked: true };
      invalidate(grant.id); persist();
      log('collaborator-revoked', { grantId: grant.id });
      return { status: 204 };
    }
    if (grant && match[2] && method === 'POST') {
      if (grant.room) fail(409, 'This access comes from room membership. Signing in through another device is not built yet.');
      if (grant.revoked || (grant.expiresAt && !active(grant))) fail(409, 'Update this collaborator’s access before creating another invitation.');
      checkSources(grant);
      const base = urls().remote || urls().lan || urls().local;
      if (!base) fail(409, 'No address to invite with: turn on Wi-Fi access or wait for the internet link.');
      invalidate(grant.id, false);
      for (const [key, value] of invitations) if (value.expiresAt <= now()) invitations.delete(key);
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + INVITE_MS;
      invitations.set(hash(token), { grantId: grant.id, expiresAt });
      const url = `${base}/invite#token=${token}`;
      log('collaborator-invited', { grantId: grant.id });
      return { status: 200, body: { url, svg: await svgQr(url), expiresAt } };
    }
    fail(404, 'Not found');
  }
  // Access that belongs to a room member on this device. It never expires; it ends when the member leaves the room or is
  // removed from it. It sits behind the same role switch as every grant, and it uses the same limits and folder checks.
  // Repeating the call for the same member changes nothing.
  async function roomGrant({ roomId, deviceId, label, role, folders }) {
    const mine = (g) => g.room?.id === roomId && g.room.deviceId === deviceId && !g.roomEnded;
    const existing = data.grants.find(mine);
    if (existing) return view(existing);
    if (data.grants.filter((g) => !g.revoked).length >= 50) fail(429, 'Revoke an unused collaborator before adding another.');
    const id = crypto.randomBytes(8).toString('hex');
    const parsed = await parseGrant({ role, label: String(label).replace(/[\r\n\x00]/g, ' ').trim().slice(0, 80) || 'Room member', duration: 604800, repository: folders[0],
      extraFolders: folders.slice(1).map((path) => ({ path, mode: 'read' })) }, id);
    if (data.grants.find(mine)) { if (parsed.workspace) await fsp.rm(parsed.workspace, { recursive: true, force: true }); return view(data.grants.find(mine)); }
    const next = { id, ...parsed, createdAt: now(), expiresAt: null, revoked: false, room: { id: roomId, deviceId } };
    data.grants.push(next); persist();
    log('collaborator-created', { grantId: id, role: next.role, room: roomId });
    return view(next);
  }
  // Ends every room grant of a room that is not for one of the devices in `keep`. A null room ends them all.
  function revokeRoom(roomId, keep = new Set()) {
    let changed = false;
    data.grants = data.grants.map((grant) => {
      if (!grant.room || grant.roomEnded || (grant.room.id === roomId && keep.has(grant.room.deviceId))) return grant;
      changed = true;
      data.sessions = data.sessions.filter((s) => s.grantId !== grant.id);
      invalidate(grant.id);
      log('collaborator-revoked', { grantId: grant.id, room: grant.room.id });
      return { ...grant, revoked: true, roomEnded: true };
    });
    if (changed) persist();
  }

  function summary() {
    const settings = config.read();
    const candidates = [...(Array.isArray(settings.folders) ? settings.folders : []), ...(Array.isArray(settings.recentFolders) ? settings.recentFolders : []), settings.chatDefaults?.cwd];
    const repositories = [];
    for (const p of candidates) {
      try { const root = sourceRoot(p); if (fs.existsSync(path.join(root.real, '.git')) && !repositories.includes(root.given)) repositories.push(root.given); } catch {}
    }
    return { enabled: enabled(), ai, collaborators: data.grants.map(view), repositories };
  }

  function accept(req, body) {
    if (!enabled()) fail(403, 'Collaborator sharing is not enabled.');
    if (auth.lookup(req) || readCookie(req) !== undefined) fail(409, 'Log out the existing session before accepting this invitation.');
    const token = body?.token;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) fail(400, 'Invalid invitation.');
    const invite = invitations.get(hash(token));
    const grant = invite && find(invite.grantId);
    if (!invite || invite.expiresAt <= now() || !grant || grant.revoked || (grant.expiresAt && !active(grant))) fail(410, 'This invitation expired or was already used. Ask the owner for another.');
    checkSources(grant);
    const max = auth.admin.state().maxDevices;
    if (auth.activeCount() + sessionCount() >= max) fail(409, 'The device limit is full. Ask the owner to make room; Admin devices will not be logged out.');
    const sessionToken = crypto.randomBytes(32).toString('hex');
    grant.expiresAt ||= now() + grant.duration * 1000;
    data.sessions.push({ id: crypto.randomBytes(8).toString('hex'), tokenHash: hash(sessionToken), grantId: grant.id, createdAt: now() });
    invitations.delete(hash(token)); persist();
    log('collaborator-joined', { grantId: grant.id, role: grant.role });
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': secureCookie(req, cookie(sessionToken, Math.ceil((grant.expiresAt - now()) / 1000))) } };
  }
  function logout(req) {
    const current = guest(req);
    if (current?.session) { data.sessions = data.sessions.filter((s) => s !== current.session); stopTransfers(current.session.grantId); persist(); }
    return { status: 204, headers: { 'set-cookie': cookie('', 0) } };
  }
  function lockdown() {
    data.grants = data.grants.map((grant) => { stopTransfers(grant.id); return { ...grant, revoked: true }; });
    invitations.clear(); data.sessions = []; persist();
  }
  return { guest, scope, currentAccess, ownerApi, roomGrant, revokeRoom, accept, logout, sessionCount, lockdown, close: () => clearInterval(expiryTimer) };
}
