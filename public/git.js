import { layoutGraph } from '/graph.js';

const { api } = window;
const PAGE = 300;
const MAX_LANES = 6;
const LANE_W = 12;
const ROW_H = 48;
const DIFF_MAX_LINES = 3000;
const PALETTE = ['#6aa9ff', '#7ee787', '#f0c674', '#d2a8ff', '#ff7b72', '#76e3ea', '#ffa657', '#f778ba'];

const remember = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const q = (params) => new URLSearchParams({ repo: state.repo, ...params });
const get = (route, params = {}) => api('GET', `/api/git/${route}?${q(params)}`);
const post = (route, body) => api('POST', `/api/git/${route}?${q()}`, body);

const short = (hash) => hash.slice(0, 7);
function ago(unixSeconds) {
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
const agoIso = (iso) => ago(Date.parse(iso) / 1000);

const notice = (kind, text) => el('div', { class: `g-notice ${kind}` }, text);
const empty = (text) => el('p', { class: 'g-empty' }, text);
const section = (title, ...children) => el('section', { class: 'g-section' }, el('h3', {}, title), ...children);

function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function fileRow({ code, path, origPath, stats, onclick }) {
  const [dir, name] = splitPath(path);
  return el('button', { class: 'g-file', onclick },
    code ? el('span', { class: `g-code c-${code}` }, code) : null,
    el('span', { class: 'g-path' },
      origPath ? el('span', { class: 'g-dir' }, `${origPath} → `) : null,
      el('span', { class: 'g-dir' }, dir), name),
    stats);
}

function numstat(added, deleted) {
  if (added == null) return el('span', { class: 'g-stat' }, 'bin');
  return el('span', { class: 'g-stat' }, el('span', { class: 'add' }, `+${added}`), ' ', el('span', { class: 'del' }, `−${deleted}`));
}

// --- diff viewer -------------------------------------------------------------------------------

function diffView(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return empty('No textual changes.');
  const out = el('div', { class: 'g-diff' });
  let header = false;
  for (const line of lines.slice(0, DIFF_MAX_LINES)) {
    if (line.startsWith('diff ')) header = true;
    else if (line.startsWith('@@')) header = false;
    const cls = header ? 'meta' : line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('\\') ? 'meta' : '';
    out.append(el('div', { class: cls }, line || ' '));
  }
  if (lines.length > DIFF_MAX_LINES) out.append(notice('info', `Truncated: showing ${DIFF_MAX_LINES} of ${lines.length} lines.`));
  return out;
}

const C_ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };

