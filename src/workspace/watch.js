import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Watch only requested, authorized directories. Never recursively walk a project or follow links for notifications.
export function watchWorkspace({ req, res, root, directories, validate, active = () => true, onClose = () => {}, debounce = 90 }) {
  const watchers = [], pending = new Map(), stream = crypto.randomBytes(8).toString('hex');
  let sequence = 0, timer, closed = false;
  const send = (type, data) => {
    if (closed || res.destroyed) return;
    if (res.writableLength > 256 * 1024) return close();
    res.write(`data: ${JSON.stringify({ type, stream, sequence: ++sequence, ...data })}\n\n`);
  };
  function close() { if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat); for (const watcher of watchers) watcher.close(); res.end(); onClose(); }
  const flush = async () => {
    const changes = [...pending].map(([dir, paths]) => ({ dir, paths: [...paths] })); pending.clear();
    try { if (!active()) { send('revoked', {}); return close(); } await validate(root); for (const change of changes) await validate(change.dir); send('changes', { changes }); }
    catch (error) { send(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'unavailable' : 'revoked', {}); close(); }
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
  const heartbeat = setInterval(async () => {
    try { if (!active()) throw new Error('Access ended'); await validate(root); res.write(': keepalive\n\n'); }
    catch (error) { send(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'unavailable' : 'revoked', {}); close(); }
  }, 5000); heartbeat.unref?.();
  res.on('close', close);
  for (const dir of directories) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        if (name?.startsWith('.pocket-dev-upload-')) return;
        const changed = name && !name.includes('/') && !name.includes('\\') ? path.join(dir, name) : dir;
        if (!pending.has(dir)) pending.set(dir, new Set());
        const paths = pending.get(dir);
        if (!paths.has(dir)) { if (paths.size >= 128) { paths.clear(); paths.add(dir); } else paths.add(changed); }
        clearTimeout(timer); timer = setTimeout(flush, debounce);
      });
      watcher.on('error', () => send('reset', { directories: [dir] })); watchers.push(watcher);
    } catch { send('reset', { directories: [dir] }); }
  }
  // A new stream intentionally reconciles the small set of watched directories and open files after any missed events.
  send('ready', { root, reset: true });
  return close;
}
