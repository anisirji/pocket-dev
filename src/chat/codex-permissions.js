import path from 'node:path';
const invalid = () => new Error('This Codex permission request cannot be displayed safely. Review it in the native client.');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function codexPermissionPlan(request, cwd) {
  if (!object(request) || Object.keys(request).some((key) => !['network', 'fileSystem'].includes(key)) || JSON.stringify(request).length > 16000) throw invalid();
  const permissions = {}, lines = [];
  const filePath = (value) => {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw invalid();
    return path.isAbsolute(value) || path.win32.isAbsolute(value) ? value : path.resolve(cwd, value);
  };
  if (request.network != null) {
    if (!object(request.network) || Object.keys(request.network).some((key) => key !== 'enabled') || (request.network.enabled != null && typeof request.network.enabled !== 'boolean')) throw invalid();
    if (request.network.enabled === true) { permissions.network = { enabled: true }; lines.push('Network access'); }
  }
  if (request.fileSystem != null) {
    const filesystem = request.fileSystem;
    if (!object(filesystem) || Object.keys(filesystem).some((key) => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) throw invalid();
    const parsed = {};
    for (const key of ['read', 'write']) if (filesystem[key] != null) {
      if (!Array.isArray(filesystem[key]) || filesystem[key].length > 32) throw invalid();
      parsed[key] = filesystem[key].map(filePath);
      for (const file of parsed[key]) lines.push(`${key === 'read' ? 'Read' : 'Write'}: ${file}`);
    }
    if (filesystem.entries != null) {
      if (!Array.isArray(filesystem.entries) || filesystem.entries.length > 32) throw invalid();
      parsed.entries = filesystem.entries.map((entry) => {
        if (!object(entry) || Object.keys(entry).some((key) => !['access', 'path'].includes(key)) || !['read', 'write', 'deny'].includes(entry.access) || !object(entry.path)) throw invalid();
        const raw = entry.path; let target, label;
        if (raw.type === 'path' && Object.keys(raw).every((key) => ['type', 'path'].includes(key))) { target = { type: 'path', path: filePath(raw.path) }; label = target.path; }
        else if (raw.type === 'glob_pattern' && Object.keys(raw).every((key) => ['type', 'pattern'].includes(key)) && typeof raw.pattern === 'string' && raw.pattern.length <= 4096 && !/[\u0000-\u001f]/.test(raw.pattern)) { target = { type: 'glob_pattern', pattern: raw.pattern }; label = `Pattern ${raw.pattern}`; }
        else if (raw.type === 'special' && Object.keys(raw).every((key) => ['type', 'value'].includes(key)) && object(raw.value) && ['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp'].includes(raw.value.kind) && Object.keys(raw.value).every((key) => ['kind', 'subpath'].includes(key))) {
          if (raw.value.subpath != null && (raw.value.kind !== 'project_roots' || typeof raw.value.subpath !== 'string' || raw.value.subpath.length > 4096 || /[\u0000-\u001f]/.test(raw.value.subpath) || path.isAbsolute(raw.value.subpath) || path.win32.isAbsolute(raw.value.subpath) || raw.value.subpath.split(/[\\/]/).includes('..'))) throw invalid();
          target = { type: 'special', value: { ...raw.value } }; label = { root: 'Entire filesystem', minimal: 'Minimal system files', project_roots: 'Project roots', tmpdir: 'Temporary folder', slash_tmp: '/tmp' }[raw.value.kind] + (raw.value.subpath ? ` / ${raw.value.subpath}` : '');
        } else throw invalid();
        lines.push(`${entry.access}: ${label}`); return { access: entry.access, path: target };
      });
    }
    if (filesystem.globScanMaxDepth != null) {
      if (!Number.isInteger(filesystem.globScanMaxDepth) || filesystem.globScanMaxDepth < 1 || filesystem.globScanMaxDepth > 100) throw invalid();
      parsed.globScanMaxDepth = filesystem.globScanMaxDepth;
    }
    if (parsed.read?.length || parsed.write?.length || parsed.entries?.length) permissions.fileSystem = parsed;
  }
  return { permissions, detail: lines.join('\n') };
}
export async function requestCodexPermissions(chat, params) {
  const denied = { permissions: {}, scope: 'turn' };
  if (chat.settings.approvalPolicy === 'never') return denied;
  let plan;
  try { plan = codexPermissionPlan(params.permissions, params.cwd || chat.cwd); }
  catch (error) { chat.emit({ type: 'status', text: error.message }); return denied; }
  if (!plan.detail) return denied;
  const answer = await chat.ask({ type: 'permission-request', kind: 'tool', title: params.reason || 'Allow additional access for this turn?', detail: `${plan.detail}\n\nAccess expires after this turn.`, options: [{ id: 'allow', label: 'Allow for this turn' }, { id: 'deny', label: 'Deny' }] });
  return !answer.cancelled && answer.decision === 'allow' ? { permissions: plan.permissions, scope: 'turn' } : denied;
}