// git C-quotes paths with special or non-ASCII bytes: "b/caf\303\251.txt".
function unquotePath(p) {
  if (!p.startsWith('"')) return p;
  const bytes = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') bytes.push(...new TextEncoder().encode(s[i]));
    else if (/[0-7]/.test(s[i + 1])) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; }
    else bytes.push(C_ESCAPES[s[++i]] ?? s.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// Splits a multi-file diff at its "diff --git" headers so one file's section can be shown on its own.
function fileSection(text, path) {
  const sections = text.split(/^(?=diff --git )/m);
  return sections.find((s) => {
    const header = s.split(/\n@@/)[0];
    const named = [...header.matchAll(/^(?:\+\+\+|---|rename to|rename from) (.+)$/gm)].map((m) => unquotePath(m[1]).replace(/^[ab]\//, ''));
    return named.includes(path) || header.slice(0, header.indexOf('\n')).endsWith(` b/${path}`);
  }) ?? text;
}

// --- graph -------------------------------------------------------------------------------------

function laneSvg(row, lanes) {
  const col = (lane) => Math.min(lane, lanes - 1);
  const x = (lane) => col(lane) * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  const collapsed = (l) => l.fromLane >= lanes - 1 || l.toLane >= lanes - 1;
  const paths = row.lines.map((l) => {
    const [x1, x2] = [x(l.fromLane), x(l.toLane)];
    const d = l.kind === 'pass' ? `M${x1} 0V${ROW_H}`
      : l.kind === 'in' ? (x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.6} ${x2} ${mid * 0.4} ${x2} ${mid}`)
      : (x1 === x2 ? `M${x1} ${mid}V${ROW_H}` : `M${x1} ${mid}C${x1} ${mid + mid * 0.6} ${x2} ${mid + mid * 0.4} ${x2} ${ROW_H}`);
    const faded = lanes > 1 && row.width > lanes && collapsed(l) ? ' stroke-opacity=".45"' : '';
    return `<path d="${d}" stroke="${PALETTE[l.color % PALETTE.length]}"${faded}/>`;
  }).join('');
  const color = PALETTE[row.color % PALETTE.length];
  const merge = row.commit.parents.length > 1;
  const dot = `<circle cx="${x(row.lane)}" cy="${mid}" r="4" fill="${merge || row.lane >= lanes ? 'var(--bg)' : color}" stroke="${color}" stroke-width="2"/>`;
  const w = lanes * LANE_W + 4;
  return `<svg width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}" fill="none" stroke-width="2" aria-hidden="true">${paths}${dot}</svg>`;
}

const REF_ORDER = { head: 0, branch: 1, tag: 2, remote: 3 };
function refChips(refs) {
  return [...refs].sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind])
    .map((r) => el('span', { class: `g-ref ${r.kind}` }, r.kind === 'tag' ? `# ${r.name}` : r.name));
}

function commitRow(row, lanes, open) {
  const { commit } = row;
  const graphCell = el('span', { class: 'g-lanes' });
  graphCell.innerHTML = laneSvg(row, lanes);
  return el('button', { class: 'g-commit', onclick: () => open(commit) },
    graphCell,
    el('span', { class: 'g-commit-text' },
      el('span', { class: 'g-line1' }, ...refChips(commit.refs), el('span', { class: 'g-subject' }, commit.subject)),
      el('span', { class: 'g-line2' }, `${commit.author} · ${ago(commit.time)} · `, el('code', {}, short(commit.hash)))));
}

async function renderGraph(screen) {
  let { commits, hasMore } = await get('graph', { limit: PAGE });
  if (!commits.length) return empty('No commits yet.');
  const list = el('div', { class: 'g-graph' });
  const more = el('button', { class: 'g-more' }, 'Load more');
  const open = (commit) => push('commit', { hash: commit.hash, title: short(commit.hash) });
  const draw = () => {
    const rows = layoutGraph(commits);
    const lanes = Math.min(MAX_LANES, Math.max(...rows.map((r) => r.width)));
    list.replaceChildren(...rows.map((row) => commitRow(row, lanes, open)));
    more.hidden = !hasMore;
  };
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const page = await get('graph', { limit: PAGE, skip: commits.length });
      commits = commits.concat(page.commits);
      hasMore = page.hasMore;
      draw();
    } catch (err) {
      screen.el.append(notice('error', err.message));
    }
    more.disabled = false;
    more.textContent = 'Load more';
  };
  draw();
  return [list, more];
}

const STATUS_NAMES = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict' };

async function renderCommit(screen) {
  const c = await get('commit', { hash: screen.params.hash });
  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  return [
    el('div', { class: 'g-card' },
      el('h2', { class: 'g-title' }, subject),
      body ? el('p', { class: 'g-body' }, body) : null,
      el('dl', { class: 'g-meta' },
        el('dt', {}, 'Author'), el('dd', {}, `${c.author} <${c.email}>`),
        el('dt', {}, 'Date'), el('dd', {}, new Date(c.time * 1000).toLocaleString()),
        el('dt', {}, 'Commit'), el('dd', {}, el('code', { class: 'g-hash' }, c.hash)),
        c.parents.length ? el('dt', {}, c.parents.length > 1 ? 'Parents' : 'Parent') : null,
        c.parents.length ? el('dd', {}, ...c.parents.map((p) => el('button', { class: 'g-link', onclick: () => push('commit', { hash: p, title: short(p) }) }, short(p)))) : null)),
    c.parents.length > 1 ? notice('info', `Merge commit: files are the changes it brought into ${short(c.parents[0])}.`) : null,
    section(`${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`,
      c.files.length ? c.files.map((f) => fileRow({
        code: f.status, path: f.path, origPath: f.origPath, stats: numstat(f.added, f.deleted),
        onclick: () => push('diff', { title: f.path, source: 'commit', hash: c.hash, path: f.path, origPath: f.origPath }),
      })) : empty('No file changes.')),
  ];
}

