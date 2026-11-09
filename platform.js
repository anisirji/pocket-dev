import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// One place for what differs between macOS, Linux and Windows. Callers ask for an action and get the same answer
// shape on every system; capabilities() says which actions this system cannot do, so a caller reports that instead
// of failing silently.

// NSFileManager's trashItemAtURL needs no permission and uses the Trash of the item's own volume. Asking Finder
// through osascript ("tell application Finder to delete") needs an Automation grant, which a launchd agent cannot
// get from a phone. Paths arrive as argv, so nothing is spliced into the script.
const MAC_TRASH_SCRIPT = `function run(argv) {
  ObjC.import('Foundation');
  const fm = $.NSFileManager.defaultManager;
  return JSON.stringify(argv.map((p) => {
    const res = $(), err = $();
    return fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), res, err)
      ? { trashPath: ObjC.unwrap(res.path) }
      : { error: ObjC.unwrap(err.localizedDescription) };
  }));
}`;

// Paths arrive in an environment variable as JSON, so nothing is spliced into the script.
const WIN_TRASH_SCRIPT = `Add-Type -AssemblyName Microsoft.VisualBasic
$out = @()
foreach ($p in (ConvertFrom-Json $env:POCKET_DEV_PATHS)) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    $out += @{ trashPath = $null }
  } catch { $out += @{ error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($out) -Compress`;

const ZIP_PATHS = ['/usr/bin/zip', '/bin/zip'];

export const NO_WINDOWS_ZIP = 'Zipping a folder on Windows needs a node zip library, which Pocket Dev does not include yet.';

function collect(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function launch(cmd, args) {
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// run(cmd, args, { env }) resolves { code, stdout, stderr }. launch(cmd, args) starts a detached process.
// exists(path) says whether a file is there. All four can be replaced in tests.
export function createPlatform({
  platform = process.platform, env = process.env, run = collect, launch: start = launch, exists = fs.existsSync, home = os.homedir(),
} = {}) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const onPath = (name) => (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean).some((d) => exists(path.join(d, name)));

  // Resolves one { trashPath } or { error } per path, in order. trashPath is null when the system does not say.
  async function trash(paths) {
    if (mac) return parseTrash(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_TRASH_SCRIPT, ...paths]), 'osascript');
    if (win) {
      return parseTrash(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_TRASH_SCRIPT],
        { env: { ...env, POCKET_DEV_PATHS: JSON.stringify(paths) } }), 'PowerShell');
    }
    const results = [];
    for (const p of paths) results.push(onPath('gio') ? await gioTrash(p) : await xdgTrash(p));
    return results;
  }

  async function gioTrash(p) {
    const r = await run('gio', ['trash', '--', p]);
    return r.code === 0 ? { trashPath: null } : { error: r.stderr.trim() || `gio exited ${r.code}` };
  }

  // The freedesktop.org Trash spec for the home volume: the file goes to Trash/files, and a .trashinfo says where from.
  async function xdgTrash(p) {
    try {
      const root = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Trash');
      await fsp.mkdir(path.join(root, 'files'), { recursive: true });
      await fsp.mkdir(path.join(root, 'info'), { recursive: true });
      const ext = path.extname(path.basename(p));
      const stem = path.basename(p, ext);
      for (let n = 0; ; n++) {
        const name = n ? `${stem} ${n}${ext}` : path.basename(p);
        const dest = path.join(root, 'files', name);
        const info = path.join(root, 'info', `${name}.trashinfo`);
        try {
          await fsp.writeFile(info, `[Trash Info]\nPath=${encodeURI(p)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`, { flag: 'wx' });
        } catch (err) {
          if (err.code === 'EEXIST') continue;
          throw err;
        }
        if (fs.existsSync(dest)) { await fsp.rm(info); continue; }
        try { await fsp.rename(p, dest); } catch (err) { await fsp.rm(info, { force: true }); throw err; }
        return { trashPath: dest };
      }
    } catch (err) {
      return { error: `Could not move to the Trash: ${err.message}` };
    }
  }

  function parseTrash(r, tool) {
    try { return JSON.parse(r.stdout); } catch { throw new Error(`Could not move to the Trash: ${r.stderr.trim() || `${tool} exited ${r.code}`}`); }
  }

  const openCommand = () => (mac ? ['open', (u) => [u]] : win ? ['cmd', (u) => ['/c', 'start', '""', u]] : ['xdg-open', (u) => [u]]);

  // Opens a URL in the system's default browser. Returns false when this system has no way to.
  function openUrl(url) {
    if (!capabilities().openUrl.available) return false;
    const [cmd, args] = openCommand();
    start(cmd, args(url));
    return true;
  }

  function defaultShell() {
    if (env.SHELL) return env.SHELL;
    if (win) return 'powershell.exe';
    if (mac) return '/bin/zsh';
    return ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash'].find(exists) ?? '/bin/sh';
  }

  // { available: true, cmd, args } or { available: false, reason }. Mac always has /usr/bin/zip.
  function zipCommand() {
    if (win) return { available: false, reason: NO_WINDOWS_ZIP };
    const cmd = mac ? ZIP_PATHS[0] : ZIP_PATHS.find(exists);
    if (!cmd) return { available: false, reason: 'Zipping a folder needs the zip program. Install it (for example: sudo apt install zip).' };
    // -nw reads each name literally, so a "[" or "*" in a file name is not a wildcard.
    return { available: true, cmd, args: ['-q', '-nw', '-@', '-'] };
  }

  function capabilities() {
    const zip = zipCommand();
    const open = mac || win || onPath('xdg-open');
    return {
      trash: { available: true, via: mac ? 'NSFileManager' : win ? 'PowerShell' : onPath('gio') ? 'gio' : 'XDG Trash folder' },
      openUrl: open ? { available: true } : { available: false, reason: 'Opening a page needs xdg-open, which is not installed.' },
      shell: { available: true, path: defaultShell() },
      zip: zip.available ? { available: true } : { available: false, reason: zip.reason },
    };
  }

  return { platform, trash, openUrl, defaultShell, zipCommand, capabilities };
}

export const platform = createPlatform();
