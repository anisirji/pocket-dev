import { createEditor } from '/vendor/workspace-editor.js';

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
let editor, picker, newKind = 'file', frameReady, readyResolve, filterTimer, searchRun = 0, leaving = false;
frameReady = new Promise((resolve) => { readyResolve = resolve; });
function error(message) { $('workspaceError').firstElementChild.textContent = message; $('workspaceError').hidden = !message; }
function status(message) { $('workspaceStatus').textContent = message; }
async function api(method, url, body, extra = {}) {
  const raw = typeof body === 'string';
  const response = await fetch(url, { method, headers: { 'x-pocket-dev': '1', ...(body !== undefined && { 'content-type': raw ? 'text/plain; charset=utf-8' : 'application/json' }), ...extra }, ...(body !== undefined && { body: raw ? body : JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.href = '/login.html'; throw new Error('Please log in again.'); }
  if (response.status === 202) throw new Error(data.message || 'This action is waiting for approval on the computer. After approval, try again.');
  if (!response.ok) { const failure = new Error(data.error || `HTTP ${response.status}`); failure.status = response.status; throw failure; }
  return data;
}
const fileUrl = (path) => '/api/files/download?' + new URLSearchParams({ path, inline: '1' });
const current = () => state.tabs.find((file) => file.path === state.active);
const startingTools = new Set();
const dirty = (file) => !file.media && file.content !== file.saved;
function persist() { remember('pd.workspace', { root: state.root, paths: state.tabs.map((f) => f.path).slice(-20), active: state.active }); }
function mobile(panel) {
  if (panel === 'editor') { document.body.classList.remove('ws-max-tools'); $('maximizeTools').setAttribute('aria-label', 'Expand terminal panel'); }
  $('workspace').dataset.mobile = panel;
  document.querySelectorAll('[data-mobile]').forEach((node) => { if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', String(node.dataset.mobile === panel)); });
  requestAnimationFrame(() => editor?.resize());
}
function relative(path) { return state.root && path.startsWith(state.root) ? path.slice(state.root.length).replace(/^[\\/]/, '') || basename(state.root) : path; }
function renderTabs() {
  $('editorTabs').replaceChildren(...state.tabs.map((file) => {
    const tab = el('div', 'ws-tab'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.active === file.path)); tab.title = file.path;
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
  const container = $('fileTree');
  if (!state.root) return;
  const rows = [];
  function walk(path, depth) {
    const data = state.dirs.get(path);
    if (!data) { rows.push(el('p', 'ws-hint', 'Loading…')); return; }
    for (const entry of data.entries) {
      const directory = entry.type === 'dir' || entry.linkType === 'dir';
      const row = button('', () => directory ? toggleFolder(entry.path) : openFile(entry.path), 'ws-tree-row');
      row.style.paddingLeft = `${12 + depth * 15}px`; row.dataset.directory = directory;
      row.title = entry.path; row.setAttribute('aria-label', `${directory ? 'Folder' : 'File'} ${entry.name}`);
      if (directory) row.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
      else row.setAttribute('aria-current', String(state.active === entry.path));
      row.append(el('span', 'ws-tree-icon', directory ? state.expanded.has(entry.path) ? '⌄' : '›' : '</>'), el('span', '', entry.name));
      rows.push(row);
      if (directory && state.expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (!data.entries.length) rows.push(el('p', 'ws-hint', depth ? 'Empty folder' : 'This folder is empty. Create a file to get started.'));
    if (data.truncated) rows.push(el('p', 'ws-hint', 'Showing the first 2,000 entries. Open a subfolder to browse further.'));
  }
  walk(state.root, 0); container.replaceChildren(...rows);
}
async function loadDir(path) {
  const root = state.root;
  const data = await api('GET', '/api/files/list?' + new URLSearchParams({ path, showHidden: $('showHidden').checked ? '1' : '0' }));
  if (state.root !== root) return null;
  state.dirs.set(path, data); return data;
}
async function toggleFolder(path) {
  if (state.expanded.has(path)) { state.expanded.delete(path); renderTree(); return; }
  state.expanded.add(path); renderTree();
  try { await loadDir(path); renderTree(); } catch (failure) { state.expanded.delete(path); error(failure.message); renderTree(); }
}
async function refreshFiles() {
  if (!state.root) return chooseFolder();
  const run = ++state.treeRun;
  try {
    await Promise.all([state.root, ...state.expanded].map((path) => loadDir(path).catch((failure) => { if (path === state.root) throw failure; state.expanded.delete(path); })));
    if (run === state.treeRun) { renderTree(); if ($('fileFilter').value.trim()) searchFiles(); }
  } catch (failure) { error(failure.message); }
}
async function selectFolder(path) {
  try {
    const data = await api('GET', '/api/files/list?' + new URLSearchParams({ path, showHidden: $('showHidden').checked ? '1' : '0' }));
    state.root = data.path; state.dirs.clear(); state.expanded.clear(); state.dirs.set(state.root, data);
    $('fileFilter').value = ''; searchRun++;
    $('projectName').textContent = basename(state.root); $('projectPath').textContent = state.root; $('projectPath').title = state.root;
    $('folderPicker').hidden = true; picker?.close();
    renderTree(); persist(); status(`Project: ${basename(state.root)}`);
    showTool('terminal', { focus: false });
    if (matchMedia('(max-width: 760px)').matches) mobile('files');
  } catch (failure) { error(failure.message); }
}
function chooseFolder() {
  mobile('files'); $('folderPicker').hidden = false;
  picker.open(state.root || '', $('openFolder'));
}
async function searchFiles() {
  const run = ++searchRun, query = $('fileFilter').value.trim(), root = state.root;
  if (!query || !root) return renderTree();
  try {
    const data = await api('GET', '/api/files/search?' + new URLSearchParams({ path: root, q: query, showHidden: $('showHidden').checked ? '1' : '0' }));
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
  const previous = current(); if (previous && !previous.media) previous.state = editor.state();
  state.active = path;
  const file = current();
  $('editorEmpty').hidden = !!file; $('editorMount').hidden = !file || file.media; $('mediaPreview').hidden = !file?.media;
  $('fileBreadcrumb').hidden = !file;
  $('fileBreadcrumb').textContent = file ? relative(file.path).split(/[\\/]/).join('  ›  ') : '';
  if (file?.media) renderMedia(file);
  else if (file) { editor.open(file); if (focus) editor.focus(); }
  $('fileLanguage').textContent = file?.media ? 'Preview' : file ? (file.name.split('.').at(-1).toUpperCase() + ' · UTF-8') : 'UTF-8';
  renderTabs(); renderTree(); if ($('fileFilter').value.trim()) searchFiles(); persist();
  if (file && focus) mobile('editor');
}
async function openFile(path, { focus = true } = {}) {
  const run = ++state.openRun;
  if (state.tabs.some((file) => file.path === path)) { if (focus) activate(path); return; }
  status(`Opening ${basename(path)}…`);
  try {
    let data;
    try { data = await api('GET', '/api/files/text?' + new URLSearchParams({ path })); }
    catch (failure) { if (![413, 415].includes(failure.status)) throw failure; data = { path, name: basename(path), media: true, reason: failure.message }; }
    if (!state.tabs.some((file) => file.path === data.path)) state.tabs.push({ ...data, saved: data.content });
    if (focus && run === state.openRun) activate(data.path);
    else renderTabs();
    persist(); status('Ready');
  } catch (failure) { error(failure.message); status('Could not open file'); }
}
async function saveFile() {
  const file = current(); if (!file || file.media || file.saving || !dirty(file)) return;
  const content = file.content;
  file.saving = true; renderTabs(); status(`Saving ${file.name}…`);
  try {
    const saved = await api('PUT', '/api/files/text?' + new URLSearchParams({ path: file.path }), content, { 'if-match': file.revision });
    file.revision = saved.revision; file.saved = content;
    status(`Saved ${file.name}`); error('');
  } catch (failure) { error(failure.message); status(failure.status === 409 ? 'Save conflict · edits preserved' : 'Save failed · edits preserved'); }
  finally { file.saving = false; renderTabs(); }
}
async function reloadFile() {
  const file = current(); if (!file || file.media || file.saving) return;
  if (dirty(file) && !confirm(`Discard unsaved edits to ${file.name} and load the version on the computer?`)) return;
  try {
    const data = await api('GET', '/api/files/text?' + new URLSearchParams({ path: file.path }));
    Object.assign(file, data, { saved: data.content, state: null });
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
  try {
    const data = await api('POST', '/api/files/' + (newKind === 'file' ? 'file' : 'mkdir'), { dir: state.root, name });
    form.hidden = true; $('newEntryName').value = ''; await refreshFiles();
    if (newKind === 'file') await openFile(data.path);
    status(`Created ${name}`);
  } catch (failure) { error(failure.message); }
}
async function uploadFiles(files) {
  if (!state.root) return chooseFolder();
  const root = state.root;
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
  if (focus) mobile('tools');
  const project = state.root, requestKey = `${project}:${tool}:${fresh}`;
  if (startingTools.has(requestKey)) return;
  startingTools.add(requestKey);
  try {
    if (tool !== 'chats' && !state.root) { chooseFolder(); status('Choose a project folder before starting a terminal.'); return; }
    const client = await Promise.race([frameReady, new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal panel is still loading. Try again shortly.')), 15000))]);
    if (project !== state.root) return;
    if (tool === 'chats') { client.pocketDevChat.open(); markTool(tool); return; }
    client.pocketDev.overlays.closeAll();
    const sessions = await api('GET', '/api/sessions');
    const key = `${state.root}:${tool}`;
    let session = !fresh && sessions.find((entry) => entry.id === state.sessions[key] && entry.exitCode == null);
    if (!session && !fresh && tool === 'terminal') session = sessions.find((entry) => entry.cwd === state.root && entry.exitCode == null);
    if (!session) session = await api('POST', '/api/sessions', { cwd: state.root, ...(tool !== 'terminal' && { command: tool }) });
    state.sessions[key] = session.id; remember('pd.workspace.sessions', state.sessions);
    client.pocketDev.openSession(session); markTool(tool);
    status(`${tool === 'terminal' ? 'Terminal' : tool === 'codex' ? 'Codex' : 'Claude'} · ${basename(state.root)}`);
  } catch (failure) { error(failure.message); }
  finally { startingTools.delete(requestKey); }
}
function resize(handle, direction) {
  const adjust = (value) => {
    if (direction === 'x') document.documentElement.style.setProperty('--explorer-width', `${Math.max(170, Math.min(innerWidth * .45, value))}px`);
    else document.documentElement.style.setProperty('--tools-height', `${Math.max(160, Math.min($('workspace').clientHeight - 120, value))}px`);
    remember('pd.workspace.layout', { explorer: document.documentElement.style.getPropertyValue('--explorer-width'), tools: document.documentElement.style.getPropertyValue('--tools-height') });
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId); document.body.classList.add('ws-dragging');
    const move = (e) => adjust(direction === 'x' ? e.clientX : $('workspace').getBoundingClientRect().bottom - e.clientY);
    const finish = () => { document.body.classList.remove('ws-dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  };
  handle.onkeydown = (event) => {
    const value = direction === 'x' ? document.querySelector('.ws-explorer').getBoundingClientRect().width : document.querySelector('.ws-tools').getBoundingClientRect().height;
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
  newKind = kind; mobile('files'); $('newEntryLabel').textContent = `New ${kind} name`; $('newEntryForm').hidden = false; $('newEntryName').focus();
};
$('uploadFiles').onclick = () => state.root ? $('uploadPicker').click() : chooseFolder();
$('uploadPicker').onchange = () => { uploadFiles([...$('uploadPicker').files]); $('uploadPicker').value = ''; };
document.querySelectorAll('button[data-mobile]').forEach((node) => { node.onclick = () => mobile(node.dataset.mobile); });
document.querySelectorAll('[data-tool]').forEach((node) => { node.onclick = () => showTool(node.dataset.tool); });
$('newTerminal').onclick = () => showTool('terminal', { fresh: true });
$('maximizeTools').onclick = () => { const on = document.body.classList.toggle('ws-max-tools'); $('maximizeTools').setAttribute('aria-label', on ? 'Restore editor and terminal' : 'Expand terminal panel'); };
function canLeave() { leaving = !state.tabs.some(dirty) || confirm('Leave the workspace and discard unsaved file edits?'); return leaving; }
$('exitWorkspace').onclick = () => { if (canLeave()) location.href = '/'; };
document.querySelector('.ws-brand').onclick = (event) => { if (!canLeave()) event.preventDefault(); };
window.addEventListener('beforeunload', (event) => { if (!leaving && state.tabs.some(dirty)) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
  if (event.key.toLowerCase() === 'p') { event.preventDefault(); mobile('files'); $('fileFilter').focus(); $('fileFilter').select(); }
});
new ResizeObserver(() => editor?.resize()).observe($('editorMount'));
resize($('explorerResize'), 'x'); resize($('toolsResize'), 'y');
const layout = stored('pd.workspace.layout', {});
if (/^\d+(\.\d+)?px$/.test(layout.explorer)) document.documentElement.style.setProperty('--explorer-width', layout.explorer);
if (/^\d+(\.\d+)?px$/.test(layout.tools)) document.documentElement.style.setProperty('--tools-height', layout.tools);
function panelLoaded() {
  const client = $('toolsFrame').contentWindow;
  if (!client?.pocketDev || !client?.pocketDevChat) { setTimeout(panelLoaded, 100); return; }
  readyResolve(client);
}
$('toolsFrame').addEventListener('load', panelLoaded);
try {
  editor = createEditor({ parent: $('editorMount'), onSave: saveFile, onChange(content) { const file = current(); if (!file || file.media) return; file.content = content; renderTabs(); status(`Unsaved · ${file.name}`); }, onCursor: (line, col) => { $('cursorPosition').textContent = `Ln ${line}, Col ${col}`; } });
  picker = window.PocketDevFolderPicker.create({ api, onSelect: selectFolder, onCancel: () => { $('folderPicker').hidden = true; }, onClose: () => { $('folderPicker').hidden = true; }, title: 'Open project folder', selectLabel: 'Open folder' });
  $('folderPicker').append(picker.element);
  const saved = stored('pd.workspace', {});
  if (typeof saved.root === 'string' && saved.root) {
    await selectFolder(saved.root);
    for (const path of (Array.isArray(saved.paths) ? saved.paths : []).filter((p) => typeof p === 'string').slice(-20)) await openFile(path, { focus: false });
    if (state.tabs.length) activate(state.tabs.some((file) => file.path === saved.active) ? saved.active : state.tabs[0].path, { focus: false });
    mobile('editor');
  }
} catch (failure) { error(failure.message); }