async function renderDiff(screen) {
  const { title, ...params } = screen.params;
  const { text } = await get('diff', Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)));
  return diffView(text);
}

// --- changes -----------------------------------------------------------------------------------

const CHANGE_GROUPS = [
  { title: 'Staged', source: 'staged', pick: (f) => f.staged, code: (f) => f.staged },
  { title: 'Changed', source: 'unstaged', pick: (f) => f.unstaged, code: (f) => f.unstaged },
  { title: 'Untracked', source: 'untracked', pick: (f) => f.untracked, code: () => '?' },
];

async function renderChanges() {
  const s = await get('status');
  const sync = s.upstream
    ? el('span', { class: 'g-sync' }, s.upstream, ' ', el('b', { class: s.ahead ? 'ahead' : '' }, `↑${s.ahead}`), ' ', el('b', { class: s.behind ? 'behind' : '' }, `↓${s.behind}`))
    : el('span', { class: 'g-sync' }, 'no upstream');
  const head = el('div', { class: 'g-card g-branch' }, el('span', { class: 'g-ref head' }, s.branch ?? 'detached HEAD'), sync);
  if (!s.files.length) return [head, empty('Working tree clean.')];
  return [head, ...CHANGE_GROUPS.map((g) => {
    const files = s.files.filter(g.pick);
    if (!files.length) return null;
    return section(`${g.title} (${files.length})`, files.map((f) => fileRow({
      code: g.code(f), path: f.path, origPath: g.source === 'staged' ? f.origPath : null,
      onclick: () => push('diff', { title: f.path, source: g.source, path: f.path, origPath: g.source === 'staged' ? f.origPath : null }),
    })));
  })];
}

// --- pull requests -----------------------------------------------------------------------------

const REVIEW_LABELS = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'bad'], REVIEW_REQUIRED: ['Review required', 'warn'] };
const CHECK_LABELS = { pass: 'Checks passed', fail: 'Checks failed', pending: 'Checks running' };
const badge = (text, kind = '') => el('span', { class: `g-badge ${kind}` }, text);

function prBadges(pr) {
  const review = REVIEW_LABELS[pr.reviewDecision];
  const checks = pr.checks;
  return [
    pr.isDraft ? badge('Draft') : null,
    review ? badge(review[0], review[1]) : null,
    checks.state !== 'none' ? badge(`${CHECK_LABELS[checks.state]} ${checks.passed}/${checks.passed + checks.failed + checks.pending}`, { pass: 'ok', fail: 'bad', pending: 'warn' }[checks.state]) : null,
  ];
}

async function renderPrs() {
  const create = el('button', { class: 'g-btn primary g-new-pr', onclick: () => push('prCreate', { title: 'New pull request' }) }, 'New pull request');
  let list;
  try {
    list = await get('prs');
  } catch (err) {
    return [create, notice('error', err.message)];
  }
  if (!list.length) return [create, empty('No open pull requests.')];
  return [create, el('div', { class: 'g-prs' }, list.map((pr) => el('button', { class: 'g-pr', onclick: () => push('pr', { number: pr.number, title: `#${pr.number}` }) },
    el('span', { class: 'g-pr-title' }, el('span', { class: 'g-num' }, `#${pr.number}`), ' ', pr.title),
    el('span', { class: 'g-line2' }, `${pr.author} · `, el('code', {}, pr.headRefName), ' → ', el('code', {}, pr.baseRefName), ` · ${agoIso(pr.updatedAt)}`),
    el('span', { class: 'g-badges' }, prBadges(pr)))))];
}

