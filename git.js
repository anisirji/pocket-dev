import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const GRAPH_LIMIT_MAX = 1000;
const SCAN_DEPTH = 2;
const SCAN_TTL_MS = 10_000;

const ENV = {
  LANG: 'en_US.UTF-8',
  ...process.env,
  // launchd and nohup start node with a minimal PATH that lacks Homebrew, where git and gh usually live.
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`,
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function run(cmd, args, cwd, { status, okCodes = [0], timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: ENV, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      if (okCodes.includes(code)) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new HttpError(500, `${cmd} is not installed or not on PATH`));
      if (err.killed) return reject(new HttpError(504, `${cmd} ${args[0]} timed out after ${timeout / 1000}s`));
      reject(new HttpError(status, stderr.trim() || stdout.trim() || err.message));
    });
  });
}

// core.quotePath=false keeps non-ASCII paths readable instead of "\303\251"-escaped.
const git = (repo, args, opts = {}) => run('git', ['-c', 'core.quotePath=false', ...args], repo, { status: 400, ...opts });
const gh = (repo, args, opts = {}) => run('gh', args, repo, { status: 502, ...opts });
const ghJson = async (repo, args, opts) => JSON.parse(await gh(repo, args, opts));

function configuredRoots() {
  if (process.env.POCKET_DEV_REPO_ROOTS) return process.env.POCKET_DEV_REPO_ROOTS.split(':').filter(Boolean);
  try {
    const { repoRoots } = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
    if (Array.isArray(repoRoots)) return repoRoots.map((r) => r.replace(/^~(?=$|\/)/, os.homedir()));
  } catch {}
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'Desktop', 'Projects'), home];
}

function scanDir(dir, depth, found) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    found.set(dir, { name: path.basename(dir), path: dir });
    return;
  }
  if (depth === SCAN_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') scanDir(path.join(dir, e.name), depth + 1, found);
  }
}

let scanCache = { at: 0, repos: [] };
function scanRepos({ fresh = false } = {}) {
  if (!fresh && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.repos;
  const found = new Map();
  for (const root of configuredRoots()) scanDir(path.resolve(root), 0, found);
  const repos = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  scanCache = { at: Date.now(), repos };
  return repos;
}

function resolveRepo(value) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'repo is required');
  const repo = scanRepos().find((r) => r.path === value) ?? scanRepos({ fresh: true }).find((r) => r.path === value);
  if (!repo) throw new HttpError(403, `Not a known repository: ${value}`);
  return repo.path;
}

const HASH = /^[0-9a-f]{4,40}$/i;
function parseHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new HttpError(400, 'hash must be a hex commit id');
  return value;
}

function parsePrNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'number must be a positive integer');
  return String(n);
}

function parseEnum(value, table, field) {
  if (!Object.hasOwn(table, value)) throw new HttpError(400, `${field} must be one of: ${Object.keys(table).join(', ')}`);
  return table[value];
}

function parsePath(value) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'path is required');
  return value;
}

function parseRef(decoration) {
  const head = /^HEAD -> refs\/heads\/(.+)$/.exec(decoration);
  if (head) return { name: head[1], kind: 'head' };
  if (decoration === 'HEAD') return { name: 'HEAD', kind: 'head' };
  const tag = /^tag: refs\/tags\/(.+)$/.exec(decoration);
  if (tag) return { name: tag[1], kind: 'tag' };
  if (decoration.startsWith('refs/heads/')) return { name: decoration.slice(11), kind: 'branch' };
  if (decoration.startsWith('refs/remotes/')) return { name: decoration.slice(13), kind: 'remote' };
  return null;
}

async function graph({ repo, q }) {
  const limit = Math.min(Math.max(Number(q.get('limit')) || 300, 1), GRAPH_LIMIT_MAX);
  const skip = Math.max(Number(q.get('skip')) || 0, 0);
  const out = await git(repo, [
    'log', '--exclude=refs/stash', '--all', '--date-order', '--decorate=full', `-n${limit}`, `--skip=${skip}`,
    '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e',
  ]);
  const commits = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [hash, parents, author, time, subject, refs] = record.split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time),
      subject,
      refs: refs ? refs.split(', ').map(parseRef).filter(Boolean) : [],
    };
  });
  return { commits, hasMore: commits.length === limit };
}

function splitZ(out) {
  const parts = out.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

// --name-status -z: "M\0path\0" or "R100\0old\0new\0".
function parseNameStatus(out) {
  const parts = splitZ(out);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (/^[RC]/.test(code)) files.push({ status: code[0], origPath: parts[i++], path: parts[i++] });
    else files.push({ status: code[0], path: parts[i++] });
  }
  return files;
}

// --numstat -z: "a\td\tpath\0" or, for renames, "a\td\t\0old\0new\0". Binary files report "-".
function parseNumstat(out) {
  const parts = splitZ(out);
  const stats = new Map();
  const count = (s) => (s === '-' ? null : Number(s));
  for (let i = 0; i < parts.length;) {
    const [added, deleted, p] = parts[i++].split('\t');
    const file = p || (i++, parts[i++]);
    stats.set(file, { added: count(added), deleted: count(deleted) });
  }
  return stats;
}

// first-parent diffs make merge commits show what the merge brought in, and root commits diff against empty.
const COMMIT_DIFF = ['show', '--diff-merges=first-parent', '-M', '--format='];

async function commit({ repo, q }) {
  const hash = parseHash(q.get('hash'));
  const [meta, names, nums] = await Promise.all([
    git(repo, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B', hash, '--']),
    git(repo, [...COMMIT_DIFF, '--name-status', '-z', hash, '--']),
    git(repo, [...COMMIT_DIFF, '--numstat', '-z', hash, '--']),
  ]);
  const [full, parents, author, email, time, message] = meta.split('\x1f');
  const stats = parseNumstat(nums);
  return {
    hash: full,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    time: Number(time),
    message: message.trimEnd(),
    files: parseNameStatus(names).map((f) => ({ ...f, added: null, deleted: null, ...stats.get(f.path) })),
  };
}

const DIFF_SOURCES = {
  commit: (q, paths) => [...COMMIT_DIFF, parseHash(q.get('hash')), '--', ...paths],
  staged: (_q, paths) => ['diff', '--cached', '-M', '--', ...paths],
  unstaged: (_q, paths) => ['diff', '--', ...paths],
  untracked: (_q, paths) => ['diff', '--no-index', '--', '/dev/null', paths[0]],
};

async function diff({ repo, q }) {
  const build = parseEnum(q.get('source') ?? 'commit', DIFF_SOURCES, 'source');
  const paths = [parsePath(q.get('path'))];
  if (q.get('origPath')) paths.push(q.get('origPath'));
  // --no-index exits 1 when the files differ, which for an untracked file is always.
  const text = await git(repo, build(q, paths), { okCodes: [0, 1] });
  return { text };
}

const code = (c) => (c === '.' ? null : c);

// porcelain v2 -z: "1 XY ... path", "2 XY ... score path\0origPath", "u XY ... path", "? path".
function parseStatus(out) {
  const status = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = splitZ(out);
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('# branch.head ')) status.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) status.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(line);
      Object.assign(status, { ahead: Number(ahead), behind: Number(behind) });
    } else if (line.startsWith('1 ')) {
      status.files.push({ path: line.split(' ').slice(8).join(' '), staged: code(line[2]), unstaged: code(line[3]), untracked: false });
    } else if (line.startsWith('2 ')) {
      status.files.push({ path: line.split(' ').slice(9).join(' '), origPath: parts[++i], staged: code(line[2]), unstaged: code(line[3]), untracked: false });
    } else if (line.startsWith('u ')) {
      status.files.push({ path: line.split(' ').slice(10).join(' '), staged: null, unstaged: 'U', untracked: false });
    } else if (line.startsWith('? ')) {
      status.files.push({ path: line.slice(2), staged: null, unstaged: null, untracked: true });
    }
  }
  if (status.branch === '(detached)') status.branch = null;
  return status;
}

async function status({ repo }) {
  return parseStatus(await git(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
}

async function defaultBranch(repo) {
  try {
    const { defaultBranchRef } = await ghJson(repo, ['repo', 'view', '--json', 'defaultBranchRef']);
    if (defaultBranchRef?.name) return defaultBranchRef.name;
  } catch {}
  try {
    return (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  } catch {}
  return 'main';
}

async function branches({ repo }) {
  const [refs, current, base] = await Promise.all([
    git(repo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(contents:subject)']),
    git(repo, ['branch', '--show-current']),
    defaultBranch(repo),
  ]);
  const list = refs.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, track, subject] = line.split('\x1f');
    const gone = track === 'gone';
    return {
      name,
      upstream: upstream || null,
      pushed: Boolean(upstream) && !gone,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      subject,
    };
  });
  return { current: current.trim() || null, defaultBranch: base, branches: list };
}

const CHECK_STATES = {
  SUCCESS: 'pass', NEUTRAL: 'pass', SKIPPED: 'pass',
  FAILURE: 'fail', ERROR: 'fail', CANCELLED: 'fail', TIMED_OUT: 'fail', ACTION_REQUIRED: 'fail', STARTUP_FAILURE: 'fail', STALE: 'fail',
  PENDING: 'pending', EXPECTED: 'pending', QUEUED: 'pending', IN_PROGRESS: 'pending',
};

// statusCheckRollup mixes CheckRun (status + conclusion) and StatusContext (state) entries.
function normalizeCheck(c) {
  const raw = c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : c.status;
  return { name: c.name || c.context || 'check', state: CHECK_STATES[raw] ?? 'pending', url: c.detailsUrl || c.targetUrl || null };
}

export function summarizeChecks(rollup = []) {
  const items = rollup.map(normalizeCheck);
  const n = (s) => items.filter((c) => c.state === s).length;
  const summary = { passed: n('pass'), failed: n('fail'), pending: n('pending') };
  const state = summary.failed ? 'fail' : summary.pending ? 'pending' : summary.passed ? 'pass' : 'none';
  return { state, ...summary, items };
}

const login = (author) => author?.login ?? 'ghost';

async function prs({ repo }) {
  const list = await ghJson(repo, [
    'pr', 'list', '--state', 'open', '--limit', '50',
    '--json', 'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt,url',
  ]);
  return list.map(({ author, statusCheckRollup, ...pr }) => {
    const { items, ...checks } = summarizeChecks(statusCheckRollup);
    return { ...pr, author: login(author), checks };
  });
}

const PR_VIEW_FIELDS = 'number,title,body,author,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,files,url,additions,deletions,comments';

async function pr({ repo, q }) {
  const p = await ghJson(repo, ['pr', 'view', parsePrNumber(q.get('number')), '--json', PR_VIEW_FIELDS]);
  return {
    ...p,
    author: login(p.author),
    checks: summarizeChecks(p.statusCheckRollup),
    statusCheckRollup: undefined,
    reviews: p.reviews.map((r) => ({ author: login(r.author), state: r.state, body: r.body, at: r.submittedAt })),
    comments: p.comments.map((c) => ({ author: login(c.author), body: c.body, at: c.createdAt })),
    files: p.files.map(({ path: file, additions, deletions }) => ({ path: file, additions, deletions })),
  };
}

async function prDiff({ repo, q }) {
  return { text: await gh(repo, ['pr', 'diff', parsePrNumber(q.get('number')), '--color', 'never']) };
}

const REVIEW_EVENTS = { approve: '--approve', request_changes: '--request-changes', comment: '--comment' };
const MERGE_METHODS = { merge: '--merge', squash: '--squash', rebase: '--rebase' };

async function reviewPr({ repo, body }) {
  const number = parsePrNumber(body.number);
  const flag = parseEnum(body.event, REVIEW_EVENTS, 'event');
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text && flag !== '--approve') throw new HttpError(400, 'A comment or change request needs a message');
  const out = await gh(repo, ['pr', 'review', number, flag, ...(text ? ['--body', text] : [])], { status: 409 });
  return { ok: true, message: out.trim() };
}

// gh's own --delete-branch also deletes the local branch and may switch the working tree, so only the
// remote ref is removed here.
async function mergePr({ repo, body }) {
  const number = parsePrNumber(body.number);
  const flag = parseEnum(body.method, MERGE_METHODS, 'method');
  const headSha = body.headSha === undefined ? null : parseHash(body.headSha);
  const head = body.deleteBranch ? await ghJson(repo, ['pr', 'view', number, '--json', 'headRefName,isCrossRepository']) : null;
  const out = await gh(repo, ['pr', 'merge', number, flag, ...(headSha ? ['--match-head-commit', headSha] : [])], { status: 409 });
  const result = { ok: true, message: out.trim(), branchDeleted: false, deleteError: null };
  if (!head) return result;
  if (head.isCrossRepository) {
    result.deleteError = `Not deleting ${head.headRefName}: it lives in a fork.`;
    return result;
  }
  try {
    const { nameWithOwner } = await ghJson(repo, ['repo', 'view', '--json', 'nameWithOwner']);
    await gh(repo, ['api', '-X', 'DELETE', `repos/${nameWithOwner}/git/refs/heads/${head.headRefName}`]);
    result.branchDeleted = true;
  } catch (err) {
    result.deleteError = err.message;
  }
  return result;
}

const prState = (verb) => async ({ repo, body }) => {
  const out = await gh(repo, ['pr', verb, parsePrNumber(body.number)], { status: 409 });
  return { ok: true, message: out.trim() };
};

async function createPr({ repo, body }) {
  const { branches: list, defaultBranch: base0 } = await branches({ repo });
  const head = list.find((b) => b.name === body.head);
  if (!head) throw new HttpError(400, `Unknown branch: ${body.head}`);
  const base = body.base ?? base0;
  if (base !== base0 && !list.some((b) => b.name === base)) throw new HttpError(400, `Unknown base branch: ${base}`);
  if (base === head.name) throw new HttpError(400, 'Head and base are the same branch');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) throw new HttpError(400, 'Title is required');
  const text = typeof body.body === 'string' ? body.body : '';
  const pushed = body.push === true || !head.pushed;
  if (pushed) await git(repo, ['push', '-u', 'origin', head.name], { status: 502, timeout: PUSH_TIMEOUT_MS });
  const out = await gh(repo, [
    'pr', 'create', '--head', head.name, '--base', base, '--title', title, '--body', text, ...(body.draft === true ? ['--draft'] : []),
  ], { status: 409 });
  return { url: out.trim().split('\n').at(-1), pushed };
}

const ROUTES = {
  'GET graph': graph,
  'GET commit': commit,
  'GET diff': diff,
  'GET status': status,
  'GET branches': branches,
  'GET prs': prs,
  'GET pr': pr,
  'GET pr/diff': prDiff,
  'POST prs': createPr,
  'POST pr/review': reviewPr,
  'POST pr/merge': mergePr,
  'POST pr/close': prState('close'),
  'POST pr/reopen': prState('reopen'),
};

// Returns { status, body } so server.js keeps owning HTTP and auth; readBody parses the JSON request body.
export async function handleGitApi(method, url, readBody) {
  const key = `${method} ${url.pathname.replace(/^\/api\/git\//, '')}`;
  try {
    if (key === 'GET repos') return { status: 200, body: scanRepos({ fresh: true }) };
    const route = ROUTES[key];
    if (!route) return { status: 404, body: { error: 'Not found' } };
    const repo = resolveRepo(url.searchParams.get('repo'));
    const body = method === 'POST' ? await readBody() : {};
    return { status: 200, body: await route({ repo, q: url.searchParams, body }) };
  } catch (err) {
    return { status: err.status ?? 400, body: { error: err.message } };
  }
}
