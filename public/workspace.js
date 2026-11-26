import { createEditor } from '/vendor/workspace-editor.js';
import { Scheduler, WorkspaceCache, WorkspaceContext, sensitivePath, within } from '/workspace-core.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const button = (text, run, cls = '') => {
  const node = el('button', cls, text); node.type = 'button'; node.onclick = run; return node;
};
const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const basename = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const state = { root: '', tabs: [], active: null, dirs: new Map(), expanded: new Set(), treeRun: 0, openRun: 0, currentTool: 'terminal', sessions: stored('pd.workspace.sessions', {}) };
const context = new WorkspaceContext(), scheduler = new Scheduler(4);
window.PocketWorkspace = { context };
let cache, ownerNamespace, persistTimer, watchController, watchTimer, retryTimer, retryDelay = 1000, switching = 0, applyingRemote = false, treeRows = [], treeNodes = new Map(), selectedEntry, restoring = false;
state.layout = { explorer: true, ai: true, terminal: true }; state.chat = null;
let editor, picker, newKind = 'file', frameReady, readyResolve, filterTimer, searchRun = 0, leaving = false;
frameReady = new Promise((resolve) => { readyResolve = resolve; });
function error(message) { $('workspaceError').firstElementChild.textContent = message; $('workspaceError').hidden = !message; }
function status(message) { $('workspaceStatus').textContent = message; }
async function api(method, url, body, extra = {}, signal) {
  const raw = typeof body === 'string';
  const response = await fetch(url, { method, signal, cache: 'no-store', headers: { 'x-pocket-dev': '1', ...(body !== undefined && { 'content-type': raw ? 'text/plain; charset=utf-8' : 'application/json' }), ...extra }, ...(body !== undefined && { body: raw ? body : JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if ([401, 403].includes(response.status) && url.includes('/api/files/workspace')) await revokeWorkspace();
  if (response.status === 401) { await cache?.clear(); location.href = '/login.html'; throw new Error('Please log in again.'); }
  if (response.status === 202) throw new Error(data.message || 'This action is waiting for approval on the computer. After approval, try again.');
  if (!response.ok) { const failure = new Error(data.error || `HTTP ${response.status}`); failure.status = response.status; throw failure; }
  return data;
}
const fileUrl = (path) => '/api/files/download?' + new URLSearchParams({ path, inline: '1' });
const current = () => state.tabs.find((file) => file.path === state.active);
const startingTools = new Set();
const dirty = (file) => !file.media && file.content !== file.saved;
function snapshot() {
  const active = current(); if (active && !active.media && editor) active.view = editor.snapshot();
  const candidate = $('chatFrame').contentWindow?.pocketDevChat?.snapshot?.();
  const chatSnapshot = candidate?.root === state.root ? candidate : state.chatSnapshot;
  return { root: state.root, active: state.active, tabs: state.tabs.slice(-20).map(({ state: _state, saving: _saving, ...file }) => file), dirs: [...state.dirs].slice(0, 96), expanded: [...state.expanded], scroll: $('fileTree').scrollTop, sessions: state.sessions, chat: state.chat, chatSnapshot, activeTerminal: state.activeTerminal, provider: $('aiProvider').value, layout: state.layout, dimensions: { explorer: document.documentElement.style.getPropertyValue('--explorer-width'), ai: document.documentElement.style.getPropertyValue('--ai-width'), terminal: document.documentElement.style.getPropertyValue('--tools-height') } };
}
function persist() {
  if (!state.root || restoring) return;
  remember('pd.workspace', { root: state.root, paths: state.tabs.map((f) => f.path).slice(-20), active: state.active });
  clearTimeout(persistTimer); persistTimer = setTimeout(flushSnapshot, 250);
}
async function flushSnapshot() { clearTimeout(persistTimer); if (cache && state.root && !restoring) await cache.put(state.root, snapshot()); }
const read = (url, priority = 0) => scheduler.read(`${context.generation}:${url}`, (signal) => api('GET', url, undefined, {}, signal), priority);
function mobile(panel) {
  if (panel === 'ai') ensureChat();
  if (panel === 'editor') { document.body.classList.remove('ws-max-tools'); $('maximizeTools').setAttribute('aria-label', 'Expand terminal panel'); }
  $('workspace').dataset.mobile = panel;
  document.querySelectorAll('[data-mobile]').forEach((node) => { if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', String(node.dataset.mobile === panel)); });
  requestAnimationFrame(() => { editor?.resize(); renderVisibleTree(); }); persist();
  $('chatFrame').contentWindow?.pocketDevChat?.setVisible?.(matchMedia('(max-width:760px)').matches ? panel === 'ai' : state.layout.ai);
}
function relative(path) { return state.root && path.startsWith(state.root) ? path.slice(state.root.length).replace(/^[\\/]/, '') || basename(state.root) : path; }
function renderTabs() {
  $('editorTabs').replaceChildren(...state.tabs.map((file) => {
    const tab = el('div', 'ws-tab'); tab.draggable = true; tab.dataset.path = file.path;
    tab.ondragstart = (event) => event.dataTransfer.setData('text/plain', file.path);
    tab.ondragover = (event) => event.preventDefault();
    tab.ondrop = (event) => { event.preventDefault(); const from = state.tabs.findIndex((f) => f.path === event.dataTransfer.getData('text/plain')), to = state.tabs.indexOf(file); if (from >= 0) { state.tabs.splice(to, 0, ...state.tabs.splice(from, 1)); renderTabs(); persist(); } };
    tab.onkeydown = (event) => { if (event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const at = state.tabs.indexOf(file), to = Math.max(0, Math.min(state.tabs.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1))); state.tabs.splice(to, 0, ...state.tabs.splice(at, 1)); renderTabs(); persist(); } };
 tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.active === file.path)); tab.title = file.path;
    const open = button((dirty(file) ? '● ' : '') + file.name, () => activate(file.path), 'ws-tab-main'); open.setAttribute('aria-label', `Open ${file.name}${dirty(file) ? ', unsaved changes' : ''}`);
    const close = button('×', () => closeFile(file), 'ws-tab-close'); close.setAttribute('aria-label', `Close ${file.name}`);
    tab.append(open, close); return tab;
  }));
  const file = current();
  $('saveFile').disabled = !file || file.media || !dirty(file) || file.saving;
  $('saveFile').textContent = file?.saving ? 'Saving…' : 'Save';
  $('reloadFile').disabled = !file || file.media || file.saving;
  document.title = `${file?.name ? file.name + ' · ' : ''}${basename(state.root) || 'Workspace'} · Pocket Dev`;
}
function renderTree() {
  if (!state.root || $('fileFilter').value.trim()) return;
  treeRows = [];
  function walk(path, depth) {
    const data = state.dirs.get(path); if (!data) return;
    for (const entry of data.entries) {
      treeRows.push({ ...entry, depth });
      if (state.expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  }
  walk(state.root, 0); renderVisibleTree();
}
function renderVisibleTree() {
  if (!state.root || $('fileFilter').value.trim()) return;
  const container = $('fileTree'), rowHeight = matchMedia('(max-width: 760px)').matches ? 44 : 30;
  const first = Math.max(0, Math.floor(container.scrollTop / rowHeight) - 8), end = Math.min(treeRows.length, first + Math.max(30, Math.ceil(container.clientHeight / rowHeight) + 16));
  const nodes = [], before = el('div'), after = el('div'); before.style.height = `${first * rowHeight}px`; after.style.height = `${(treeRows.length - end) * rowHeight}px`; nodes.push(before);
  for (const entry of treeRows.slice(first, end)) {
    const directory = entry.type === 'dir' || entry.linkType === 'dir';
    let line = treeNodes.get(entry.path);
    if (!line) {
      line = el('div', 'ws-tree-line'); const row = button('', () => { selectedEntry = line.entry; directory ? toggleFolder(line.entry.path) : openFile(line.entry.path); }, 'ws-tree-row');
      const more = button('⋯', (event) => fileMenu(line.entry, event), 'ws-tree-more'); more.setAttribute('aria-label', `Actions for ${entry.name}`);
      line.append(row, more); line.oncontextmenu = (event) => { event.preventDefault(); fileMenu(line.entry, event); }; treeNodes.set(entry.path, line);
    }
    line.entry = entry; const row = line.firstElementChild;
    row.style.paddingLeft = `${12 + entry.depth * 15}px`; row.dataset.directory = directory; row.title = entry.path;
    row.setAttribute('aria-label', `${directory ? 'Folder' : 'File'} ${entry.name}`); line.setAttribute('role', 'treeitem'); line.setAttribute('aria-level', String(entry.depth + 1));
    if (directory) row.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
    row.setAttribute('aria-current', String(state.active === entry.path));
    const label = `${directory ? state.expanded.has(entry.path) ? '⌄' : '›' : '‹›'} ${entry.name}`;
    if (row.dataset.label !== label) { row.replaceChildren(el('span', 'ws-tree-icon', label.slice(0, label.indexOf(' '))), el('span', '', entry.name)); row.dataset.label = label; }
    nodes.push(line);
  }
  nodes.push(after);
  if (!treeRows.length) nodes.push(el('p', 'ws-hint', 'This folder is empty. Create a file to get started.'));
  const old = [...container.children], same = old.length === nodes.length && nodes.slice(1, -1).every((node, i) => node === old[i + 1]);
  if (same && treeRows.length) { old[0].style.height = before.style.height; old.at(-1).style.height = after.style.height; }
  else container.replaceChildren(...nodes);
  const visible = new Set(treeRows.slice(first, end).map((e) => e.path)); for (const key of treeNodes.keys()) if (!visible.has(key)) treeNodes.delete(key);
}
async function loadDir(path, priority = 1) {
  const valid = context.capture();
  const data = await read('/api/files/list?' + new URLSearchParams({ path, showHidden: $('showHidden').checked ? '1' : '0' }), priority);
  if (!valid()) return null;
  for (const file of state.tabs) {
    if (!file.fileId || entryDirectory(file) !== path || data.entries.some((entry) => entry.path === file.path)) continue;
    const moved = data.entries.find((entry) => entry.type === 'file' && entry.fileId === file.fileId);
    if (moved) { const old = file.path; file.path = moved.path; file.name = moved.name; file.missing = false; if (file.conflict?.missing) file.conflict = null; if (state.active === old) { state.active = file.path; $('fileBreadcrumb').textContent = relative(file.path); } renderTabs(); renderConflict(); restartWatch(); }
  }
  state.dirs.set(path, data); return data;
}
async function toggleFolder(path) {
  if (state.expanded.has(path)) { state.expanded.delete(path); renderTree(); persist(); restartWatch(); return; }
  state.expanded.add(path); renderTree();
  try { await loadDir(path, 0); renderTree(); persist(); restartWatch(); } catch (failure) { state.expanded.delete(path); error(failure.message); renderTree(); }
}
async function refreshFiles() {
  if (!state.root) return chooseFolder();
  const run = ++state.treeRun;
  try {
    await Promise.all([state.root, ...state.expanded].map((path) => loadDir(path).catch((failure) => { if (path === state.root) throw failure; state.expanded.delete(path); })));
    if (run === state.treeRun) { renderTree(); if ($('fileFilter').value.trim()) searchFiles(); }
  } catch (failure) { error(failure.message); }
}
async function selectFolder(path, { startup = false } = {}) {
  const run = ++switching;
  await flushSnapshot(); scheduler.cancelReads(); watchController?.abort(); clearTimeout(watchTimer); clearTimeout(retryTimer); clearTimeout(state.prefetchTimer);
  try {
    const login = await api('GET', '/api/local/workspace');
    let access, offline = false;
    try { access = await api('GET', '/api/files/workspace?' + new URLSearchParams({ path })); }
    catch (failure) {
      const previous = stored('pd.workspace.authorized', {})[path];
      if ((!failure.status || [404,502].includes(failure.status)) && previous?.loginOwner === login.owner && Date.now() - previous.at < 7 * 86400000) { access = previous; offline = true; }
      else throw failure;
    }
    if (run !== switching) return;
    const namespace = JSON.stringify([location.origin, login.owner, access.owner, access.deviceId]);
    if (!offline) remember('pd.workspace.authorized', Object.fromEntries([[access.root, { ...access, loginOwner: login.owner, at: Date.now() }], ...Object.entries(stored('pd.workspace.authorized', {})).filter(([root]) => root !== access.root)].slice(0, 12)));
    if (!cache || namespace !== ownerNamespace) { cache = new WorkspaceCache(namespace); ownerNamespace = namespace; }
    context.set({ deviceId: access.deviceId, rootPath: access.root, permissions: access.permissions, activeFileId: null, openFileIds: [], activeChatId: null, terminalSessionIds: [] });
    restoring = true;
    const saved = await cache.get(access.root); if (run !== switching) return;
    state.prefetch = new Map(); state.root = access.root; state.tabs = saved?.tabs || []; state.active = null;
    state.dirs = new Map(saved?.dirs || []); state.expanded = new Set(saved?.expanded || []); state.sessions = saved?.sessions || {}; state.chat = saved?.chat || null; state.chatSnapshot = saved?.chatSnapshot || null; state.activeTerminal = saved?.activeTerminal || null; context.update({ activeChatId: state.chat, activeTerminalId: state.activeTerminal, terminalSessionIds: Object.values(state.sessions) });
    state.layout = { explorer: true, ai: true, terminal: true, ...saved?.layout };
    state.tabs.forEach((f) => { f.saving = false; }); selectedEntry = null; treeNodes.clear(); searchRun++;
    $('fileFilter').value = ''; $('projectName').textContent = basename(state.root); $('workspaceDevice').textContent = window.PocketMachine?.say('This Mac') || 'This device'; $('projectPath').textContent = state.root; $('projectPath').title = state.root;
    for (const [key, value] of Object.entries(saved?.dimensions || {})) if (/^\d+(\.\d+)?px$/.test(value)) document.documentElement.style.setProperty(key === 'explorer' ? '--explorer-width' : key === 'ai' ? '--ai-width' : '--tools-height', value);
    applyLayout(); activate(saved?.active || null, { focus: false }); $('fileTree').scrollTop = saved?.scroll || 0;
    restoring = false; persist(); addRecentWorkspace(); connection(!offline); restartWatch();
    // Render the saved environment first. Validate only root/expanded directories and open editor tabs.
    if (!offline) { refreshFiles(); for (const file of state.tabs) if (!file.media) validateFile(file, file.path === state.active ? 0 : 2); }
    updateFrames(); if (state.layout.terminal) showTool('terminal', { focus: false });
    if (state.layout.ai) ensureChat(); if (!startup && matchMedia('(max-width: 760px)').matches) mobile('files');
    read('/api/git/status?' + new URLSearchParams({ repo: state.root }), 2).then((data) => { if (run === switching) $('gitBranch').textContent = data.branch || ''; }).catch(() => {});
  } catch (failure) { restoring = false; if (failure.name !== 'AbortError') error(failure.message); throw failure; }
}
function chooseFolder(event) {
  $('folderPicker').hidden = false;
  picker.open(state.root || '', event?.currentTarget || document.activeElement);
}
async function searchFiles() {
  const run = ++searchRun, query = $('fileFilter').value.trim(), root = state.root;
  if (!query || !root) return renderTree();
  try {
    const data = await read('/api/files/search?' + new URLSearchParams({ path: root, q: query, showHidden: $('showHidden').checked ? '1' : '0' }));
    if (run !== searchRun || root !== state.root) return;
    const rows = data.results.filter((file) => file.type !== 'dir' && file.linkType !== 'dir').map((file) => {
      const row = button(relative(file.path), () => openFile(file.path), 'ws-tree-row'); row.title = file.path; return row;
    });
    $('fileTree').replaceChildren(...rows, ...(!rows.length ? [el('p', 'ws-hint', 'No matching files.')] : []), ...(data.partial ? [el('p', 'ws-hint', 'Search is limited to four folder levels.')] : []));
  } catch (failure) { if (run === searchRun) error(failure.message); }
}
function renderMedia(file) {
  const preview = $('mediaPreview'); preview.replaceChildren();
  const url = fileUrl(file.path);
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file.path)) {
    const img = el('img'); img.src = url; img.alt = file.name; preview.append(img);
  } else if (/\.pdf$/i.test(file.path)) {
    const frame = el('iframe'); frame.src = url; frame.title = file.name; preview.append(frame);
  } else {
    const box = el('div', 'ws-empty'); box.append(el('p', '', file.reason || 'Open this file with an app on your device.'));
    const link = el('a', 'ws-primary', 'Download file'); link.href = '/api/files/download?' + new URLSearchParams({ path: file.path }); link.download = file.name; box.append(link); preview.append(box);
  }
}
function activate(path, { focus = true } = {}) {
  const previous = current(); if (previous && !previous.media) { previous.state = editor.state(); previous.view = editor.snapshot(); }
  state.active = path;
  const file = current();
  $('editorEmpty').hidden = !!file; $('editorMount').hidden = !file || file.media; $('mediaPreview').hidden = !file?.media;
  $('fileBreadcrumb').hidden = !file;
  $('fileBreadcrumb').textContent = file ? relative(file.path).split(/[\\/]/).join('  ›  ') : '';
  if (file?.media) renderMedia(file);
  else if (file) { editor.open(file); if (focus) editor.focus(); }
  $('fileLanguage').textContent = file?.media ? 'Preview' : file ? (file.name.split('.').at(-1).toUpperCase() + ' · UTF-8') : 'UTF-8';
  renderTabs(); renderTree(); renderConflict(); context.update({ activeFileId: state.active, openFileIds: state.tabs.map((f) => f.path) }); persist();
  if (file && focus) mobile('editor');
}
async function openFile(path, { focus = true } = {}) {
  const run = ++state.openRun, valid = context.capture();
  if (state.tabs.some((file) => file.path === path)) { if (focus) activate(path); return; }
  status(`Opening ${basename(path)}…`);
  try {
    let data;
    try { data = state.prefetch?.get(path) || await read('/api/files/text?' + new URLSearchParams({ path })); }
    catch (failure) { if (![413, 415].includes(failure.status)) throw failure; data = { path, name: basename(path), media: true, reason: failure.message }; }
    if (!valid()) return;
    if (!state.tabs.some((file) => file.path === data.path)) state.tabs.push({ ...data, saved: data.content });
    if (focus && run === state.openRun) activate(data.path);
    else renderTabs();
    persist(); restartWatch(); status('Ready');
  } catch (failure) { error(failure.message); status('Could not open file'); }
}
async function saveFile(file) {
  if (!file?.path) file = current();
  if (!file || !state.tabs.includes(file) || file.media || file.saving || !dirty(file)) return;
  const content = file.content, valid = context.capture();
  file.saving = true; renderTabs(); status(`Saving ${file.name}…`);
  try {
    const saved = await api('PUT', '/api/files/text?' + new URLSearchParams({ path: file.path }), content, { 'if-match': file.revision });
    if (!valid()) return;
    file.revision = saved.revision; file.saved = content; file.conflict = null; file.queued = null; renderConflict(); persist();
    // "Saved" also marks a recovery checkpoint, so an immediate browser reload restores this file and tab.
    await flushSnapshot(); if (!valid()) return;
    status(`Saved ${file.name}`); error('');
  } catch (failure) { if (failure.status === 409) await validateFile(file, 0); else if (!failure.status) { file.queued = { content, revision: file.revision }; connection(false); persist(); } error(failure.message); status(failure.status === 409 ? 'Save conflict · edits preserved' : 'Save failed · edits preserved'); }
  finally { file.saving = false; if (valid()) { renderTabs(); persist(); } }
}
async function reloadFile() {
  const file = current(); if (!file || file.media || file.saving) return;
  if (dirty(file) && !confirm(`Discard unsaved edits to ${file.name} and load the version on the computer?`)) return;
  try {
    const data = await read('/api/files/text?' + new URLSearchParams({ path: file.path }));
    Object.assign(file, data, { saved: data.content, state: null, conflict: null, queued: null });
    // Do not cache the old editor state over the newly loaded file.
    state.active = null; activate(file.path); error(''); status(`Reloaded ${file.name}`);
  } catch (failure) { error(failure.message); }
}
function closeFile(file) {
  if (file.saving) return;
  if (dirty(file) && !confirm(`Close ${file.name} and discard unsaved edits?`)) return;
  const index = state.tabs.indexOf(file), active = state.active === file.path;
  state.tabs.splice(index, 1);
  if (active) { state.active = null; activate(state.tabs[Math.max(0, index - 1)]?.path || null); }
  else { renderTabs(); persist(); }
}
async function createEntry(event) {
  event.preventDefault();
  if (!state.root) return chooseFolder();
  const form = $('newEntryForm'), name = $('newEntryName').value;
  const valid = context.capture();
  try {
    const data = await api('POST', '/api/files/' + (newKind === 'file' ? 'file' : 'mkdir'), { dir: selectedEntry ? entryDirectory(selectedEntry) : state.root, name });
    if (!valid()) return;
    form.hidden = true; $('newEntryName').value = ''; await refreshFiles();
    if (newKind === 'file') await openFile(data.path);
    status(`Created ${name}`);
  } catch (failure) { error(failure.message); }
}
async function uploadFiles(files) {
  if (!state.root) return chooseFolder();
  const root = selectedEntry ? entryDirectory(selectedEntry) : state.root;
  try {
    for (const file of files) {
      status(`Uploading ${file.name}…`);
      const response = await fetch('/api/files/upload?' + new URLSearchParams({ dir: root, name: file.name }), { method: 'POST', headers: { 'x-pocket-dev': '1' }, body: file });
      if (!response.ok) throw new Error((await response.json()).error || 'Upload failed');
    }
    await refreshFiles(); status(`Uploaded ${files.length} ${files.length === 1 ? 'file' : 'files'}`);
  } catch (failure) { error(failure.message); }
}
function markTool(tool) {
  state.currentTool = tool;
  document.querySelectorAll('[data-tool]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.tool === tool)));
}
async function showTool(tool, { fresh = false, focus = true } = {}) {
  if (tool === 'chats') { mobile('ai'); return ensureChat(); }
  if (focus) { state.layout.terminal = true; applyLayout(); mobile('tools'); }
  const project = state.root, requestKey = `${project}:${tool}:${fresh}`;
  if (startingTools.has(requestKey)) return;
  startingTools.add(requestKey);
  try {
    if (tool !== 'chats' && !state.root) { chooseFolder(); status('Choose a project folder before starting a terminal.'); return; }
    const client = await Promise.race([terminalReady(), new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal panel is still loading. Try again shortly.')), 15000))]);
    if (project !== state.root) return;
    if (tool === 'chats') { client.pocketDevChat.open(); markTool(tool); return; }
    client.pocketDev.overlays.closeAll();
    const sessions = await api('GET', '/api/sessions');
    const key = `${state.root}:${tool}`;
    let session = !fresh && sessions.find((entry) => entry.id === (tool === 'terminal' ? state.activeTerminal || state.sessions[key] : state.sessions[key]) && entry.exitCode == null);
    if (!session && !fresh && tool === 'terminal') session = sessions.find((entry) => entry.cwd === state.root && entry.exitCode == null);
    if (!session) session = await api('POST', '/api/sessions', { cwd: state.root, ...(tool !== 'terminal' && { command: tool }) });
    state.sessions[key] = session.id; persist(); context.update({ terminalSessionIds: Object.values(state.sessions) });
    client.pocketDev.openSession(session); markTool(tool);
    status(`${tool === 'terminal' ? 'Terminal' : tool === 'codex' ? 'Codex' : 'Claude'} · ${basename(state.root)}`);
  } catch (failure) { error(failure.message); }
  finally { startingTools.delete(requestKey); }
}
function resize(handle, direction) {
  const adjust = (value) => {
    if (direction === 'a') document.documentElement.style.setProperty('--ai-width', `${Math.max(240, Math.min(innerWidth * .5, innerWidth - value))}px`);
    else if (direction === 'x') document.documentElement.style.setProperty('--explorer-width', `${Math.max(170, Math.min(innerWidth * .45, value))}px`);
    else document.documentElement.style.setProperty('--tools-height', `${Math.max(160, Math.min($('workspace').clientHeight - 120, value))}px`);
    persist(); remember('pd.workspace.layout', { explorer: document.documentElement.style.getPropertyValue('--explorer-width'), tools: document.documentElement.style.getPropertyValue('--tools-height') });
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId); document.body.classList.add('ws-dragging');
    const move = (e) => adjust(direction !== 'y' ? e.clientX : $('workspace').getBoundingClientRect().bottom - e.clientY);
    const finish = () => { document.body.classList.remove('ws-dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  };
  handle.ondblclick = () => { document.documentElement.style.removeProperty(direction === 'a' ? '--ai-width' : direction === 'x' ? '--explorer-width' : '--tools-height'); persist(); };
  handle.onkeydown = (event) => {
    const value = direction === 'a' ? innerWidth - document.querySelector('.ws-ai').getBoundingClientRect().width : direction === 'x' ? document.querySelector('.ws-explorer').getBoundingClientRect().width : document.querySelector('.ws-tools').getBoundingClientRect().height;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); adjust(value + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 20 : -20));
  };
}

$('workspaceError').lastElementChild.onclick = () => error('');
$('openFolder').onclick = $('emptyOpenFolder').onclick = chooseFolder;
$('saveFile').onclick = saveFile; $('reloadFile').onclick = reloadFile;
$('refreshFiles').onclick = refreshFiles; $('showHidden').onchange = refreshFiles;
$('fileFilter').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(searchFiles, 180); };
$('newEntryForm').onsubmit = createEntry; $('cancelNewEntry').onclick = () => { $('newEntryForm').hidden = true; };
for (const [id, kind] of [['newFile', 'file'], ['newFolder', 'folder']]) $(id).onclick = () => {
  if (!state.root) return chooseFolder();
  selectedEntry ||= { path: state.root, type: 'dir' }; newKind = kind; mobile('files'); $('newEntryLabel').textContent = `New ${kind} name`; $('newEntryForm').hidden = false; $('newEntryName').focus();
};
$('uploadFiles').onclick = () => state.root ? $('uploadPicker').click() : chooseFolder();
$('uploadPicker').onchange = () => { uploadFiles([...$('uploadPicker').files]); $('uploadPicker').value = ''; };
document.querySelectorAll('button[data-mobile]').forEach((node) => { node.onclick = () => mobile(node.dataset.mobile); });
document.querySelectorAll('[data-tool]').forEach((node) => { node.onclick = () => { $('terminalMenu').hidePopover(); showTool(node.dataset.tool); }; });
$('newTerminal').onclick = () => showTool('terminal', { fresh: true });
$('maximizeTools').onclick = () => { const on = document.body.classList.toggle('ws-max-tools'); $('maximizeTools').setAttribute('aria-label', on ? 'Restore editor and terminal' : 'Expand terminal panel'); };
function canLeave() { leaving = !state.tabs.some(dirty) || confirm('Leave the workspace and discard unsaved file edits?'); return leaving; }
$('exitWorkspace').onclick = async () => { await flushSnapshot(); location.href = '/'; };
document.querySelector('.ws-brand').onclick = () => { flushSnapshot(); };
window.addEventListener('pagehide', () => { flushSnapshot(); });
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
  if (event.key.toLowerCase() === 'p') { event.preventDefault(); mobile('files'); $('fileFilter').focus(); $('fileFilter').select(); }
});
new ResizeObserver(() => editor?.resize()).observe($('editorMount'));
resize($('explorerResize'), 'x'); resize($('toolsResize'), 'y'); resize($('aiResize'), 'a');

function connection(online) { $('connectionStatus').textContent = online ? 'Connected' : 'Disconnected · edits kept'; $('connectionStatus').dataset.online = String(online); }
function applyLayout() {
  for (const [key, on] of Object.entries(state.layout)) {
    $('workspace').dataset[key] = on ? 'open' : 'closed';
    document.querySelectorAll(`[data-toggle="${key}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
  }
  requestAnimationFrame(() => { editor?.resize(); renderVisibleTree(); }); persist();
  $('chatFrame').contentWindow?.pocketDevChat?.setVisible?.(matchMedia('(max-width:760px)').matches ? $('workspace').dataset.mobile === 'ai' : state.layout.ai);
}
function setPreset(mode) {
  state.layout = { explorer: mode === 'default', ai: mode === 'default' || mode === 'ai', terminal: mode === 'default' || mode === 'terminal' };
  document.body.classList.toggle('ws-max-tools', mode === 'terminal'); applyLayout(); if (state.layout.ai) ensureChat();
}
function theme() {
  const preference = stored('pd.workspace.theme', 'dark'); $('workspaceTheme').value = preference;
  document.documentElement.dataset.theme = preference === 'system' ? matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' : preference;
  for (const frame of [$('toolsFrame'), $('chatFrame')]) {
    const root = frame.contentDocument?.documentElement; if (!root) continue;
    for (const key of ['bg','panel','panel-2','line','text','muted','accent','danger','selection']) root.style.setProperty(`--${key}`, getComputedStyle(document.documentElement).getPropertyValue(`--${key}`));
    root.style.colorScheme = document.documentElement.dataset.theme; root.dataset.theme = document.documentElement.dataset.theme; frame.contentWindow?.pocketDev?.updateTheme?.();
  }
}
function addRecentWorkspace() {
  const recents = stored('pd.workspace.recents', []), list = [{ root: state.root, name: basename(state.root) }, ...recents.filter((r) => r.root !== state.root)].slice(0, 12);
  remember('pd.workspace.recents', list);
  const placeholder = el('option', '', 'Switch project…'); placeholder.value = '';
  $('workspaceSwitcher').replaceChildren(placeholder, ...list.map((entry) => { const option = el('option', '', entry.name); option.value = entry.root; return option; })); $('workspaceSwitcher').value = '';
}
async function terminalReady() {
  const frame = $('toolsFrame');
  if (frame.contentWindow?.pocketDev && frame.contentWindow?.pocketDevChat) return frame.contentWindow;
  return frameReady;
}
function updateFrames() {
  for (const id of ['toolsFrame', 'chatFrame']) {
    const client = $(id).contentWindow; if (!client?.pocketDev) continue;
    client.pocketDev.setWorkspace?.(context.value);
    if (id === 'chatFrame') client.pocketDevChat?.setWorkspace?.({ ...context.value, activeChatId: state.chat, cachedChat: state.chatSnapshot });
  }
}
async function ensureChat() {
  if (!state.root) return;
  if (!$('chatFrame').getAttribute('src')) $('chatFrame').src = '/?workspacePanel=chat';
  else if ($('chatFrame').contentWindow?.pocketDevChat) updateFrames();
  const root = state.root, deadline = Date.now() + 15000;
  return new Promise((resolve) => { const ready = () => {
    if (state.root !== root || Date.now() > deadline) return resolve(null);
    const client = $('chatFrame').contentWindow; if (client?.pocketDevChat) { updateFrames(); resolve(client); } else setTimeout(ready, 80);
  }; ready(); });
}
async function loadProviders() {
  const valid = context.capture();
  try {
    const options = await read('/api/chat/options', 1); if (!valid()) return;
    const selected = $('aiProvider').value || (await cache?.get(state.root))?.provider;
    $('aiProvider').replaceChildren(...Object.entries(options.tools || {}).map(([id, info]) => { const option = el('option', '', info.sourceName ? `${info.label} · ${info.sourceName}` : info.label || id); option.value = id; return option; }));
    if (selected && options.tools[selected]) $('aiProvider').value = selected;
  } catch (failure) { if (failure.name !== 'AbortError') error(failure.message); }
}
async function newChat() {
  if (!state.root) return chooseFolder();
  state.layout.ai = true; applyLayout(); mobile('ai'); await ensureChat();
  const root = state.root, valid = context.capture(); $('newChat').disabled = true;
  try {
    const options = await read('/api/chat/options'), tool = $('aiProvider').value || options.defaultTool || Object.keys(options.tools)[0];
    if (!tool) throw new Error('Install or connect an AI provider in Pocket Dev settings.');
    const chat = await api('POST', '/api/chat', { tool, cwd: root, settings: options.tools[tool]?.defaults || {} });
    if (!valid()) return;
    state.chat = chat.id; persist();
    const open = () => { const client = $('chatFrame').contentWindow; if (!client?.pocketDevChat) return false; client.pocketDevChat.open(chat.id); return true; };
    if (!open()) $('chatFrame').addEventListener('load', () => { updateFrames(); open(); }, { once: true });
  } catch (failure) { error(failure.message); } finally { $('newChat').disabled = false; }
}
function entryDirectory(entry) { return entry.type === 'dir' || entry.linkType === 'dir' ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, ''); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const field = el('textarea'); field.value = text; document.body.append(field); field.select(); document.execCommand('copy'); field.remove(); }
}
function fileMenu(entry, event) {
  selectedEntry = entry; const menu = $('fileMenu'); menu.replaceChildren();
  const item = (label, run) => menu.append(button(label, async () => { menu.hidePopover(); try { await run(); } catch (failure) { error(failure.message); } }));
  item('Open terminal here', () => showTerminalAt(entryDirectory(entry)));
  item('Add to AI context', async () => { await ensureChat(); mobile('ai'); const client = $('chatFrame').contentWindow; client?.pocketDevChat?.addContext?.(entry.path); });
  item('Copy relative path', () => copyText(relative(entry.path))); item('Copy absolute path', () => copyText(entry.path));
  item('Download', () => { const a = el('a'); a.href = '/api/files/' + (entry.type === 'dir' ? 'zip?' + new URLSearchParams({ path: entry.path }) : 'download?' + new URLSearchParams({ path: entry.path })); a.download = entry.name; a.click(); });
  item('New file here', () => { newKind = 'file'; $('newEntryLabel').textContent = 'New file name'; $('newEntryForm').hidden = false; $('newEntryName').focus(); });
  item('New folder here', () => { newKind = 'folder'; $('newEntryLabel').textContent = 'New folder name'; $('newEntryForm').hidden = false; $('newEntryName').focus(); });
  item('Rename', async () => {
    const name = prompt('New name', entry.name); if (!name || name === entry.name) return;
    const result = await api('POST', '/api/files/rename', { path: entry.path, newName: name });
    for (const file of state.tabs) if (within(file.path, entry.path)) { const old = file.path; file.path = result.path + old.slice(entry.path.length); file.name = basename(file.path); file.state = null; if (state.active === old) state.active = file.path; }
    const expanded = [...state.expanded].map((path) => within(path, entry.path) ? result.path + path.slice(entry.path.length) : path); state.expanded = new Set(expanded);
    for (const path of [...state.dirs.keys()]) if (within(path, entry.path)) state.dirs.delete(path);
    await refreshFiles(); activate(state.active, { focus: false }); restartWatch();
  });
  item('Delete', async () => {
    if (!confirm(`Move ${entry.name} to Trash? Unsaved editor drafts will be kept.`)) return;
    await api('POST', '/api/files/trash', { paths: [entry.path] });
    for (const file of state.tabs) if (within(file.path, entry.path)) { file.missing = true; file.conflict = { missing: true }; }
    await refreshFiles(); renderConflict(); persist();
  });
  menu.showPopover();
  const rect = event.currentTarget?.getBoundingClientRect?.(), x = event.clientX || rect?.left || 20, y = event.clientY || rect?.bottom || 80;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
}
async function showTerminalAt(dir) {
  const valid = context.capture(); state.layout.terminal = true; applyLayout(); mobile('tools');
  const session = await api('POST', '/api/sessions', { cwd: dir }); if (!valid()) return;
  state.sessions[`${state.root}:terminal:${session.id}`] = session.id; (await terminalReady()).pocketDev.openSession(session); persist();
}
function renderConflict() {
  const file = current(); $('fileConflict').hidden = !file?.conflict;
  if (file?.conflict) $('fileConflict').firstElementChild.textContent = file.conflict.missing ? 'This file was removed or renamed on the computer. Your draft is kept.' : 'This file changed on the computer. Your draft is kept.';
  $('acceptRemote').disabled = !!file?.conflict?.missing;
}
async function validateFile(file, priority = 0) {
  if (!context.value || !state.tabs.includes(file) || file.media) return;
  const valid = context.capture(), path = file.path;
  try {
    const remote = await read('/api/files/text?' + new URLSearchParams({ path: file.path }), priority);
    if (!valid() || !state.tabs.includes(file)) return;
    if (file.path !== path) return validateFile(file, priority);
    file.missing = false; file.fileId = remote.fileId;
    // A lost acknowledgement can leave a queued save whose exact content is already on the host.
    if (file.queued && remote.content === file.queued.content) { file.saved = remote.content; file.revision = remote.revision; file.queued = null; file.conflict = null; }
    if (file.revision !== remote.revision) {
      if (dirty(file) || file.queued) file.conflict = remote;
      else {
        Object.assign(file, remote, { saved: remote.content, conflict: null, state: null });
        if (file.path === state.active) { applyingRemote = true; editor.replace(remote.content); applyingRemote = false; }
      }
    }
    if (file.queued && !file.conflict) {
      const queued = file.queued;
      try { const saved = await api('PUT', '/api/files/text?' + new URLSearchParams({ path: file.path }), queued.content, { 'if-match': queued.revision }); if (!valid()) return; file.revision = saved.revision; file.saved = queued.content; file.queued = null; }
      catch (failure) { if (failure.status === 409) file.conflict = remote; else if (failure.status) error(failure.message); }
    }
    file.validatedAt = Date.now(); renderTabs(); renderConflict(); persist();
  } catch (failure) {
    if (!valid() || failure.name === 'AbortError') return;
    if (file.path !== path) return validateFile(file, priority);
    if (failure.status === 404) { file.missing = true; file.conflict = { missing: true }; renderConflict(); persist(); }
    else if (failure.status === 403) { await revokeWorkspace(); }
  }
}
async function revokeWorkspace() {
  watchController?.abort(); scheduler.cancelReads(); clearTimeout(persistTimer); clearTimeout(retryTimer); clearTimeout(watchTimer);
  const deniedCache = cache; cache = null; state.root = ''; context.set({ deviceId: '', rootPath: '', permissions: {} });
  await deniedCache?.clear();
  state.tabs = []; state.dirs.clear(); state.expanded.clear(); state.active = null; state.root = '';
  $('fileTree').replaceChildren(); activate(null, { focus: false }); $('toolsFrame').src = 'about:blank'; $('chatFrame').src = 'about:blank'; context.set({ deviceId: '', rootPath: '', permissions: {} });
  connection(false); error('Workspace access ended. Sign in again or choose an authorized project.');
}
function restartWatch() { clearTimeout(watchTimer); watchTimer = setTimeout(startWatch, 180); }
async function reconcile() {
  if (!state.root || document.hidden) return;
  const valid = context.capture();
  try {
    await api('GET', '/api/files/workspace?' + new URLSearchParams({ path: state.root })); if (!valid()) return;
    connection(true); await refreshFiles();
    await Promise.all(state.tabs.filter((file) => !file.media).map((file) => validateFile(file, file.path === state.active ? 0 : 2)));
  } catch (failure) { if (![401,403].includes(failure.status)) connection(false); }
}
async function startWatch() {
  watchController?.abort(); clearTimeout(retryTimer); if (!state.root) return;
  const valid = context.capture(), controller = watchController = new AbortController();
  const dirs = new Set([state.root, ...state.expanded]); for (const file of state.tabs) dirs.add(entryDirectory(file));
  const params = new URLSearchParams({ path: state.root }); [...dirs].filter((p) => within(p, state.root)).slice(0, 96).forEach((p) => params.append('dir', p));
  try {
    const response = await fetch('/api/files/watch?' + params, { signal: controller.signal, headers: { 'x-pocket-dev': '1' } });
    if ([401,403].includes(response.status)) return revokeWorkspace();
    if (!response.ok || !response.body) throw new Error('Watch unavailable');
    connection(true); retryDelay = 1000;
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', sequence = 0;
    while (valid() && !controller.signal.aborted) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, split); buffer = buffer.slice(split + 2); const line = packet.split('\n').find((line) => line.startsWith('data: ')); if (!line) continue;
        const message = JSON.parse(line.slice(6)); if (!valid()) return;
        if (message.type === 'revoked') return revokeWorkspace();
        if (message.type === 'unavailable') { connection(false); error('This project is no longer available on the computer. Your drafts are kept. Open another folder or restore the project.'); return; }
        if (sequence && message.sequence !== sequence + 1) reconcile(); sequence = message.sequence;
        if (message.type === 'ready' || message.type === 'reset') { if (!document.hidden) reconcile(); }
        if (message.type === 'changes') {
          if (document.hidden) { state.needsReconcile = true; continue; }
          for (const change of message.changes) {
            if (state.dirs.has(change.dir)) loadDir(change.dir).then(() => { renderTree(); persist(); }).catch(() => {});
            for (const file of state.tabs) if (change.paths.includes(file.path) || change.paths.includes(change.dir) || change.paths.some((path) => within(file.path, path))) validateFile(file, file.path === state.active ? 0 : 2);
          }
        }
      }
      if (buffer.length > 1024 * 1024) throw new Error('Watch buffer exceeded');
    }
    if (!controller.signal.aborted) throw new Error('Connection ended');
  } catch (failure) {
    if (controller.signal.aborted || !valid()) return;
    connection(false); retryTimer = setTimeout(async () => { await reconcile(); startWatch(); }, retryDelay); retryDelay = Math.min(30000, retryDelay * 2);
  }
}

$('workspaceTheme').onchange = () => { remember('pd.workspace.theme', $('workspaceTheme').value); theme(); persist(); };
matchMedia('(prefers-color-scheme: light)').addEventListener('change', theme);
$('layoutPreset').onchange = () => setPreset($('layoutPreset').value);
$('workspaceSwitcher').onchange = () => { if ($('workspaceSwitcher').value) selectFolder($('workspaceSwitcher').value).catch(() => {}); };
$('clearWorkspaceCache').onclick = async () => { if (!confirm('Clear saved workspace files and drafts in this browser? Open editor content stays available until you leave.')) return; await cache?.clear(); $('workspaceMenu').hidePopover(); };
$('activitySearch').onclick = () => { state.layout.explorer = true; applyLayout(); mobile('files'); $('fileFilter').focus(); };
$('activityGit').onclick = async () => { state.layout.terminal = true; applyLayout(); mobile('tools'); (await terminalReady()).pocketDev.openGit(state.root); };
$('workspaceDevice').onclick = () => window.PocketMachine?.openSwitcher?.();
$('renameTerminal').onclick = async () => { $('terminalMenu').hidePopover(); (await terminalReady()).pocketDev.renameActive(); };
$('activitySettings').onclick = () => $('workspaceMenu').togglePopover();
document.querySelectorAll('[data-toggle]').forEach((node) => node.onclick = () => {
  const key = node.dataset.toggle; state.layout[key] = !state.layout[key]; applyLayout();
  if (key === 'terminal' && !state.layout.terminal) document.body.classList.remove('ws-max-tools');
  if (key === 'ai' && state.layout.ai) ensureChat();
  if (matchMedia('(max-width:760px)').matches) mobile(key === 'explorer' ? 'files' : key === 'terminal' ? 'tools' : 'ai');
});
$('newChat').onclick = newChat; $('aiProvider').onchange = () => { context.update({ selectedAIProvider: $('aiProvider').value }); persist(); };
$('autoSave').checked = stored('pd.workspace.autoSave', false); $('autoSave').onchange = () => remember('pd.workspace.autoSave', $('autoSave').checked);
$('compareFile').onclick = () => { const file = current(); $('localVersion').value = file.content; $('remoteVersion').value = file.conflict?.content || '(File removed or renamed)'; $('compareDialog').showModal(); };
$('closeCompare').onclick = () => $('compareDialog').close();
$('acceptRemote').onclick = async () => { if (confirm('Replace your unsaved draft with the remote version?')) await reloadFile(); };
$('saveCopy').onclick = async () => {
  const file = current(), name = prompt('Save your local changes in a new file', file.name + '.local'); if (!name) return;
  try { const made = await api('POST', '/api/files/file', { dir: entryDirectory(file), name }); await api('PUT', '/api/files/text?' + new URLSearchParams({ path: made.path }), file.content, { 'if-match': made.revision }); await loadDir(entryDirectory(file)); renderTree(); openFile(made.path); }
  catch (failure) { error(failure.message); }
};
$('fileTree').addEventListener('scroll', () => { renderVisibleTree(); persist(); }, { passive: true });
$('fileTree').addEventListener('pointerover', (event) => {
  const line = event.target.closest('.ws-tree-line'), file = line?.entry;
  if (!file || file.type !== 'file' || sensitivePath(file.path) || /[\\/](node_modules|\.git|dist|build|coverage)[\\/]/.test(file.path) || state.prefetch?.has(file.path) || file.size > 128 * 1024 || !/^(text\/|application\/(json|xml))/.test(file.mime || '') || document.hidden || navigator.connection?.saveData) return;
  const valid = context.capture();
  clearTimeout(state.prefetchTimer); state.prefetchTimer = setTimeout(() => { if (!valid()) return; read('/api/files/text?' + new URLSearchParams({ path: file.path }), 3).then((data) => { if (!valid()) return; state.prefetch ||= new Map(); state.prefetch.set(data.path, data); if (state.prefetch.size > 4) state.prefetch.delete(state.prefetch.keys().next().value); }).catch(() => {}); }, 180);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSnapshot(); else { reconcile(); restartWatch(); } });
window.addEventListener('focus', () => { if (state.needsReconcile) { state.needsReconcile = false; reconcile(); } });
window.addEventListener('pd-workspace-clear', () => { clearTimeout(persistTimer); revokeWorkspace(); });
window.addEventListener('online', () => { reconcile(); restartWatch(); }); window.addEventListener('offline', () => connection(false));
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  if (event.source === $('chatFrame').contentWindow && event.data?.type === 'pd-workspace-chat-update' && event.data.root === state.root) { persist(); return; }
  if (event.source === $('chatFrame').contentWindow && event.data?.type === 'pd-workspace-collapse-chat') { state.layout.ai = false; applyLayout(); mobile('editor'); return; }
  if (event.source === $('toolsFrame').contentWindow && event.data?.type === 'pd-workspace-terminal' && event.data.root === state.root) { state.activeTerminal = event.data.id; persist(); return; }
  if (event.source !== $('chatFrame').contentWindow || event.data?.type !== 'pd-workspace-chat') return;
  if (event.data.root !== state.root) return; state.chat = event.data.id; $('aiProvider').hidden = !!state.chat; context.update({ activeChatId: state.chat }); persist();
});
function viewport() { const v = visualViewport; if (!v) return; document.documentElement.style.setProperty('--ws-viewport-height', `${v.height}px`); document.documentElement.style.setProperty('--ws-viewport-top', `${v.offsetTop}px`); }
visualViewport?.addEventListener('resize', viewport); visualViewport?.addEventListener('scroll', viewport); viewport();
$('toolsFrame').addEventListener('load', () => { if ($('toolsFrame').getAttribute('src') === 'about:blank') return; const poll = () => { const client = $('toolsFrame').contentWindow; if (!client?.pocketDev || !client?.pocketDevChat) return setTimeout(poll, 60); readyResolve(client); updateFrames(); theme(); }; poll(); });
$('chatFrame').addEventListener('load', () => { if (!$('chatFrame').getAttribute('src') || $('chatFrame').getAttribute('src') === 'about:blank') return; const poll = () => { if (!$('chatFrame').contentWindow?.pocketDevChat) return setTimeout(poll, 60); updateFrames(); loadProviders(); theme(); }; poll(); });
try {
  let autoSaveTimer;
  editor = createEditor({ parent: $('editorMount'), onSave: saveFile,
    onChange(content) { const file = current(); if (!file || file.media || applyingRemote) return; file.content = content; renderTabs(); persist(); if ($('autoSave').checked && !file.conflict) { clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(() => saveFile(file), 1000); } },
    onCursor: (line, col) => { $('cursorPosition').textContent = `Ln ${line}, Col ${col}`; persist(); }, onView: persist });
  picker = window.PocketDevFolderPicker.create({ api, onSelect: selectFolder, onClose: () => { $('folderPicker').hidden = true; }, title: 'Open folder', selectLabel: 'Open folder' }); $('folderPicker').append(picker.element);
  theme();
  const saved = stored('pd.workspace', {}); if (saved.root) await selectFolder(saved.root, { startup: true });
  // The initial iframe can finish before its load handler is registered.
  if ($('toolsFrame').contentWindow?.pocketDev) readyResolve($('toolsFrame').contentWindow);
} catch (failure) { error(failure.message); }