const MERGE_METHODS = {
  squash: { label: 'Squash and merge', verb: 'Squash-merge' },
  merge: { label: 'Create a merge commit', verb: 'Merge' },
  rebase: { label: 'Rebase and merge', verb: 'Rebase-merge' },
};
const REVIEW_EVENTS = {
  comment: { label: 'Comment', needsBody: true },
  approve: { label: 'Approve', needsBody: false },
  request_changes: { label: 'Request changes', needsBody: true },
};
const PR_STATES = { OPEN: 'ok', MERGED: 'merged', CLOSED: 'bad' };
const CHECK_DOT = { pass: '●', fail: '●', pending: '○' };

async function runAction(screen, button, action, success) {
  const all = screen.el.querySelectorAll('.g-actions button, .g-actions textarea');
  for (const b of all) b.disabled = true;
  const label = button.textContent;
  button.textContent = 'Working…';
  try {
    const result = await action();
    screen.flash = notice('ok', success(result));
    if (result.deleteError) screen.flash.append(el('div', { class: 'g-sub-error' }, `Branch not deleted: ${result.deleteError}`));
    for (const s of stacks[state.tab]) s.stale = s !== screen;
    refresh(screen);
  } catch (err) {
    for (const b of all) b.disabled = false;
    button.textContent = label;
    screen.el.querySelector('.g-action-msg').replaceChildren(notice('error', err.message));
  }
}

function reviewForm(screen, pr) {
  let event = 'comment';
  const text = el('textarea', { class: 'g-input', rows: 3, placeholder: 'Leave a comment' });
  const submit = el('button', { class: 'g-btn primary' }, 'Submit review');
  const seg = el('div', { class: 'g-seg' });
  const draw = () => {
    seg.replaceChildren(...Object.entries(REVIEW_EVENTS).map(([key, e]) => el('button', { class: key === event ? 'on' : '', onclick: () => { event = key; draw(); } }, e.label)));
    text.placeholder = REVIEW_EVENTS[event].needsBody ? 'Message (required)' : 'Message (optional)';
  };
  draw();
  submit.onclick = () => {
    if (REVIEW_EVENTS[event].needsBody && !text.value.trim()) {
      screen.el.querySelector('.g-action-msg').replaceChildren(notice('error', `${REVIEW_EVENTS[event].label} needs a message.`));
      return;
    }
    runAction(screen, submit, () => post('pr/review', { number: pr.number, event, body: text.value }), () => `${REVIEW_EVENTS[event].label} submitted on #${pr.number}.`);
  };
  return section('Review', seg, text, el('p', { class: 'g-hint' }, 'GitHub does not let you approve your own pull request; it will reply with an error.'), submit);
}

function mergeForm(screen, pr) {
  const method = el('select', { class: 'g-input' }, Object.entries(MERGE_METHODS).map(([key, m]) => el('option', { value: key }, m.label)));
  const del = el('input', { type: 'checkbox', checked: !pr.isCrossRepository, disabled: pr.isCrossRepository });
  const conflicting = pr.mergeable === 'CONFLICTING';
  const merge = el('button', { class: 'g-btn primary', disabled: conflicting || pr.isDraft }, 'Merge');
  merge.onclick = () => {
    const { verb } = MERGE_METHODS[method.value];
    const deleting = del.checked && !pr.isCrossRepository;
    if (!confirm(`${verb} #${pr.number} into ${pr.baseRefName}${deleting ? ` and delete branch ${pr.headRefName} on GitHub` : ''}?`)) return;
    runAction(screen, merge, () => post('pr/merge', { number: pr.number, method: method.value, deleteBranch: deleting, headSha: pr.headRefOid }),
      (r) => `Merged #${pr.number} into ${pr.baseRefName}.${r.branchDeleted ? ` Deleted ${pr.headRefName} on GitHub; your local branch is untouched.` : ''}${r.message ? `\n${r.message}` : ''}`);
  };
  return section('Merge',
    conflicting ? notice('error', `${pr.headRefName} has conflicts with ${pr.baseRefName}. Resolve them before merging.`) : null,
    pr.isDraft ? notice('info', 'This is a draft. Mark it ready for review on GitHub before merging.') : null,
    method,
    el('label', { class: 'g-check' }, del, pr.isCrossRepository ? `${pr.headRefName} is in a fork; it will not be deleted` : `Delete ${pr.headRefName} on GitHub after merging`),
    merge);
}

