'use strict';
// The Permissions panel and the first-run setup. It shares h, api, toast and $ with admin-client.js, which calls
// permissionsOnState() after each state load. Checking Control System Events can make macOS ask on this Mac, so the
// panel does not check until the first-run intro has been answered.

const BADGE = {
  mac: { granted: 'Allowed', missing: 'Not allowed', waiting: 'Waiting for you', 'not-needed': 'Not needed', unknown: 'Unknown' },
  tools: { granted: 'Ready', missing: 'Missing', waiting: 'Waiting', 'not-needed': 'Not needed', unknown: 'Unknown' },
};

let permItems = [];
let permStarted = false;
let setup = null;

const needsAttention = (i) => i.group === 'mac' && (i.state === 'missing' || i.state === 'waiting' || i.state === 'unknown');

function actionLabel(item) {
  if (item.state === 'waiting') return 'Check again';
  if (item.state !== 'missing') return null;
  if (item.id === 'automation') return 'Allow…';
  return item.pane ? 'Open Settings' : null;
}

function renderPermissions() {
  const mac = permItems.filter((i) => i.group === 'mac');
  const allowed = mac.filter((i) => i.state === 'granted' || i.state === 'not-needed').length;
  $('permCount').textContent = permItems.length ? `${allowed} of ${mac.length} Mac permissions ready` : '';
  const row = (item) => {
    const label = actionLabel(item);
    const note = item.state === 'granted' || item.state === 'not-needed' ? item.detail ?? item.why : [item.why, item.detail, item.fix].filter(Boolean).join(' ');
    return h('div', { class: 'setting' },
      h('div', { class: 'setting-text' },
        h('b', {}, item.title, ' ', h('span', { class: `perm-badge perm-${item.state}` }, BADGE[item.group][item.state])),
        h('small', {}, note)),
      label && h('button', { class: 'btn btn-sm', type: 'button', onclick: () => allow(item) }, label));
  };
  $('permBody').replaceChildren(
    h('h3', { class: 'perm-group' }, 'This Mac'), ...mac.map(row),
    h('h3', { class: 'perm-group' }, 'Tools'), ...permItems.filter((i) => i.group === 'tools').map(row));
}

async function loadPermissions() {
  $('permErr').textContent = '';
  try {
    const data = await api('GET', '/api/permissions');
    permItems = data.items;
    setup = data.setup;
    renderPermissions();
  } catch (err) {
    $('permErr').textContent = err.message;
  }
}

async function allow(item) {
  $('permErr').textContent = '';
  if (item.state === 'waiting') return loadPermissions();
  try {
    const data = await api('POST', `/api/permissions/${item.id}/request`);
    permItems = data.items;
    renderPermissions();
    if (data.opened) toast('System Settings is open on the Mac. Turn it on there, then come back here.');
  } catch (err) {
    $('permErr').textContent = err.message;
  }
}

// ---- First-run setup: one permission at a time, each can be skipped.

const dialog = () => $('setup');
let steps = [];
let at = 0;
let skippedAny = false;
let finished = false;

function showSetup({ step, title, body, status, actions }) {
  $('setupStep').textContent = step;
  $('setupTitle').textContent = title;
  $('setupWhy').textContent = body;
  $('setupStatus').textContent = status;
  $('setupActions').replaceChildren(...actions);
  if (!dialog().open) dialog().showModal();
}

const btn = (text, onclick, primary = false) => h('button', { class: `btn${primary ? ' btn-primary' : ''}`, type: 'button', onclick }, text);

function showIntro() {
  showSetup({
    step: 'Welcome',
    title: 'Set up Pocket Dev permissions',
    body: 'Some features need a permission from macOS. This takes a minute: you will be asked for each one in turn, and you can skip any of them. macOS shows its own pop-up on this Mac for some.',
    status: 'Skipping is fine. You can run this again from the Permissions panel.',
    actions: [btn('Skip for now', () => finishSetup(true)), btn('Start', startSteps, true)],
  });
}

async function startSteps() {
  try {
    permItems = (await api('GET', '/api/permissions')).items;
  } catch (err) {
    return showSetup({ step: 'Setup', title: 'Could not check', body: err.message, status: '', actions: [btn('Close', () => finishSetup(true), true)] });
  }
  renderPermissions();
  steps = permItems.filter((i) => needsAttention(i));
  at = 0;
  skippedAny = false;
  renderStep();
}

function currentItem() {
  return permItems.find((i) => i.id === steps[at].id);
}

function renderStep() {
  if (at >= steps.length) return renderSummary();
  const item = currentItem();
  if (item.state === 'granted' || item.state === 'not-needed') {
    at++;
    return renderStep();
  }
  const status = item.state === 'waiting' ? item.detail : [item.detail, item.fix].filter(Boolean).join(' ');
  showSetup({
    step: `Step ${at + 1} of ${steps.length}`,
    title: item.title,
    body: item.why,
    status,
    actions: [
      btn('Skip', () => { skippedAny = true; at++; renderStep(); }),
      btn('Check again', recheck),
      btn(item.id === 'automation' ? 'Allow' : 'Open Settings', requestCurrent, true),
    ],
  });
}

async function applyResult(promise) {
  try {
    permItems = (await promise).items;
  } catch (err) {
    $('setupStatus').textContent = err.message;
    return;
  }
  renderPermissions();
  if (currentItem().state === 'granted') {
    $('setupStatus').textContent = 'Allowed ✓';
    setTimeout(() => { at++; renderStep(); }, 700);
  } else {
    const item = currentItem();
    $('setupStatus').textContent = item.state === 'missing' ? `Not allowed yet. ${item.fix ?? ''}` : item.detail ?? '';
  }
}

function requestCurrent() {
  $('setupStatus').textContent = currentItem().id === 'automation' ? 'Waiting for your answer to the pop-up on this Mac…' : 'Opening System Settings…';
  return applyResult(api('POST', `/api/permissions/${currentItem().id}/request`));
}

function recheck() {
  $('setupStatus').textContent = 'Checking…';
  return applyResult(api('GET', '/api/permissions'));
}

function renderSummary() {
  const lines = steps.map((s) => `${permItems.find((i) => i.id === s.id).state === 'granted' ? '✓' : '–'} ${s.title}`);
  showSetup({
    step: 'All done',
    title: skippedAny || steps.some((s) => permItems.find((i) => i.id === s.id).state !== 'granted') ? 'Setup finished with some skipped' : 'Everything is allowed',
    body: lines.join('\n'),
    status: 'Anything marked – can be turned on later from the Permissions panel.',
    actions: [btn('Done', () => finishSetup(false), true)],
  });
}

async function finishSetup(skipped) {
  if (finished) return;
  finished = true;
  const incomplete = skipped || skippedAny || permItems.some(needsAttention);
  dialog().close();
  try {
    await api('POST', '/api/permissions/setup', { status: incomplete ? 'skipped' : 'done' });
  } catch (err) {
    toast(err.message, true);
  }
  finished = false;
  loadPermissions();
}

dialog().addEventListener('cancel', (e) => { e.preventDefault(); finishSetup(true); });
$('permRecheck').addEventListener('click', loadPermissions);
$('permSetup').addEventListener('click', startSteps);
// The person comes back from System Settings to this tab.
window.addEventListener('focus', () => { if (permStarted && !dialog().open) loadPermissions(); });

function permissionsOnState(state) {
  if (permStarted) return;
  permStarted = true;
  if (state.permissionsSetup == null) {
    $('permBody').replaceChildren(h('p', { class: 'note' }, 'Not checked yet. Finish the setup, or press Check again.'));
    showIntro();
  } else {
    loadPermissions();
  }
}
