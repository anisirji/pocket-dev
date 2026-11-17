import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, STATE_DIR } from './paths.js';

// Pocket Dev looks up its own newest version on the npm registry and, when a person asks, installs it. The only thing
// that goes out is one GET for the package's latest version: no account, no identifier, nothing about this computer.
// Installing software stays an action taken in a terminal on the computer itself, never from the phone.

export const PACKAGE = '@anisirji/pocket-dev';
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}/latest`;
export const UPDATE_COMMAND = 'pocket-dev update';
export const INSTALL_ARGS = ['install', '-g', `${PACKAGE}@latest`];
export const CHECK_TTL_MS = 6 * 60 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
// The Admin page asks for a fresh look when the last one is older than this.
export const ADMIN_FRESH_MS = 60 * 60_000;
export const CACHE_FILE = 'update-check.json';
export const RELEASES_URL = 'https://github.com/anisirji/pocket-dev/releases';
export const EACCES_HELP_URL = 'https://github.com/anisirji/pocket-dev/blob/main/docs/INSTALL_BEGINNERS.md';

// ---- Versions -----------------------------------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(text) {
  const m = SEMVER.exec(String(text ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const comparePre = (a, b) => {
  const aNum = /^\d+$/.test(a), bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
};

// -1, 0 or 1, or null when either side is not a version. A release is newer than its own prerelease (1.2.0 > 1.2.0-rc.1).
export function compareVersions(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = comparePre(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return 0;
}

export const isNewer = (latest, current) => compareVersions(latest, current) === 1;

export function readInstalledVersion(root = PACKAGE_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

// ---- The registry -------------------------------------------------------------------------------------------------

// Resolves the newest published version. Rejects with an Error whose `kind` is "offline" (no answer) or "registry"
// (an answer that is not a version). `POCKET_DEV_UPDATE_URL` replaces the address, for tests only.
export async function fetchLatest({ fetch: request = fetch, url = process.env.POCKET_DEV_UPDATE_URL || REGISTRY_URL, timeoutMs = 5000 } = {}) {
  let res;
  try {
    res = await request(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (cause) {
    throw Object.assign(new Error('the npm registry did not answer'), { kind: 'offline', cause });
  }
  if (!res.ok) throw Object.assign(new Error(`the npm registry answered ${res.status}`), { kind: 'registry' });
  const data = await res.json().catch(() => null);
  if (!parseSemver(data?.version)) throw Object.assign(new Error('the npm registry sent no version'), { kind: 'registry' });
  return data.version;
}

// ---- How this copy was installed ----------------------------------------------------------------------------------

// 'global': an npm global install, which `npm install -g` replaces. 'npx': a throwaway npx copy. 'local': inside some
// project's node_modules. 'source': a git checkout or `npm link`, which npm cannot replace.
export function installKind(root = PACKAGE_ROOT, { realpath = fs.realpathSync, globalRoot = null, sep = path.sep } = {}) {
  let real = root;
  try { real = realpath(root); } catch { /* keep the given path */ }
  if (real.includes(`${sep}_npx${sep}`)) return 'npx';
  if (!real.includes(`${sep}node_modules${sep}`)) return 'source';
  if (globalRoot) return real.startsWith(globalRoot + sep) ? 'global' : 'local';
  return 'global';
}

export function notInstalledByNpm(kind) {
  if (kind === 'npx') return 'This copy runs through npx, which fetches the newest version each time. Run it as: npx -y @anisirji/pocket-dev@latest start';
  if (kind === 'local') return `This copy is installed inside a project, so it is updated there: npm install ${PACKAGE}@latest`;
  return `This copy runs from a source folder (a git checkout or npm link), so it does not update itself. Update it with git pull, or install the package instead: npm install -g ${PACKAGE}`;
}

export const permissionHelp = () => [
  'npm could not write to its global folder (permission denied). Do not use sudo.',
  'Point npm at a folder in your home directory once, then run pocket-dev update again. The steps are in',
  `"EACCES permission denied" in docs/INSTALL_BEGINNERS.md: ${EACCES_HELP_URL}`,
];

// ---- The updater --------------------------------------------------------------------------------------------------

// Every outside action is a parameter, so tests never touch the network, npm or a real service.
export function createUpdater({
  version = readInstalledVersion(), root = PACKAGE_ROOT, env = process.env, fetchLatest: lookup = fetchLatest,
  run, globalRoot = async () => null, hasService = async () => false, restartService = async () => ({ ok: false }),
  reexec = async () => 1, readVersion = () => readInstalledVersion(root), realpath = fs.realpathSync,
} = {}) {
  const kind = async () => installKind(root, { realpath, globalRoot: await globalRoot() });
  return {
    version,
    kind,
    // The passive check and the setup step stay quiet when the person turned the check off, when this copy is not an
    // npm global install, or when setup already re-ran itself from the new install.
    async skipReason() {
      if (env.POCKET_DEV_UPDATED) return 'updated';
      if (updateCheckOff(env)) return 'off';
      const k = await kind();
      return k === 'global' ? null : k;
    },
    async check() {
      try {
        const latest = await lookup();
        return { current: version, latest, newer: isNewer(latest, version), error: null };
      } catch (err) {
        return { current: version, latest: null, newer: false, error: err.message || 'the npm registry could not be reached' };
      }
    },
    // Runs npm and reports what happened. `output` is what npm printed, for the person to see.
    async install() {
      const service = await hasService();
      const r = await run('npm', INSTALL_ARGS);
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      if (r.code !== 0) {
        const denied = /EACCES|EPERM|permission denied/i.test(output + (r.error?.message ?? ''));
        return { ok: false, output, denied, error: r.error ? String(r.error.message) : `npm exited with code ${r.code}` };
      }
      let to = null;
      try { to = readVersion(); } catch { /* the package file moved; say so below */ }
      return { ok: true, output, from: version, to, hadService: service };
    },
    async restart() { return restartService(); },
    reexec,
  };
}

// Reads the opt-out. `config` is optional because the command line has no config open.
export function updateCheckOff(env = process.env, config = null) {
  const v = env.POCKET_DEV_NO_UPDATE_CHECK;
  if (v && v !== '0' && v.toLowerCase() !== 'false') return true;
  return config?.read?.().updateCheck === false;
}

function parseUpdateArgs(args) {
  const opts = { check: false, yes: false, error: null };
  for (const a of args) {
    if (a === '--check' || a === '--dry-run') opts.check = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else opts.error = `Unknown option "${a}". Usage: pocket-dev update [--check] [--yes]`;
  }
  return opts;
}

// `pocket-dev update`. Returns the exit code. ctx: out, isTTY, ask(question, default), update (a createUpdater).
export async function updateCommand(args, ctx) {
  const opts = parseUpdateArgs(args);
  if (opts.error) { ctx.out(opts.error); return 2; }
  const u = ctx.update;
  const kind = await u.kind();
  if (kind !== 'global') { ctx.out(notInstalledByNpm(kind)); return 0; }
  const r = await u.check();
  if (r.error) {
    ctx.out(`Could not check for a newer version: ${r.error}. Nothing was changed. Check the internet connection and try again.`);
    return 1;
  }
  if (!r.newer) {
    ctx.out(`Pocket Dev ${r.current} is up to date${compareVersions(r.current, r.latest) === 1 ? ` (it is newer than the ${r.latest} on npm)` : ''}.`);
    return 0;
  }
  ctx.out(`Version ${r.latest} is available, you have ${r.current}.`);
  if (opts.check) { ctx.out(`Install it with: ${UPDATE_COMMAND}`); return 0; }
  if (!opts.yes) {
    if (!ctx.isTTY) { ctx.out(`This is not an interactive terminal, so nothing was installed. Run ${UPDATE_COMMAND} --yes to install it.`); return 0; }
    if (!(await ctx.ask('Update now? [Y/n] ', true))) { ctx.out('Not updated.'); return 0; }
  }
  return runInstall(ctx);
}

// Installs, shows npm's output, then restarts the background service when there is one. Returns the exit code.
export async function runInstall(ctx) {
  const u = ctx.update;
  ctx.out(`Running: npm ${INSTALL_ARGS.join(' ')}`);
  const r = await u.install();
  if (r.output) ctx.out(r.output);
  if (!r.ok) {
    if (r.denied) for (const line of permissionHelp()) ctx.out(line);
    else ctx.out(`The update did not finish: ${r.error}. Pocket Dev was not changed.`);
    return 1;
  }
  ctx.out(r.to && r.to !== r.from ? `Updated Pocket Dev ${r.from} to ${r.to}.` : 'npm finished.');
  if (r.hadService) {
    const s = await u.restart();
    ctx.out(s.ok ? 'Restarted the background service, so it now runs the new version.' : 'Restart the background service to use it: pocket-dev service restart');
  } else ctx.out('If Pocket Dev is running in a terminal, stop it and run pocket-dev start to use the new version.');
  ctx.out(`What changed: ${RELEASES_URL}`);
  return 0;
}

// The first step of `pocket-dev setup` and the first-run guide. Returns { code } when setup re-ran itself from the new
// install (the caller then exits with that code), and null when setup should carry on here.
export async function latestVersionStep(ctx, opts) {
  const u = ctx.update;
  if (!u || opts.only || (await u.skipReason())) return null;
  const result = await versionStepBody(ctx, opts, u);
  if (!result) ctx.out('');
  return result;
}

async function versionStepBody(ctx, opts, u) {
  ctx.out('Latest version');
  const r = await u.check();
  if (r.error) { ctx.out(`  Could not check for a newer version (${r.error}). Carrying on with ${r.current}.`); return null; }
  if (!r.newer) { ctx.out(`  Pocket Dev ${r.current} is the latest version.`); return null; }
  ctx.out(`  Version ${r.latest} is available, you have ${r.current}.`);
  if (opts.check || !ctx.isTTY) { ctx.out(`  Update with: ${UPDATE_COMMAND}`); return null; }
  if (opts.dry) { ctx.out(`  Dry run: would run npm ${INSTALL_ARGS.join(' ')}, then setup again from the new version.`); return null; }
  if (!opts.yes && !(await ctx.ask('Update now? [Y/n] ', true))) { ctx.out(`  Not updated. You can update later with: ${UPDATE_COMMAND}`); return null; }
  const code = await runInstall(ctx);
  if (code !== 0) { ctx.out('Carrying on with the version you have.'); return null; }
  ctx.out('Running setup again from the new version.');
  ctx.out('');
  return { code: await u.reexec() };
}

// ---- The quiet check inside the server ----------------------------------------------------------------------------

// Looks up the newest version at most every six hours (a failed look-up is tried again after an hour) and keeps the answer
// in the state folder. `view()` never waits for the network; it answers from the last result.
export function createVersionCheck({
  version = readInstalledVersion(), stateDir = STATE_DIR, env = process.env, config = null, now = Date.now,
  lookup = fetchLatest, kind = 'global', log = () => {},
} = {}) {
  const file = path.join(stateDir, CACHE_FILE);
  let cache = { checkedAt: 0, latest: null, failedAt: 0 };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* no cache yet */ }
  let pending = null;
  const enabled = () => !updateCheckOff(env, config);
  const due = (maxAgeMs) => {
    if (cache.latest && now() - cache.checkedAt < maxAgeMs) return false;
    return !(cache.failedAt && now() - cache.failedAt < RETRY_AFTER_FAILURE_MS);
  };

  // `maxAgeMs` lets a caller that wants fresher news than the usual schedule (the Admin page) ask for it.
  async function refresh({ maxAgeMs = CHECK_TTL_MS } = {}) {
    if (!enabled() || !due(maxAgeMs)) return view();
    pending ??= (async () => {
      try {
        const latest = await lookup();
        cache = { checkedAt: now(), latest, failedAt: 0 };
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ checkedAt: cache.checkedAt, latest }) + '\n', { mode: 0o600 });
      } catch (err) {
        cache = { ...cache, failedAt: now() };
        log(`update check failed: ${err.message}`);
      } finally { pending = null; }
    })();
    await pending;
    return view();
  }

  // Compared with the running version every time, so an update that was just installed stops showing as available.
  function view() {
    if (!enabled() || !cache.latest) return null;
    return {
      current: version, latest: cache.latest, available: isNewer(cache.latest, version), checkedAt: cache.checkedAt,
      command: kind === 'global' ? UPDATE_COMMAND : null,
    };
  }

  // A look now and then while the server runs; each one is a no-op until the six hours are up.
  function start({ everyMs = 30 * 60_000 } = {}) {
    void refresh();
    const timer = setInterval(() => void refresh(), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { refresh, view, start, enabled, version };
}

// The one line `pocket-dev start` and `pocket-dev admin` print when the last look-up found a newer version. It reads
// only the saved answer, so a command never waits for the network. Null when there is nothing to say or the check is off.
export function cachedUpdateLine({ version = readInstalledVersion(), stateDir = STATE_DIR, env = process.env, config = null } = {}) {
  if (updateCheckOff(env, config)) return null;
  let latest = null;
  try { latest = JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_FILE), 'utf8')).latest; } catch { return null; }
  return isNewer(latest, version) ? `Pocket Dev ${latest} is available (you have ${version}). Update with: ${UPDATE_COMMAND}` : null;
}
