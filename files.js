import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const GB = 1024 ** 3;
const LIST_MAX = 2000;
const SEARCH_DEPTH = 4;
const SEARCH_MAX = 500;
const SEARCH_BUDGET_MS = 2000;
const SEARCH_SKIP = new Set(['node_modules', '.git']);
const ZIP_WALK_BUDGET_MS = 10_000;
const ZIP_MAX_ENTRIES = 200_000;
const UPLOAD_PREFIX = '.pocket-dev-upload-';
const QUICK = ['Desktop', 'Downloads', 'Documents'];

const TEXT_EXTS = 'txt md markdown log csv tsv ini cfg conf toml yaml yml env sh bash zsh fish py rb go rs java kt kts swift c h cc cpp hpp m mm cs php pl lua r sql ts tsx jsx mjs cjs vue svelte scss sass less gitignore dockerfile makefile lock diff patch';
const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  bz2: 'application/x-bzip2', xz: 'application/x-xz', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  dmg: 'application/x-apple-diskimage', ...Object.fromEntries(TEXT_EXTS.split(' ').map((e) => [e, 'text/plain'])),
};
const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

// Inline responses come from the Pocket Dev origin, so a previewed file must not run script there: markup is served
// as text, and every response gets a CSP sandbox (Chrome's PDF viewer still renders under it).
const INLINE_AS_IS = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/;
function inlineType(mime) {
  if (INLINE_AS_IS.test(mime) || mime === 'image/svg+xml') return mime;
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text/plain; charset=utf-8';
  return mime;
}

class FileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new FileError(status, message); };

const PERMISSION_HINT = 'macOS blocked access. To allow it, give node Full Disk Access in System Settings > Privacy & Security.';
const ERRNO = {
  ENOENT: [404, 'Not found.'],
  ENOTDIR: [400, 'Not a folder.'],
  EISDIR: [400, 'That is a folder.'],
  EEXIST: [409, 'Something with that name already exists.'],
  EACCES: [403, PERMISSION_HINT],
  EPERM: [403, PERMISSION_HINT],
  ENOSPC: [507, 'The Mac is out of disk space.'],
  ENAMETOOLONG: [400, 'Name is too long.'],
};

function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) fail(400, 'Enter a name.');
  if (name === '.' || name === '..') fail(400, 'A name cannot be "." or "..".');
  if (name.includes('/')) fail(400, 'A name cannot contain "/".');
  if (/[\x00-\x1f\x7f]/.test(name)) fail(400, 'A name cannot contain control characters.');
  if (Buffer.byteLength(name) > 255) fail(400, 'A name can be at most 255 bytes.');
  return name;
}

function* candidateNames(name) {
  yield name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; ; n++) yield `${base} (${n})${ext}`;
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

// link() fails with EEXIST instead of replacing, so the name is claimed atomically. Volumes without hard links
// (exFAT, SMB) fall back to check-then-rename.
async function claimName(dir, name, tmp) {
  for (const candidate of candidateNames(name)) {
    const dest = path.join(dir, candidate);
    try {
      await fsp.link(tmp, dest);
      return dest;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(err.code)) throw err;
      if (await exists(dest)) continue;
      await fsp.rename(tmp, dest);
      return dest;
    }
  }
}

// Only one range is honored; a multi-range or malformed header gets the whole file, which RFC 9110 allows.
function rangeOf(header, size) {
  const whole = { status: 200, start: 0, end: size - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return whole;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return { status: 416 };
  return { status: 206, start, end };
}

const encode5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const disposition = (kind, name) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encode5987(name)}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const SORTS = {
  name: byName,
  mtime: (a, b) => b.mtime - a.mtime || byName(a, b),
  size: (a, b) => b.size - a.size || byName(a, b),
};
const isDirish = (e) => e.type === 'dir' || e.linkType === 'dir';

const positive = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
const expandHome = (p, home) => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);

