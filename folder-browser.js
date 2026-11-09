import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { platform } from './platform.js';

const LIMIT = 2000;
const SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const SORT_KEYS = { name: 'name', modified: 'mtimeMs', created: 'birthtimeMs' };
const error = (status, message) => Object.assign(new Error(message), { status });

// Owner-only directory navigation. Mount behind device authentication or the Mac-only Admin guard, never guest scope.
export function createFolderBrowser({ home = os.homedir(), config = { read: () => ({}) } } = {}) {
  const expand = (value) => value === '~' || value.startsWith('~/') ? home + value.slice(1) : value;
  async function shortcuts() {
    const saved = config.read();
    const candidates = [
      ['Home', home], ...['Desktop', 'Documents', 'Downloads'].map((name) => [name, path.join(home, name)]),
      ['External drives', '/Volumes'], [platform.host.Mac, '/'],
      ...(Array.isArray(saved.folders) ? saved.folders : []).filter((p) => typeof p === 'string').map((p) => [path.basename(p), p]),
    ];
    const seen = new Set();
    const result = [];
    for (const [name, given] of candidates) {
      try {
        const real = await fs.realpath(path.resolve(home, expand(given)));
        if (!seen.has(real) && (await fs.stat(real)).isDirectory()) {
          seen.add(real);
          result.push({ name, path: real });
        }
      } catch { /* Missing or unreadable shortcuts do not hide the other locations. */ }
    }
    return result;
  }
  async function create({ parent, name, kind } = {}) {
    if (typeof name !== 'string' || typeof parent !== 'string' || parent.includes('\0')) throw error(400, 'Enter a name.');
    name = name.trim();
    if (!name) throw error(400, 'Enter a name.');
    if (name === '.' || name === '..' || /[/\0]/.test(name) || Buffer.byteLength(name) > 255) throw error(400, 'Use a name without slashes.');
    if (kind !== 'folder' && kind !== 'file') throw error(400, 'Choose folder or file.');
    try {
      const dir = await fs.realpath(path.resolve(home, expand(parent)));
      if (!(await fs.stat(dir)).isDirectory()) throw error(400, 'That location is a file. Choose a folder.');
      const target = path.join(dir, name);
      if (kind === 'folder') await fs.mkdir(target);
      else await (await fs.open(target, 'wx')).close();
      return { path: target, name, kind };
    } catch (err) {
      if (err.status) throw err;
      if (err.code === 'EEXIST') throw error(409, `"${name}" already exists here.`);
      if (err.code === 'ENOENT') throw error(404, 'This folder no longer exists. Choose another location.');
      if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw error(403, `${platform.osName} has not allowed Pocket Dev to create items in this folder.`);
      throw err;
    }
  }
  return Object.assign(async function browse(url) {
    const given = url.searchParams.get('path') || home;
    if (given.includes('\0')) throw error(400, 'Choose a valid folder.');
    try {
      const dir = await fs.realpath(path.resolve(home, expand(given)));
      if (!(await fs.stat(dir)).isDirectory()) throw error(400, 'That location is a file. Choose a folder.');
      const hidden = url.searchParams.get('hidden') === '1';
      const sortKey = SORT_KEYS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'name';
      const direction = url.searchParams.get('order') === 'desc' ? -1 : 1;
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => (hidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(query));
      const entries = [];
      // Bound filesystem work in parallel batches, including directory symlinks and broken links.
      for (let i = 0; i < names.length; i += 64) {
        const batch = await Promise.all(names.slice(i, i + 64).map(async (entry) => {
          if (!entry.isDirectory() && !(entry.isSymbolicLink() && await fs.stat(path.join(dir, entry.name)).then((s) => s.isDirectory(), () => false))) return null;
          const full = path.join(dir, entry.name);
          const times = sortKey === 'name' ? null : await fs.stat(full).catch(() => null);
          return { name: entry.name, path: full, time: times?.[SORT_KEYS[sortKey]] ?? 0 };
        }));
        entries.push(...batch.filter(Boolean));
      }
      entries.sort((a, b) => direction * (sortKey === 'name' ? 0 : a.time - b.time || 0) || direction * SORT.compare(a.name, b.name));
      let current = path.parse(dir).root;
      const breadcrumbs = [{ name: platform.host.Mac, path: current }];
      for (const name of dir.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, name);
        breadcrumbs.push({ name, path: current });
      }
      return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), breadcrumbs,
        shortcuts: await shortcuts(), entries: entries.slice(0, LIMIT).map(({ name, path }) => ({ name, path })), truncated: entries.length > LIMIT };
    } catch (err) {
      if (err.status) throw err;
      if (err.code === 'ENOENT') throw error(404, 'This folder no longer exists. Choose another location.');
      if (err.code === 'ENOTDIR') throw error(400, 'That location is a file. Choose a folder.');
      if (['EACCES', 'EPERM'].includes(err.code)) throw error(403, `${platform.osName} has not allowed Pocket Dev to open this folder. Choose another folder or allow access on ${platform.host.the}.`);
      throw err;
    }
  }, { create });
}
