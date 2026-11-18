// Moves the loose root modules into src/<area>/ and the service, power and browser-check scripts into subfolders,
// then rewrites every relative path that crosses a moved boundary. Run from the repository root on a clean tree:
//   node tools/restructure.mjs --dry   prints each rewrite and changes nothing
//   node tools/restructure.mjs         applies the moves and rewrites and stages them
// Paths spelled as path.join segments ('scripts', 'x.sh') are not rewritten; the follow-up commits fix those by hand.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AREAS = {
  core: ['config', 'config-keys', 'paths', 'platform', 'platform-service', 'launchd', 'startup', 'pty-loader', 'security-log'],
  auth: ['auth', 'access', 'collaborators', 'permissions', 'peer-guard', 'admin', 'modes'],
  conversations: ['history', 'takeover', 'takeover-windows', 'antigravity-history', 'copilot-history', 'terminal-agents'],
  terminals: ['terminals', 'terminal-host'],
  workspace: ['files', 'folder-browser', 'git'],
  machine: ['apps', 'health', 'performance', 'power', 'screen', 'desktop-notify'],
  network: ['network', 'tunnel', 'forward', 'remote-ports', 'transport', 'qr'],
  rooms: ['room', 'room-sync', 'sync-log', 'tasks', 'messages'],
  setup: ['setup', 'doctor', 'greeting', 'taskbar-pin', 'update', 'update-runner'],
};
const SCRIPT_DIRS = {
  service: ['autostart.sh', 'install-service.sh', 'uninstall-service.sh', 'status.sh', 'service-common.sh', 'service-plist.js', 'windows-install.ps1', 'update-check.sh'],
  power: ['lid.sh', 'sleep.sh', 'shutdown.sh', 'power-common.sh', 'awake.js'],
};
const BROWSER_CHECKS = ['check-responsive', 'check-unified-chats', 'check-engine-dropdown', 'check-file-picker', 'check-held-chat'];

const FILE_MOVES = new Map([
  ['server.js', 'src/server.js'],
  ['PRODUCT.md', 'docs/PRODUCT.md'],
  ...Object.entries(AREAS).flatMap(([area, names]) => names.map((n) => [`${n}.js`, `src/${area}/${n}.js`])),
  ...Object.entries(SCRIPT_DIRS).flatMap(([dir, names]) => names.map((n) => [`scripts/${n}`, `scripts/${dir}/${n}`])),
  ...BROWSER_CHECKS.map((n) => [`scripts/${n}.mjs`, `test/browser/${n}.mjs`]),
]);
const DIR_MOVES = new Map([['chat', 'src/chat']]);
// Installed services run <package root>/server.js, so the root keeps an entry point that loads the moved server.
const SHIM = "// Installed background services run <package root>/server.js; the server itself lives in src/.\nimport './src/server.js';\n";

const TEXT = /\.(js|mjs|cjs|sh|ps1|json|md|html|txt|yml|yaml)$/;
const JS = /\.(js|mjs|cjs)$/;
// Release notes are history; their file mentions stay as they were written. This tool names the old paths on purpose.
const FROZEN = /^tools\/restructure\.mjs$|^docs\/RELEASE_|^public\/vendor\/|^package-lock\.json$/;

const dry = process.argv.includes('--dry');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

if (fs.existsSync('src/server.js')) {
  console.log('Already applied: src/server.js exists.');
  process.exit(0);
}

const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const files = new Set(tracked);
const dirs = new Set(['']);
for (const f of tracked) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
for (const old of [...FILE_MOVES.keys(), ...DIR_MOVES.keys()]) if (!files.has(old) && !dirs.has(old)) throw new Error(`${old} is not tracked`);

function moved(p) {
  if (FILE_MOVES.has(p)) return FILE_MOVES.get(p);
  for (const [from, to] of DIR_MOVES) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
}

const dirOf = (f) => (path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f));