// NSFileManager's trashItemAtURL needs no permission and uses the Trash of the item's own volume. Asking Finder
// through osascript ("tell application Finder to delete") needs an Automation grant, which a launchd agent cannot
// get from a phone. Paths arrive as argv, so nothing is spliced into the script.
const TRASH_SCRIPT = `function run(argv) {
  ObjC.import('Foundation');
  const fm = $.NSFileManager.defaultManager;
  return JSON.stringify(argv.map((p) => {
    const res = $(), err = $();
    return fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), res, err)
      ? { trashPath: ObjC.unwrap(res.path) }
      : { error: ObjC.unwrap(err.localizedDescription) };
  }));
}`;

function moveToTrash(paths) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TRASH_SCRIPT, ...paths], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`Could not move to the Trash: ${err.trim() || `osascript exited ${code}`}`)); }
    });
  });
}

const DEFAULT_UPLOAD_MAX = 2 * GB;
const DEFAULT_ZIP_MAX = 4 * GB;

// config is { read(), update(changes) }: read() re-reads config.json, so settings are taken once per request.
export function createFilesApi({ sendJson, readJson, config }) {
  const home = fs.realpathSync(os.homedir());
  let settingsKey = null;
  let settings;
  function loadSettings() {
    const { fileRoots, fileUploadMax, fileZipMax } = config.read();
    const key = JSON.stringify([fileRoots, fileUploadMax, fileZipMax]);
    if (key === settingsKey) return settings;
    const configured = Array.isArray(fileRoots) && fileRoots.length ? fileRoots : [home];
    const roots = configured.flatMap((p) => {
      try { return [{ given: path.resolve(expandHome(String(p), home)), real: fs.realpathSync(expandHome(String(p), home)) }]; }
      catch { console.warn(`config.json: fileRoots entry ${p} does not exist; Files leaves it out.`); return []; }
    });
    if (!roots.length) roots.push({ given: home, real: home });
    settingsKey = key;
    settings = { roots, uploadMax: positive(fileUploadMax) ?? DEFAULT_UPLOAD_MAX, zipMax: positive(fileZipMax) ?? DEFAULT_ZIP_MAX };
    return settings;
  }
  let { roots, uploadMax, zipMax } = loadSettings();

  const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const rootOf = (real) => roots.find((r) => within(real, r.real))?.real;
  const isRoot = (p) => roots.some((r) => r.real === p);

  function absolute(given) {
    if (given == null || given === '') return roots[0].real;
    if (typeof given !== 'string') fail(400, 'Path must be a string.');
    if (given.includes('\0')) fail(400, 'Path contains a NUL byte.');
    const abs = path.resolve(home, expandHome(given, home));
    // Checking the lexical path first keeps a 404 from revealing what exists outside the roots.
    if (!roots.some((r) => within(abs, r.given) || within(abs, r.real))) fail(403, 'That path is outside the folders Files may show.');
    return abs;
  }

  // Follows every symlink: the real path is what gets read, so it is what must stay inside a root.
  async function resolve(given) {
    const real = await fsp.realpath(absolute(given));
    if (!rootOf(real)) fail(403, 'That path is outside the folders Files may show.');
    return real;
  }

  async function resolveDir(given) {
    const dir = await resolve(given);
    if (!(await fsp.stat(dir)).isDirectory()) fail(400, 'Not a folder.');
    return dir;
  }

  // Rename and trash act on the entry itself, so a symlink is moved as a link and its target is never touched.
  async function resolveEntry(given) {
    const abs = absolute(given);
    const full = path.join(await resolveDir(path.dirname(abs)), path.basename(abs));
    if (isRoot(full) || isRoot(abs)) fail(403, 'A top-level folder cannot be changed.');
    return { full, stat: await fsp.lstat(full) };
  }

  async function entryOf(dir, name) {
    const full = path.join(dir, name);
    let st;
    try { st = await fsp.lstat(full); } catch { return null; }
    const base = { name, path: full, mtime: Math.round(st.mtimeMs) };
    if (st.isDirectory()) return { ...base, type: 'dir', size: 0, mime: null };
    if (st.isFile()) return { ...base, type: 'file', size: st.size, mime: mimeOf(name) };
    if (!st.isSymbolicLink()) return null;
    const target = await fsp.realpath(full).then((real) => (rootOf(real) ? fsp.stat(real) : null)).catch(() => null);
    const linkType = target?.isDirectory() ? 'dir' : target?.isFile() ? 'file' : null;
    return { ...base, type: 'symlink', linkType, size: linkType === 'file' ? target.size : 0, mime: linkType === 'file' ? mimeOf(name) : null };
  }

  function breadcrumbs(dir) {
    const root = rootOf(dir);
    const crumbs = [{ name: root === home ? '~' : path.basename(root) || root, path: root }];
    for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
      crumbs.push({ name: part, path: path.join(crumbs.at(-1).path, part) });
    }
    return crumbs;
  }

  const rawFolders = () => (Array.isArray(config.read().folders) ? config.read().folders : []);

  async function folderView(p) {
    try {
      const real = await resolveDir(p);
      return { name: real === home ? 'Home' : path.basename(real), path: real };
    } catch {
      return null;
    }
  }

  async function places() {
    const quick = (await Promise.all([home, ...QUICK.map((n) => path.join(home, n))].map(folderView))).filter(Boolean);
    const pinned = (await Promise.all(rawFolders().filter((p) => typeof p === 'string').map(folderView))).filter(Boolean);
    return { home, roots: roots.map((r) => r.real), quick, pinned, uploadMax, zipMax };
  }

  async function list({ q }) {
    const dir = await resolveDir(q.get('path'));
    const sort = SORTS[q.get('sort')] ? q.get('sort') : 'name';
    const showHidden = q.get('showHidden') === '1';
    const names = (await fsp.readdir(dir)).filter((n) => showHidden || !n.startsWith('.'));
    const entries = (await Promise.all(names.map((n) => entryOf(dir, n)))).filter(Boolean);
    entries.sort((a, b) => isDirish(b) - isDirish(a) || SORTS[sort](a, b));
    return {
      path: dir,
      parent: isRoot(dir) ? null : path.dirname(dir),
      breadcrumbs: breadcrumbs(dir),
      entries: entries.slice(0, LIST_MAX),
      truncated: entries.length > LIST_MAX,
      total: entries.length,
    };
  }

  async function download({ req, res, q }) {
    const file = await resolve(q.get('path'));
    const st = await fsp.stat(file);
    if (!st.isFile()) fail(400, 'Not a file. Download a folder as a zip.');
    const name = path.basename(file);
    const mime = mimeOf(name);
    const inline = q.get('inline') === '1';
    const headers = {
      'content-type': inline ? inlineType(mime) : mime,
      'content-disposition': disposition(inline ? 'inline' : 'attachment', name),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'last-modified': st.mtime.toUTCString(),
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    };
    const range = rangeOf(req.headers.range, st.size);
    if (range.status === 416) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    if (range.status === 206) headers['content-range'] = `bytes ${range.start}-${range.end}/${st.size}`;
    headers['content-length'] = st.size === 0 ? 0 : range.end - range.start + 1;
    res.writeHead(range.status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    await pipeline(fs.createReadStream(file, { start: range.start, end: range.end }), res);
  }

  // zip cannot write a symlink entry to a pipe ("zip -0 not supported for I/O on pipes"), and without -y it would
  // follow links out of the roots. So this walk picks every entry itself and zip only reads the list: a link to a
  // file inside a root is stored as that file, other links are left out (a folder link could loop).
  async function collect(parent, targets) {
    const deadline = Date.now() + ZIP_WALK_BUDGET_MS;
    const names = [];
    let bytes = 0, skipped = 0;
    const stack = targets.map((t) => path.basename(t));
    while (stack.length) {
      if (Date.now() > deadline || names.length > ZIP_MAX_ENTRIES) return { names, bytes, skipped, complete: false };
      const rel = stack.pop();
      const full = path.join(parent, rel);
      let st = await fsp.lstat(full).catch(() => null);
      if (st?.isSymbolicLink()) {
        const real = await fsp.realpath(full).catch(() => null);
        st = real && rootOf(real) ? await fsp.stat(real).catch(() => null) : null;
        if (!st?.isFile()) st = null;
      }
      // zip -@ reads one name per line.
      if (!st || rel.includes('\n') || !(st.isFile() || st.isDirectory())) { skipped++; continue; }
      if (st.isFile()) {
        names.push(rel);
        bytes += st.size;
        continue;
      }
      names.push(`${rel}/`);
      for (const n of await fsp.readdir(full).catch(() => [])) stack.push(path.join(rel, n));
    }
    return { names: names.reverse(), bytes, skipped, complete: true };
  }

  async function zip({ res, q }) {
    const given = q.getAll('path');
    if (!given.length) fail(400, 'Pick something to zip.');
    const targets = await Promise.all(given.map((p) => resolveEntry(p).then((e) => e.full)));
    const parent = path.dirname(targets[0]);
    if (targets.some((t) => path.dirname(t) !== parent)) fail(400, 'Zip items from one folder at a time.');
    const { names, bytes, skipped, complete } = await collect(parent, targets);
    if (q.get('check') === '1') return { bytes, files: names.filter((n) => !n.endsWith('/')).length, skipped, complete, max: zipMax };
    if (!complete) fail(413, `Too many files to zip (over ${ZIP_MAX_ENTRIES.toLocaleString('en')}). Zip it on the Mac instead.`);
    if (bytes > zipMax) fail(413, `That is ${(bytes / GB).toFixed(1)} GB; the zip limit is ${(zipMax / GB).toFixed(1)} GB.`);
    const base = targets.length === 1 ? path.basename(targets[0]) : path.basename(parent) || 'files';
    // -nw reads each name literally, so a "[" or "*" in a file name is not a wildcard.
    const child = spawn('/usr/bin/zip', ['-q', '-nw', '-@', '-'], { cwd: parent, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (err) => { stderr = err.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(names.map((n) => `${n}\n`).join(''));
    res.on('close', () => child.exitCode === null && child.kill());
    const exited = new Promise((r) => child.on('close', r));
    const first = await new Promise((r) => {
      child.stdout.once('data', r);
      child.once('close', () => r(null));
    });
    if (!first) {
      await exited;
      fail(500, `zip failed: ${stderr.trim() || 'no output'}`);
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': disposition('attachment', `${base}.zip`),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.write(first);
    child.stdout.pipe(res, { end: false });
    // Exit 18 means some files could not be read; the archive is still valid, so it is sent.
    const code = await exited;
    if (code === 0 || code === 18) res.end();
    else res.destroy();
  }

  async function upload({ req, res, q }) {
    const dir = await resolveDir(q.get('dir'));
    const name = checkName(q.get('name'));
    const tooLarge = () => {
      res.setHeader('connection', 'close');
      fail(413, `Files can be at most ${(uploadMax / GB).toFixed(1)} GB.`);
    };
    if (Number(req.headers['content-length']) > uploadMax) tooLarge();
    const tmp = path.join(dir, UPLOAD_PREFIX + crypto.randomBytes(8).toString('hex'));
    const handle = await fsp.open(tmp, 'wx', 0o644);
    let size = 0;
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > uploadMax) tooLarge();
          yield chunk;
        }
      }, handle.createWriteStream());
      const dest = await claimName(dir, name, tmp);
      res.statusCode = 201;
      return { path: dest, name: path.basename(dest) };
    } finally {
      await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true });
    }
  }

  async function mkdir({ body, res }) {
    const dir = path.join(await resolveDir(body.dir), checkName(body.name));
    try {
      await fsp.mkdir(dir);
    } catch (err) {
      if (err.code === 'EEXIST') fail(409, `"${body.name}" already exists here.`);
      throw err;
    }
    res.statusCode = 201;
    return { path: dir, name: body.name };
  }

  async function rename({ body }) {
    const { full, stat } = await resolveEntry(body.path);
    const dest = path.join(path.dirname(full), checkName(body.newName));
    if (dest === full) return { path: dest, name: body.newName };
    const other = await fsp.lstat(dest).catch(() => null);
    // A case-only rename on a case-insensitive volume finds the entry itself at the new name.
    if (other && !(other.ino === stat.ino && other.dev === stat.dev)) fail(409, `"${body.newName}" already exists here.`);
    await fsp.rename(full, dest);
    return { path: dest, name: body.newName };
  }

  async function trash({ body }) {
    const paths = body.paths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) fail(400, 'Expected { paths: [...] }.');
    const errors = [];
    const valid = [];
    for (const p of paths) {
      try {
        valid.push((await resolveEntry(p)).full);
      } catch (err) {
        errors.push({ path: p, error: describe(err)[1] });
      }
    }
    const results = valid.length ? await moveToTrash(valid) : [];
    const trashed = [];
    results.forEach((r, i) => (r.error ? errors.push({ path: valid[i], error: r.error }) : trashed.push({ path: valid[i], trashPath: r.trashPath })));
    return { trashed, errors };
  }

  async function search({ q }) {
    const base = await resolveDir(q.get('path'));
    const needle = (q.get('q') ?? '').trim().normalize('NFC').toLowerCase();
    if (!needle || needle.length > 200) fail(400, 'Enter 1 to 200 characters to search for.');
    const showHidden = q.get('showHidden') === '1';
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const results = [];
    const queue = [{ dir: base, depth: 0 }];
    let partial = false;
    walk: while (queue.length) {
      if (Date.now() > deadline) { partial = true; break; }
      const { dir, depth } = queue.shift();
      const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (SEARCH_SKIP.has(d.name) || (!showHidden && d.name.startsWith('.'))) continue;
        if (d.name.normalize('NFC').toLowerCase().includes(needle)) {
          const entry = await entryOf(dir, d.name);
          if (entry) results.push({ ...entry, dir });
          if (results.length >= SEARCH_MAX) { partial = true; break walk; }
        }
        if (d.isDirectory() && depth + 1 < SEARCH_DEPTH) queue.push({ dir: path.join(dir, d.name), depth: depth + 1 });
      }
    }
    return { path: base, q: needle, results, partial };
  }

  async function pin({ body }) {
    if (typeof body.pinned !== 'boolean') fail(400, 'Expected { path, pinned }.');
    const dir = await resolveDir(body.path);
    // Entries Files cannot read stay in the list; hand-written ones like "~/app" match the resolved folder.
    const sameDir = (p) => typeof p === 'string' && path.resolve(home, expandHome(p.trim(), home)) === dir;
    const current = rawFolders();
    if (current.some(sameDir) !== body.pinned) config.update({ folders: body.pinned ? [...current, dir] : current.filter((p) => !sameDir(p)) });
    return places();
  }

  // Every write needs x-pocket-dev: 1, and 'json' routes also content-type application/json. A page on a forwarded
  // port is same-site, so its cross-origin requests carry the cookie, but it cannot set either header without a
  // CORS preflight, which this server never grants.
  const ROUTES = {
    'GET places': { run: places },
    'GET list': { run: list },
    'GET download': { run: download },
    'HEAD download': { run: download },
    'GET zip': { run: zip },
    'GET search': { run: search },
    'PUT pin': { run: pin, body: 'json' },
    'POST mkdir': { run: mkdir, body: 'json' },
    'POST rename': { run: rename, body: 'json' },
    'POST trash': { run: trash, body: 'json' },
    'POST upload': { run: upload, body: 'raw' },
  };

  function guardWrite(req, kind) {
    const { origin, host } = req.headers;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) fail(403, 'Cross-origin request refused.');
    if (req.headers['x-pocket-dev'] !== '1') fail(403, 'This page is older than the server. Reload Pocket Dev and try again.');
    if (kind === 'json' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'Expected content-type: application/json.');
  }

  function describe(err) {
    if (err instanceof FileError) return [err.status, err.message];
    if (ERRNO[err.code]) return ERRNO[err.code];
    return [500, err.message];
  }

  return async function handleFiles(req, res, url) {
    const route = ROUTES[`${req.method} ${url.pathname.split('/')[3]}`];
    try {
      ({ roots, uploadMax, zipMax } = loadSettings());
      if (!route) fail(404, 'Not found');
      if (route.body) guardWrite(req, route.body);
      const body = route.body === 'json' ? await readJson(req).catch((err) => fail(400, err.message)) : undefined;
      const result = await route.run({ req, res, q: url.searchParams, body });
      if (result !== undefined) sendJson(res, res.statusCode, result);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      const [status, message] = describe(err);
      if (status === 500) console.error('files:', err);
      sendJson(res, status, { error: message });
    }
  };
}
