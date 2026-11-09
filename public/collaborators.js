const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text, run, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = run; return b; };
const field = (text, input) => { const label = el('label', 'co-field', text); input.setAttribute('aria-label', text); label.append(input); return label; };
let optionsId = 0;
function select(choices) {
  const s = el('select');
  for (const [value, label] of choices) { const o = el('option', '', label); o.value = value; s.append(o); }
  return s;
}
async function copy(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const input = el('textarea'); input.value = text; document.body.append(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('Copy failed. Select and copy the invitation link.');
}

export function mountCollaborators(container, { api, local = false, devices = () => [] }) {
  container.classList.add('co');
  const heading = el('h3', '', 'Collaborators');
  const note = el('p', 'co-note', 'Give someone access to one project and the related folders you choose.');
  const enable = el('div'), actions = el('div', 'co-actions'), form = el('form', 'co-form'), list = el('ul', 'co-list');
  const error = el('p', 'co-error'), result = el('div', 'co-result');
  error.setAttribute('role', 'alert'); result.hidden = true; form.hidden = true;
  const add = button('Invite someone', () => edit(null), 'co-primary'); add.disabled = true; actions.append(add);
  container.replaceChildren(heading, note, enable, actions, form, result, list, error);
  let state = null, busy = false, invitation = null, inviteTimer, trustKey = '';
  async function act(run) {
    if (busy) return;
    busy = true; add.disabled = true; error.textContent = '';
    try { await run(); await refresh(); }
    catch (err) { error.textContent = err.message; }
    finally { busy = false; add.disabled = !state?.enabled; }
  }
  function clearInvitation() { invitation = null; clearTimeout(inviteTimer); result.replaceChildren(); result.hidden = true; }
  function renderEnable() {
    enable.replaceChildren();
    if (state.enabled) return;
    enable.append(el('p', 'co-note', local ? 'Select only your own trusted devices to keep as Admin. Other devices will need review on this device. New password logins will require approval there.' : 'On the device itself, open Admin → Collaborators, review your trusted devices, and enable role-based sharing.'));
    if (!local) return;
    const checked = new Set();
    for (const device of devices().filter((d) => d.status === 'active')) {
      const input = el('input'); input.type = 'checkbox';
      const label = el('label', 'co-check'); label.append(input, `${device.name} · ${device.code}`);
      input.onchange = () => { input.checked ? checked.add(device.id) : checked.delete(device.id); };
      enable.append(label);
    }
    const confirm = button('Enable role-based sharing', () => act(async () => {
      await api('POST', '/api/collaborators/enable', { adminDeviceIds: [...checked] });
    }), 'co-primary');
    confirm.disabled = !devices().some((d) => d.status === 'active');
    enable.append(confirm);
  }
  const chooseFolder = (input, label) => window.PocketDevFolderPicker?.field(input, { api, label }) ?? field(label, input);
  function folderRow(parent, value = {}) {
    const row = el('div', 'co-folder'), input = el('input');
    input.placeholder = '~/Downloads/project-assets'; input.value = value.given || value.path || ''; input.required = true; input.setAttribute('aria-label', 'Related folder path');
    const mode = select([['read', 'Read-only'], ['write', 'Read/write copy']]); mode.value = value.mode || 'read'; mode.setAttribute('aria-label', 'Related folder access');
    const remove = button('Remove', () => row.remove());
    row.pathInput = input; row.accessMode = mode;
    row.append(chooseFolder(input, 'Related folder'), mode, remove); parent.append(row);
    return row;
  }
  function edit(grant) {
    if (busy) return;
    clearInvitation(); form.hidden = false; form.replaceChildren();
    const label = el('input'); label.required = true; label.maxLength = 80; label.value = grant?.label || ''; label.placeholder = 'Name or device label';
    const role = select([['viewer', 'Viewer, view and download'], ['developer', 'Developer, edit a project copy']]); role.value = grant?.role || 'viewer';
    const repo = el('input'); repo.required = true; repo.value = grant?.repository.given || ''; repo.placeholder = '~/Desktop/my-project'; repo.autocomplete = 'off';
    const repos = el('datalist'); repos.id = `co-repositories-${++optionsId}`; repo.setAttribute('list', repos.id);
    for (const path of state.repositories || []) { const option = el('option'); option.value = path; repos.append(option); }
    const duration = select([['3600', '1 hour'], ['86400', '1 day'], ['604800', '7 days']]); duration.value = String(grant?.duration || 86400);
    const related = el('div');
    for (const extra of grant?.extraFolders || []) folderRow(related, extra);
    const addFolder = button('Add related folder', () => { if (related.childElementCount < 5) folderRow(related).accessMode.disabled = role.value === 'viewer'; });
    const ai = el('input'); ai.type = 'checkbox'; ai.disabled = true;
    const aiLabel = el('label', 'co-check'); aiLabel.append(ai, 'AI access');
    const aiNote = el('p', 'co-note', state.ai.reason);
    const scopeNote = el('p', 'co-note');
    const syncRole = () => {
      scopeNote.textContent = role.value === 'developer' ? 'Developer changes stay in a separate project copy for your review. Credentials, Git metadata, dependencies, environment files and symlinks are excluded from the copy. AI is currently unavailable.' : 'Viewers can only view, preview and download permitted files.';
      for (const row of related.children) { row.accessMode.disabled = role.value === 'viewer'; if (role.value === 'viewer') row.accessMode.value = 'read'; }
    };
    role.onchange = syncRole; syncRole();
    const footer = el('div', 'co-actions'), save = el('button', 'co-primary', grant ? 'Save access' : 'Create collaborator'); save.type = 'submit';
    footer.append(save, button('Cancel', () => { if (!busy) form.hidden = true; }));
    form.append(field('Name', label), field('Role', role), chooseFolder(repo, 'Repository'), repos, scopeNote, aiLabel, aiNote, el('h4', '', 'Related folders'), related, addFolder, field('Access duration', duration), el('p', 'co-note', grant ? 'Changing access ends current transfers and invalidates outstanding invitations. Developer changes will start in a fresh project copy; the old copy remains on the device for review.' : 'The invitation works once within 10 minutes. Access duration starts when it is accepted.'), footer);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      act(async () => {
        save.disabled = true;
        const saveText = save.textContent;
        save.textContent = role.value === 'developer' ? 'Preparing copy…' : 'Saving…';
        form.setAttribute('aria-busy', 'true');
        try {
          const body = { label: label.value, role: role.value, repository: repo.value, ai: false, duration: Number(duration.value), extraFolders: [...related.children].map((row) => ({ path: row.pathInput.value, mode: role.value === 'viewer' ? 'read' : row.accessMode.value })) };
          const saved = await api(grant ? 'PATCH' : 'POST', `/api/collaborators${grant ? `/${grant.id}` : ''}`, body);
          form.hidden = true;
          if (!grant) await showInvite(saved);
        } finally { save.disabled = false; save.textContent = saveText; form.setAttribute('aria-busy', 'false'); }
      });
    };
    label.focus();
  }
  async function showInvite(grant) {
    const next = await api('POST', `/api/collaborators/${grant.id}/invite`, {});
    clearInvitation(); invitation = next;
    result.hidden = false;
    result.append(el('h4', '', 'Share invitation'), el('p', 'co-note', 'Works once within 10 minutes. Recipient must be able to reach this device, usually on the same Wi-Fi. Use a trusted private connection.'));
    const url = el('textarea'); url.value = next.url; url.readOnly = true; url.rows = 3; url.setAttribute('aria-label', 'Invitation link');
    const qr = el('div'); qr.innerHTML = next.svg; qr.hidden = true;
    const controls = el('div', 'co-actions');
    const message = `Open the project shared with you in Pocket Dev: ${next.url}`;
    const share = button('Share invite', async () => {
      try { if (!navigator.share) { await copy(next.url); copied.textContent = 'Link copied. You can also use Share on WhatsApp.'; return; } await navigator.share({ title: 'Pocket Dev invitation', text: message }); }
      catch (err) { if (err.name !== 'AbortError') error.textContent = 'Sharing is unavailable. Use Copy link or Share on WhatsApp.'; }
    });
    const whatsapp = el('a', 'co-button', 'Share on WhatsApp'); whatsapp.href = `https://wa.me/?text=${encodeURIComponent(message)}`; whatsapp.target = '_blank'; whatsapp.rel = 'noopener noreferrer';
    const copied = el('p', 'co-note'); copied.setAttribute('role', 'status');
    controls.append(share, button('Show QR', () => { qr.hidden = !qr.hidden; }), button('Copy link', async () => { try { await copy(next.url); copied.textContent = 'Link copied'; } catch (err) { error.textContent = err.message; } }), whatsapp);
    result.append(controls, copied, url, qr);
    inviteTimer = setTimeout(() => { if (invitation === next) { clearInvitation(); error.textContent = 'This invitation expired. Create a new one from the collaborator row.'; } }, Math.max(0, next.expiresAt - Date.now()));
  }
  function renderList() {
    list.replaceChildren();
    if (!state.collaborators.length) { list.append(el('li', 'co-note', 'No collaborators yet.')); return; }
    for (const grant of state.collaborators) {
      const row = el('li', 'co-item'), head = el('div', 'co-item-head');
      head.append(el('h4', '', grant.label), el('span', 'co-role', `${grant.role === 'developer' ? 'Developer' : 'Viewer'} · ${grant.status}`));
      const detail = el('p', 'co-note', `${grant.repository.given}${grant.extraFolders.length ? ` · ${grant.extraFolders.length} related folder${grant.extraFolders.length === 1 ? '' : 's'}` : ''} · ${grant.expiresAt ? `Expires ${new Date(grant.expiresAt).toLocaleString()}` : 'Not yet accepted'}`);
      const controls = el('div', 'co-actions');
      controls.append(button('Edit access', () => edit(grant)), button('New invitation', () => act(() => showInvite(grant))), button('Revoke', () => act(async () => { await api('DELETE', `/api/collaborators/${grant.id}`); clearInvitation(); }), 'co-danger'));
      if (grant.workspace) controls.append(button('Review project copy', () => {
        if (window.openFiles) window.openFiles(`${grant.workspace}/project`);
        else { copy(`${grant.workspace}/project`).then(() => { error.textContent = 'Project-copy path copied. Open it in Files or Finder on this device.'; }, (err) => { error.textContent = err.message; }); }
      }));
      if (grant.revoked) controls.querySelectorAll('button').forEach((b) => { if (b.textContent !== 'Edit access' && b.textContent !== 'Review project copy') b.disabled = true; });
      row.append(head, detail, controls); list.append(row);
    }
  }
  async function refresh() {
    try {
      state = await api('GET', '/api/collaborators');
      add.disabled = !state.enabled;
      // Preserve a partly completed trust review during periodic refreshes.
      const nextTrustKey = JSON.stringify(devices().map((d) => [d.id, d.status]));
      if (!enable.childElementCount || state.enabled || nextTrustKey !== trustKey) renderEnable();
      trustKey = nextTrustKey;
      renderList();
    } catch (err) { error.textContent = err.message; add.disabled = true; }
  }
  refresh();
  return { refresh, dispose: () => { clearInvitation(); } };
}