function stateForm(screen, pr) {
  if (pr.state === 'OPEN') {
    const close = el('button', { class: 'g-btn danger' }, 'Close pull request');
    close.onclick = () => {
      if (!confirm(`Close #${pr.number} without merging? The branch ${pr.headRefName} stays.`)) return;
      runAction(screen, close, () => post('pr/close', { number: pr.number }), () => `Closed #${pr.number}.`);
    };
    return close;
  }
  if (pr.state === 'CLOSED') {
    const reopen = el('button', { class: 'g-btn' }, 'Reopen pull request');
    reopen.onclick = () => runAction(screen, reopen, () => post('pr/reopen', { number: pr.number }), () => `Reopened #${pr.number}.`);
    return reopen;
  }
  return null;
}

async function renderPr(screen) {
  const pr = await get('pr', { number: screen.params.number });
  const flash = screen.flash;
  screen.flash = null;
  const activity = [
    ...pr.reviews.map((r) => ({ ...r, kind: r.state.toLowerCase().replace('_', ' ') })),
    ...pr.comments.map((c) => ({ ...c, kind: 'commented' })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [
    flash,
    el('div', { class: 'g-card' },
      el('h2', { class: 'g-title' }, pr.title),
      el('div', { class: 'g-badges' }, badge(pr.state, PR_STATES[pr.state]), ...prBadges(pr)),
      el('p', { class: 'g-line2' }, `#${pr.number} by ${pr.author} · `, el('code', {}, pr.headRefName), ' → ', el('code', {}, pr.baseRefName)),
      el('p', { class: 'g-line2' }, numstat(pr.additions, pr.deletions), ` · ${pr.files.length} file${pr.files.length === 1 ? '' : 's'}`),
      el('a', { class: 'g-btn', href: pr.url, target: '_blank', rel: 'noopener' }, 'Open on GitHub')),
    section('Description', pr.body.trim() ? el('p', { class: 'g-body' }, pr.body.trim()) : empty('No description.')),
    section(`Checks${pr.checks.items.length ? ` (${pr.checks.passed}/${pr.checks.items.length} passed)` : ''}`,
      pr.checks.items.length ? pr.checks.items.map((c) => el(c.url ? 'a' : 'div', { class: 'g-checkrow', href: c.url, target: '_blank', rel: 'noopener' },
        el('span', { class: `g-dot ${c.state}` }, CHECK_DOT[c.state]), c.name, el('span', { class: 'g-dim' }, c.state))) : empty('No checks reported.')),
    section(`Files (${pr.files.length})`, pr.files.map((f) => fileRow({
      path: f.path, stats: numstat(f.additions, f.deletions),
      onclick: () => push('prDiff', { title: f.path, number: pr.number, path: f.path }),
    }))),
    section(`Activity (${activity.length})`, activity.length ? activity.map((a) => el('div', { class: 'g-activity' },
      el('div', { class: 'g-line2' }, el('b', {}, a.author), ` ${a.kind} · ${agoIso(a.at)}`),
      a.body ? el('p', { class: 'g-body' }, a.body) : null)) : empty('No reviews or comments yet.')),
    el('div', { class: 'g-actions' },
      el('div', { class: 'g-action-msg' }),
      pr.state === 'OPEN' ? reviewForm(screen, pr) : null,
      pr.state === 'OPEN' ? mergeForm(screen, pr) : null,
      stateForm(screen, pr)),
  ];
}

const prDiffs = new Map();
async function renderPrDiff(screen) {
  const key = `${state.repo}#${screen.params.number}`;
  if (screen.reloaded || !prDiffs.has(key)) prDiffs.set(key, (await get('pr/diff', { number: screen.params.number })).text);
  return diffView(fileSection(prDiffs.get(key), screen.params.path));
}

async function renderPrCreate(screen) {
  const { current, defaultBranch, branches } = await get('branches');
  const byName = new Map(branches.map((b) => [b.name, b]));
  const heads = branches.filter((b) => b.name !== defaultBranch);
  if (!heads.length) return empty(`No branches besides ${defaultBranch} to open a pull request from.`);
  const startHead = byName.has(current) && current !== defaultBranch ? current : heads[0].name;
  const baseNames = [...new Set([defaultBranch, ...branches.map((b) => b.name)])];
  const head = el('select', { class: 'g-input' }, heads.map((b) => el('option', { value: b.name, selected: b.name === startHead }, b.name)));
  const base = el('select', { class: 'g-input' }, baseNames.map((n) => el('option', { value: n, selected: n === defaultBranch }, n)));
  const title = el('input', { class: 'g-input', type: 'text', placeholder: 'Title', enterkeyhint: 'next' });
  const body = el('textarea', { class: 'g-input', rows: 6, placeholder: 'Description (optional)' });
  const draft = el('input', { type: 'checkbox' });
  const push_ = el('input', { type: 'checkbox' });
  const pushRow = el('label', { class: 'g-check' }, push_, '');
  const pushNote = el('div', {});
  const msg = el('div', {});
  const submit = el('button', { class: 'g-btn primary' }, 'Create pull request');
  let titleEdited = false;
  title.oninput = () => { titleEdited = true; };

  const sync = () => {
    const b = byName.get(head.value);
    if (!titleEdited) title.value = b.subject;
    pushNote.replaceChildren(b.pushed ? '' : notice('info', `${b.name} isn't on GitHub yet. It will be pushed first.`));
    pushRow.hidden = !b.pushed;
    push_.checked = b.ahead > 0;
    pushRow.lastChild.textContent = b.ahead > 0 ? `Push ${b.ahead} new commit${b.ahead === 1 ? '' : 's'} first` : 'Push the branch first';
  };
  head.onchange = sync;
  sync();

  submit.onclick = async () => {
    if (!title.value.trim()) return msg.replaceChildren(notice('error', 'Title is required.'));
    if (head.value === base.value) return msg.replaceChildren(notice('error', 'Head and base must differ.'));
    submit.disabled = true;
    submit.textContent = byName.get(head.value).pushed && !push_.checked ? 'Creating…' : 'Pushing and creating…';
    msg.replaceChildren();
    try {
      const { url } = await post('prs', { head: head.value, base: base.value, title: title.value, body: body.value, draft: draft.checked, push: push_.checked });
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      back();
      refresh(top());
      if (number) push('pr', { number, title: `#${number}` });
    } catch (err) {
      msg.replaceChildren(notice('error', err.message));
      submit.disabled = false;
      submit.textContent = 'Create pull request';
    }
  };

  return el('div', { class: 'g-form' },
    el('label', {}, 'From branch', head),
    pushNote,
    el('label', {}, 'Into', base),
    el('label', {}, 'Title', title),
    el('label', {}, 'Description', body),
    el('label', { class: 'g-check' }, draft, 'Create as draft'),
    pushRow,
    msg,
    submit);
}

// --- navigation --------------------------------------------------------------------------------

const SCREENS = {
  graph: renderGraph,
  commit: renderCommit,
  diff: renderDiff,
  changes: renderChanges,
  prs: renderPrs,
  pr: renderPr,
  prDiff: renderPrDiff,
  prCreate: renderPrCreate,
};
const TABS = { graph: 'Graph', changes: 'Changes', prs: 'Pull requests' };

const state = { repos: [], repo: null, tab: 'graph', started: false };
const stacks = Object.fromEntries(Object.keys(TABS).map((t) => [t, []]));
const root = el('section', { id: 'git' });
const repoSelect = el('select', { id: 'gitRepo', 'aria-label': 'Repository' });
const tabBar = el('nav', { class: 'g-tabs' });
const refreshBtn = el('button', { class: 'g-icon', 'aria-label': 'Refresh', onclick: () => top() && refresh(top()) }, '⟳');
const screensEl = el('div', { class: 'g-screens' });

const top = () => stacks[state.tab].at(-1);

async function refresh(screen) {
  const gen = (screen.gen = (screen.gen ?? 0) + 1);
  screen.reloaded = gen > 1;
  screen.body.replaceChildren(el('p', { class: 'g-empty' }, 'Loading…'));
  let content;
  try {
    content = await SCREENS[screen.name](screen);
  } catch (err) {
    content = [notice('error', err.message), el('button', { class: 'g-btn', onclick: () => refresh(screen) }, 'Retry')];
  }
  if (screen.gen === gen) screen.body.replaceChildren(...[content].flat().filter(Boolean));
}

function makeScreen(name, params) {
  const screen = { name, params, el: el('div', { class: 'g-screen' }), body: el('div', { class: 'g-screen-body' }) };
  if (params.title) {
    screen.el.append(el('div', { class: 'g-screen-head' },
      el('button', { class: 'g-back', onclick: back }, '‹ Back'),
      el('span', { class: 'g-screen-title' }, params.title)));
  }
  screen.el.append(screen.body);
  return screen;
}

function show() {
  const current = top();
  for (const s of screensEl.children) s.hidden = s !== current?.el;
}

function push(name, params = {}) {
  const screen = makeScreen(name, params);
  stacks[state.tab].push(screen);
  screensEl.append(screen.el);
  show();
  refresh(screen);
}

function back() {
  const stack = stacks[state.tab];
  if (stack.length < 2) return;
  stack.pop().el.remove();
  show();
  const current = top();
  if (current.stale) {
    current.stale = false;
    refresh(current);
  }
}

function selectTab(tab) {
  state.tab = tab;
  remember.set('pd.gitTab', tab);
  tabBar.replaceChildren(...Object.entries(TABS).map(([key, label]) => el('button', { class: key === tab ? 'on' : '', onclick: () => selectTab(key) }, label)));
  if (!stacks[tab].length) push(tab);
  show();
}

function selectRepo(repo) {
  state.repo = repo;
  remember.set('pd.gitRepo', repo);
  for (const stack of Object.values(stacks)) stack.splice(0).forEach((s) => s.el.remove());
  prDiffs.clear();
  selectTab(state.tab);
}

async function start() {
  state.started = true;
  screensEl.replaceChildren(el('p', { class: 'g-empty' }, 'Finding repositories…'));
  try {
    state.repos = await api('GET', '/api/git/repos');
  } catch (err) {
    screensEl.replaceChildren(notice('error', err.message));
    state.started = false;
    return;
  }
  screensEl.replaceChildren();
  if (!state.repos.length) {
    screensEl.append(empty('No git repositories found under the configured repoRoots.'));
    return;
  }
  const counts = new Map();
  for (const r of state.repos) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  repoSelect.replaceChildren(...state.repos.map((r) => el('option', { value: r.path, title: r.path },
    counts.get(r.name) > 1 ? `${r.name} (${r.path.split('/').slice(-2, -1)[0]})` : r.name)));
  const stored = remember.get('pd.gitRepo');
  repoSelect.value = state.repos.some((r) => r.path === stored) ? stored : state.repos[0].path;
  state.tab = Object.hasOwn(TABS, remember.get('pd.gitTab')) ? remember.get('pd.gitTab') : 'graph';
  selectRepo(repoSelect.value);
}

repoSelect.onchange = () => selectRepo(repoSelect.value);
root.append(el('div', { class: 'g-bar' }, tabBar, refreshBtn), screensEl);
document.getElementById('app').append(root);
document.querySelector('header').append(repoSelect);

window.addEventListener('pd:view', (e) => {
  if (e.detail === 'git' && !state.started) start();
});
if (document.getElementById('app').dataset.view === 'git') start();