// Re-points a path written relative to `file` at the same target after both may have moved. Null when the text does
// not name a tracked file or folder below the repository root.
function repoint(file, rel) {
  const [, body, suffix] = rel.match(/^([^?#]*)(.*)$/);
  const target = path.posix.normalize(path.posix.join(dirOf(file), body)).replace(/\/$/, '').replace(/^\.$/, '');
  if (target.startsWith('..') || (!files.has(target) && !dirs.has(target))) return null;
  const from = dirOf(moved(file));
  let out = path.posix.relative(from, moved(target)) || '.';
  if (!out.startsWith('.')) out = `./${out}`;
  if (body.endsWith('/') && !out.endsWith('/')) out += '/';
  return out + suffix;
}

const ROOT_TOKENS = [...FILE_MOVES.keys()].filter((p) => p.includes('/') || p === 'PRODUCT.md')
  .concat(tracked.filter((f) => [...DIR_MOVES.keys()].some((d) => f.startsWith(`${d}/`))));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A repository-root path written in prose, a command or a CI step: scripts/sleep.sh, scripts\windows-install.ps1.
const ROOT_TOKEN = new RegExp(`(?<![\\w./\\\\])(?<!\\w-)(${ROOT_TOKENS.map((t) => escape(t).replace('/', '[/\\\\]')).join('|')})(?![\\w/-])`, 'g');

const log = [];
function rewrite(file, text) {
  const note = (from, to) => { if (from !== to) log.push(`${file}: ${from} -> ${to}`); return to; };
  if (JS.test(file)) {
    text = text.replace(/(['"`])(\.\.?\/[^'"`\s$?#]*)(?=[?#'"`])/g, (all, q, rel) => {
      const out = repoint(file, rel);
      return out && out !== rel ? note(all, q + out) : all;
    });
  }
  if (file.endsWith('.md')) {
    text = text.replace(/\]\((?!https?:|#|\/|mailto:)([^)\s]+)\)/g, (all, rel) => {
      const out = repoint(file, rel.startsWith('.') ? rel : `./${rel}`);
      if (!out) return all;
      const clean = rel.startsWith('.') ? out : out.replace(/^\.\//, '');
      return note(all, `](${clean})`);
    });
  }
  text = text.replace(ROOT_TOKEN, (all) => note(all, moved(all.replace('\\', '/')).replaceAll('/', all.includes('\\') ? '\\' : '/')));
  const depth = moved(file).split('/').length - file.split('/').length;
  if (depth > 0 && file.endsWith('.sh')) {
    text = text.replace(/"\$\(dirname "\$0"\)\/\.\."/g, (all) => note(all, `"$(dirname "$0")/..${'/..'.repeat(depth)}"`));
  }
  if (depth > 0 && file.endsWith('.ps1')) {
    text = text.replace(/Split-Path -Parent \$PSScriptRoot/g, (all) => note(all, 'Split-Path -Parent (Split-Path -Parent $PSScriptRoot)'));
  }
  return text;
}

const updates = new Map();
for (const file of tracked) {
  if (!TEXT.test(file) || FROZEN.test(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = rewrite(file, before);
  if (after !== before) updates.set(file, after);
}

console.log(log.join('\n'));
console.log(`${log.length} rewrites in ${updates.size} files; ${FILE_MOVES.size} files and ${DIR_MOVES.size} folder move.`);
if (dry) process.exit(0);

for (const to of new Set([...FILE_MOVES.values(), ...DIR_MOVES.values()].map((p) => path.posix.dirname(p)))) fs.mkdirSync(to, { recursive: true });
for (const [from, to] of [...FILE_MOVES, ...DIR_MOVES]) git('mv', from, to);
for (const [file, text] of updates) fs.writeFileSync(moved(file), text);
fs.writeFileSync('server.js', SHIM);
git('add', '--', 'server.js', ...[...updates.keys()].map(moved));
