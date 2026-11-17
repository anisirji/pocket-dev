import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, STATE_DIR } from './paths.js';

// `pocket-dev admin pin` and `unpin`: a launcher for the Admin page in the Dock (macOS), the Start menu and Desktop
// (Windows) or the app menu and GNOME favourites (Linux). The launcher asks the Pocket Dev that is running for its
// current Admin address each time, so a changed admin port never breaks it, and it starts nothing: when Pocket Dev is not
// running it says so. Everything that touches the system goes through `d` (run, fs, paths), so tests use fixtures and
// never reach a real Dock, PowerShell or gsettings. Nothing here needs administrator rights.

export const APP_NAME = 'Pocket Dev Admin';
export const PIN_COMMAND = 'pocket-dev admin pin';
const NOT_RUNNING = 'Pocket Dev is not running. Start it with: pocket-dev start (or pocket-dev service install).';

export function realPinDeps(platform = process.platform, overrides = {}) {
  const run = (cmd, args, { input, env } = {}) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
  };
  return {
    platform, home: os.homedir(), env: process.env, node: process.execPath, stateDir: STATE_DIR, now: () => Date.now(),
    cli: path.join(PACKAGE_ROOT, 'bin', 'pocket-dev.js'), brand: path.join(PACKAGE_ROOT, 'assets', 'brand'),
    run,
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    fs: {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      write: (p, data, mode) => fs.writeFileSync(p, data, mode ? { mode } : undefined),
      copy: (from, to) => fs.copyFileSync(from, to),
      rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
      exists: (p) => fs.existsSync(p),
      read: (p) => fs.readFileSync(p, 'utf8'),
    },
    ...overrides,
  };
}

// ---- Shared pieces --------------------------------------------------------------------------------------------------

// Single-quoted for sh, so a path with spaces or a quote stays one word.
export const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function shLauncher(d, { message }) {
  return `#!/bin/sh
# Opens the Admin page of the Pocket Dev running on this computer. It starts nothing.
NODE=${shq(d.node)}
CLI=${shq(d.cli)}
[ -x "$NODE" ] || NODE=$(command -v node)
if [ -z "$NODE" ] || ! "$NODE" "$CLI" admin >/dev/null 2>&1; then
${message}
fi
`;
}

const base = (d) => d.home;

// ---- macOS ----------------------------------------------------------------------------------------------------------

const macApp = (d) => path.join(base(d), 'Applications', `${APP_NAME}.app`);

function macPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
<key>CFBundleIdentifier</key><string>dev.pocket.admin</string>
<key>CFBundleExecutable</key><string>PocketDevAdmin</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export function macLauncher(d) {
  const dialog = `display dialog "${NOT_RUNNING}" with title "${APP_NAME}" buttons {"OK"} default button "OK" with icon caution`;
  return shLauncher(d, { message: `  /usr/bin/osascript -e ${shq(dialog)} >/dev/null 2>&1` });
}

const dockEntry = (app) => `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${xml(pathToFileURL(`${app}/`).href)}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${APP_NAME}</string></dict><key>tile-type</key><string>file-tile</string></dict>`;

// The Dock's settings hold binary bookmark data, which plutil cannot write as JSON, so the tile list is read from the XML
// itself: the file URL of each entry in persistent-apps, in order (null for an entry without one, such as a spacer).
export function parseDockUrls(arrayXml) {
  const urls = [];
  let depth = 0;
  let key = null;
  for (const m of String(arrayXml).matchAll(/<(\/?)(dict|array)>|<key>([^<]*)<\/key>|<string>([^<]*)<\/string>/g)) {
    if (m[2]) {
      if (m[1]) depth--;
      else { depth++; if (depth === 2 && m[2] === 'dict') urls.push(null); }
    } else if (m[3] !== undefined) key = m[3];
    else if (key === '_CFURLString' && depth >= 4 && urls.length && urls.at(-1) === null) { urls[urls.length - 1] = m[4].replaceAll('&amp;', '&'); key = null; }
  }
  return urls;
}

function dockApps(d) {
  const exported = d.run('defaults', ['export', 'com.apple.dock', '-']);
  if (exported.status !== 0) return { ok: false, urls: [], xml: '' };
  const extracted = d.run('plutil', ['-extract', 'persistent-apps', 'xml1', '-o', '-', '-'], { input: exported.stdout });
  if (extracted.status !== 0) return { ok: true, urls: [], xml: exported.stdout };
  return { ok: true, urls: parseDockUrls(extracted.stdout), xml: exported.stdout };
}

function dockIndexes(urls, app) {
  const want = path.resolve(app);
  const out = [];
  urls.forEach((url, i) => {
    if (typeof url !== 'string') return;
    try { if (path.resolve(decodeURIComponent(url.replace(/^file:\/\//, ''))) === want) out.push(i); } catch {}
  });
  return out;
}

// Waits for the Dock to show `want` (true: our tile is there, false: it is gone), and runs `again` once if it does not.
function settles(d, app, want, again) {
  const here = () => { const k = dockApps(d); return k.ok && dockIndexes(k.urls, app).length > 0; };
  for (let i = 0; i < 8; i++) {
    d.sleep?.(500);
    if (here() === want) return true;
    if (i === 3) again();
  }
  return here() === want;
}

const mac = {
  describe(d) {
    return [
      { label: `Create the ${APP_NAME} app in ${path.join(base(d), 'Applications')}.`, lines: [`Will write: ${macApp(d)} (opens the Admin page of the Pocket Dev that is running)`] },
      { label: 'Add it to your Dock.', lines: ['Will run: defaults write com.apple.dock persistent-apps -array-add <the app>', 'Will run: killall Dock   (the Dock restarts and flickers once)'] },
    ];
  },
  status(d) {
    const dock = dockApps(d);
    return { pinned: dock.ok && dockIndexes(dock.urls, macApp(d)).length > 0, where: ['Dock'] };
  },
  pin(d) {
    const app = macApp(d);
    d.fs.mkdir(path.join(app, 'Contents', 'MacOS'));
    d.fs.mkdir(path.join(app, 'Contents', 'Resources'));
    d.fs.write(path.join(app, 'Contents', 'Info.plist'), macPlist());
    d.fs.write(path.join(app, 'Contents', 'MacOS', 'PocketDevAdmin'), macLauncher(d), 0o755);
    d.fs.copy(path.join(d.brand, 'pocket-dev.icns'), path.join(app, 'Contents', 'Resources', 'AppIcon.icns'));
    const lines = [`Created ${app}`];
    const dock = dockApps(d);
    if (!dock.ok) return { changed: true, lines: [...lines, 'Could not read the Dock settings, so it was not added to the Dock. Drag the app from Applications into the Dock yourself.'] };
    if (dockIndexes(dock.urls, app).length) return { changed: true, lines: [...lines, 'It is already in your Dock. Nothing else changed.'] };
    const add = () => {
      const wrote = d.run('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', dockEntry(app)]);
      if (wrote.status === 0) d.run('killall', ['Dock']);
      return wrote;
    };
    const wrote = add();
    if (wrote.status !== 0) return { changed: true, lines: [...lines, `Could not add it to the Dock: ${wrote.stderr.trim()}. Drag the app from Applications into the Dock yourself.`] };
    // The Dock writes its own list back as it restarts, which can undo a change made just before. Check, and retry once.
    if (!settles(d, app, true, add)) return { changed: true, lines: [...lines, 'The Dock did not keep the new tile. Drag the app from Applications into the Dock yourself.'] };
    return { changed: true, lines: [...lines, 'Added it to your Dock.'] };
  },
  unpin(d) {
    const app = macApp(d);
    const lines = [];
    const removeTile = () => {
      const dock = dockApps(d);
      const found = dock.ok ? dockIndexes(dock.urls, app) : [];
      if (!found.length) return { done: true, none: true };
      let text = dock.xml;
      for (const i of [...found].reverse()) {
        const r = d.run('plutil', ['-remove', `persistent-apps.${i}`, '-o', '-', '-'], { input: text });
        if (r.status !== 0) return { done: false, error: `Could not remove it from the Dock: ${r.stderr.trim()}` };
        text = r.stdout;
      }
      const back = d.run('defaults', ['import', 'com.apple.dock', '-'], { input: text });
      if (back.status !== 0) return { done: false, error: `Could not save the Dock settings: ${back.stderr.trim()}` };
      d.run('killall', ['Dock']);
      return { done: true };
    };
    const first = removeTile();
    if (first.error) return { changed: false, lines: [first.error] };
    if (!first.none) {
      // The Dock writes its own list back as it restarts, which can undo the change. Check, and retry once.
      if (settles(d, app, false, removeTile)) lines.push('Removed it from your Dock.');
      else lines.push('The Dock kept the tile. Right-click it, choose Options, then Remove from Dock.');
    }
    if (d.fs.exists(app)) { d.fs.rm(app); lines.push(`Deleted ${app}`); }
    return { changed: lines.length > 0, lines: lines.length ? lines : ['Nothing to remove.'] };
  },
};

// ---- Windows --------------------------------------------------------------------------------------------------------

// Windows does not let a program pin itself to the taskbar. This makes the shortcut and the person pins it: right-click, Pin to taskbar.
const winDir = (d) => path.win32.join(d.env.APPDATA || path.win32.join(d.home, 'AppData', 'Roaming'), 'Pocket Dev');

export function winVbs(d) {
  const cmd = `"${d.node}" "${d.cli}" admin`;
  const vb = (s) => s.replaceAll('"', '""');
  return `' Opens the Admin page of the Pocket Dev running on this computer. It starts nothing and leaves no console open.\r\nSet sh = CreateObject("WScript.Shell")\r\ncode = sh.Run("${vb(cmd)}", 0, True)\r\nIf code <> 0 Then MsgBox "${NOT_RUNNING}", 48, "${APP_NAME}"\r\n`;
}

// Paths arrive in environment variables, so nothing is spliced into the script.
export const WIN_LNK_SCRIPT = `$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$made = @()
$places = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))
foreach ($place in $places) {
  if (-not $place) { continue }
  $file = Join-Path $place ($env:PD_NAME + '.lnk')
  $s = $shell.CreateShortcut($file)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
  $s.Arguments = '//nologo "' + $env:PD_VBS + '"'
  $s.WorkingDirectory = $env:PD_DIR
  $s.IconLocation = $env:PD_ICO
  $s.Description = 'Open the Pocket Dev Admin page'
  $s.Save()
  $check = $shell.CreateShortcut($file)
  $made += @{ path = $file; target = $check.TargetPath; arguments = $check.Arguments; icon = $check.IconLocation }
}
ConvertTo-Json -InputObject @($made) -Compress`;

export const WIN_LNK_REMOVE_SCRIPT = `$removed = @()
foreach ($place in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  if (-not $place) { continue }
  $file = Join-Path $place ($env:PD_NAME + '.lnk')
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force; $removed += $file }
}
ConvertTo-Json -InputObject @($removed) -Compress`;

const psEnv = (d) => ({ PD_NAME: APP_NAME, PD_DIR: winDir(d), PD_VBS: path.win32.join(winDir(d), 'pocket-dev-admin.vbs'), PD_ICO: path.win32.join(winDir(d), 'pocket-dev.ico') });
const ps = (d, script) => d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: psEnv(d) });
const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

const win = {
  describe(d) {
    return [
      { label: `Create a "${APP_NAME}" shortcut in your Start menu and on your Desktop.`, lines: [`Will write: ${winDir(d)}\\pocket-dev-admin.vbs and pocket-dev.ico (the shortcut runs this, so no console window opens)`, 'Will run: PowerShell, to create the two .lnk shortcuts'] },
      { label: 'Windows does not let a program pin itself to the taskbar.', lines: ['After this, right-click the shortcut and choose Pin to taskbar. That last click is yours.'] },
    ];
  },
  status(d) {
    const dir = winDir(d);
    return { pinned: d.fs.exists(path.win32.join(dir, 'pocket-dev-admin.vbs')), where: ['Start menu', 'Desktop'] };
  },
  pin(d, { quiet } = {}) {
    const dir = winDir(d);
    d.fs.mkdir(dir);
    d.fs.write(path.win32.join(dir, 'pocket-dev-admin.vbs'), winVbs(d));
    d.fs.copy(path.join(d.brand, 'pocket-dev.ico'), path.win32.join(dir, 'pocket-dev.ico'));
    const r = ps(d, WIN_LNK_SCRIPT);
    const made = jsonOf(r);
    if (r.status !== 0 || !Array.isArray(made)) return { changed: true, lines: [`Could not create the shortcuts: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`] };
    const lines = made.map((m) => `Created ${m.path}`);
    lines.push('Windows requires you to pin it yourself: right-click "Pocket Dev Admin" and choose Pin to taskbar.');
    const first = made[0]?.path;
    if (first && !quiet) d.run('explorer.exe', [`/select,${first}`]);
    return { changed: true, lines, made };
  },
  unpin(d) {
    const dir = winDir(d);
    const lines = [];
    const r = ps(d, WIN_LNK_REMOVE_SCRIPT);
    for (const p of jsonOf(r) ?? []) lines.push(`Deleted ${p}`);
    for (const f of ['pocket-dev-admin.vbs', 'pocket-dev.ico']) {
      const p = path.win32.join(dir, f);
      if (d.fs.exists(p)) { d.fs.rm(p); lines.push(`Deleted ${p}`); }
    }
    if (lines.length) lines.push('If you pinned it to the taskbar, right-click it there and choose Unpin from taskbar.');
    return { changed: lines.length > 0, lines: lines.length ? lines : ['Nothing to remove.'] };
  },
};

// ---- Linux ----------------------------------------------------------------------------------------------------------

const DESKTOP_ID = 'pocket-dev-admin.desktop';
const linuxPaths = (d) => {
  const data = d.env.XDG_DATA_HOME || path.join(d.home, '.local', 'share');
  return {
    entry: path.join(data, 'applications', DESKTOP_ID),
    script: path.join(data, 'pocket-dev', 'pocket-dev-admin.sh'),
    png: path.join(data, 'icons', 'hicolor', '256x256', 'apps', 'pocket-dev-admin.png'),
    svg: path.join(data, 'icons', 'hicolor', 'scalable', 'apps', 'pocket-dev-admin.svg'),
  };
};

const desktopQuote = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1').replaceAll('%', '%%')}"`;

export function linuxLauncher(d) {
  const message = `  if command -v notify-send >/dev/null 2>&1; then notify-send ${shq(APP_NAME)} ${shq(NOT_RUNNING)}
  elif command -v zenity >/dev/null 2>&1; then zenity --warning --title ${shq(APP_NAME)} --text ${shq(NOT_RUNNING)}
  else xmessage ${shq(NOT_RUNNING)} >/dev/null 2>&1; fi`;
  return shLauncher(d, { message });
}

export function linuxEntry(d) {
  const p = linuxPaths(d);
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Open the Pocket Dev Admin page
Exec=${desktopQuote(p.script)}
Icon=pocket-dev-admin
Terminal=false
Categories=Development;Utility;
StartupNotify=false
`;
}

const isGnome = (d) => /gnome/i.test(d.env.XDG_CURRENT_DESKTOP || '') && d.run('gsettings', ['--version']).status === 0;
const favorites = (d) => {
  const r = d.run('gsettings', ['get', 'org.gnome.shell', 'favorite-apps']);
  return r.status === 0 ? [...r.stdout.matchAll(/'([^']*)'/g)].map((m) => m[1]) : null;
};
const setFavorites = (d, list) => d.run('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', `[${list.map((x) => `'${x}'`).join(', ')}]`]);

const linux = {
  describe(d) {
    const p = linuxPaths(d);
    const items = [{ label: `Add "${APP_NAME}" to your applications menu.`, lines: [`Will write: ${p.entry}, ${p.script} and two icon files under ${path.dirname(path.dirname(path.dirname(p.png)))}`] }];
    if (isGnome(d)) items.push({ label: 'Add it to your GNOME favourites (the dock).', lines: ["Will run: gsettings set org.gnome.shell favorite-apps [..., 'pocket-dev-admin.desktop']"] });
    else items.push({ label: 'Other desktops: stop at the applications menu.', lines: ['Pin it from there (KDE: right-click, Pin to Task Manager).'] });
    return items;
  },
  status(d) {
    const fav = isGnome(d) ? favorites(d) : null;
    return { pinned: d.fs.exists(linuxPaths(d).entry) && (fav ? fav.includes(DESKTOP_ID) : true), where: ['applications menu', ...(fav ? ['GNOME favourites'] : [])] };
  },
  pin(d) {
    const p = linuxPaths(d);
    for (const f of [p.entry, p.script, p.png, p.svg]) d.fs.mkdir(path.dirname(f));
    d.fs.write(p.script, linuxLauncher(d), 0o755);
    d.fs.write(p.entry, linuxEntry(d), 0o644);
    d.fs.copy(path.join(d.brand, 'png', 'pocket-dev-256.png'), p.png);
    d.fs.copy(path.join(d.brand, 'pocket-dev.svg'), p.svg);
    const lines = [`Created ${p.entry}`];
    if (!isGnome(d)) return { changed: true, lines: [...lines, 'It is in your applications menu. This desktop is not GNOME, so pin it from the menu yourself (KDE: right-click, Pin to Task Manager).'] };
    const list = favorites(d);
    if (!list) return { changed: true, lines: [...lines, 'Could not read the GNOME favourites. Pin it from the applications menu yourself.'] };
    if (list.includes(DESKTOP_ID)) return { changed: true, lines: [...lines, 'It is already in your GNOME favourites.'] };
    const r = setFavorites(d, [...list, DESKTOP_ID]);
    return { changed: true, lines: [...lines, r.status === 0 ? 'Added it to your GNOME favourites.' : `Could not add it to the GNOME favourites: ${r.stderr.trim()}`] };
  },
  unpin(d) {
    const p = linuxPaths(d);
    const lines = [];
    if (isGnome(d)) {
      const list = favorites(d);
      if (list?.includes(DESKTOP_ID) && setFavorites(d, list.filter((x) => x !== DESKTOP_ID)).status === 0) lines.push('Removed it from your GNOME favourites.');
    }
    for (const f of [p.entry, p.script, p.png, p.svg]) if (d.fs.exists(f)) { d.fs.rm(f); lines.push(`Deleted ${f}`); }
    return { changed: lines.length > 0, lines: lines.length ? lines : ['Nothing to remove.'] };
  },
};

// ---- Public API -----------------------------------------------------------------------------------------------------

const BY_PLATFORM = { darwin: mac, win32: win, linux };
const WHAT = { darwin: 'Dock', win32: 'taskbar', linux: 'launcher' };
const impl = (d) => BY_PLATFORM[d.platform];

export const pinWhat = (platform) => WHAT[platform] ?? 'launcher';
export const describePin = (d) => impl(d)?.describe(d) ?? [];
export const pinStatus = (d) => impl(d)?.status(d) ?? { pinned: false, where: [] };
export const unsupportedReason = (d) => (impl(d) ? null : `Pinning is not supported on ${d.platform}.`);

// What the install or the command did, kept where `pocket-dev setup` and `pocket-dev admin pin --status` can read it,
// because npm may hide an install script's output. Best effort: a record that cannot be written changes nothing else.
const recordPath = (d) => path.join(d.stateDir ?? STATE_DIR, 'pinned.json');
export function readRecord(d) {
  try { return JSON.parse(d.fs.read(recordPath(d))); } catch { return null; }
}
function writeRecord(d, via) {
  try {
    d.fs.mkdir(path.dirname(recordPath(d)));
    d.fs.write(recordPath(d), `${JSON.stringify({ pinnedAt: new Date(d.now?.() ?? Date.now()).toISOString(), platform: d.platform, via, where: impl(d).status(d).where })}\n`, 0o600);
  } catch {}
}

export function pin(d, { via = 'command', quiet = false } = {}) {
  if (!impl(d)) return { changed: false, lines: [unsupportedReason(d)] };
  try {
    const result = impl(d).pin(d, { quiet });
    if (result.changed) writeRecord(d, via);
    return result;
  } catch (err) { return { changed: false, lines: [`Could not do it: ${err.message}`] }; }
}
export function unpin(d) {
  if (!impl(d)) return { changed: false, lines: [unsupportedReason(d)] };
  try {
    const result = impl(d).unpin(d);
    try { d.fs.rm(recordPath(d)); } catch {}
    return result;
  } catch (err) { return { changed: false, lines: [`Could not do it: ${err.message}`] }; }
}

// `npm install -g` runs this through scripts/postinstall.js. It acts only for a global install on a desktop, so npx, a local
// install and CI never touch a Dock, and it never throws. Returns the one line to print, or null when it did nothing.
export function postinstallPin(env = process.env, d = realPinDeps()) {
  try {
    const off = (v) => !v || v === '0' || v === 'false';
    if (env.npm_config_global !== 'true') return null;
    if (!off(env.CI) || env.POCKET_DEV_NO_PIN === '1') return null;
    if (unsupportedReason(d)) return null;
    if (d.platform === 'linux' && !(env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP)) return null;
    const result = pin(d, { via: 'install', quiet: true });
    const tail = 'Undo: pocket-dev admin unpin. Skip next time: POCKET_DEV_NO_PIN=1.';
    if (!result.changed) return `Pocket Dev: could not add the Admin shortcut (${result.lines[0]}). Try: ${PIN_COMMAND}`;
    if (d.platform === 'darwin') return `Pocket Dev: added a "${APP_NAME}" tile to your Dock. ${tail}`;
    if (d.platform === 'win32') return `Pocket Dev: added "${APP_NAME}" shortcuts to your Desktop and Start menu. Windows needs you to right-click one and choose Pin to taskbar. ${tail}`;
    return `Pocket Dev: added "${APP_NAME}" to your applications menu${isGnome(d) ? ' and GNOME favourites' : ''}. ${tail}`;
  } catch { return null; }
}

// The setup step. `ask` is setup's yes/no helper. Nothing is asked or changed in a dry run, and a context without `pin`
// (a test that does not care about it) skips the step without a word.
export async function pinStep(ctx, opts, ask) {
  const d = ctx.pin;
  if (!d) return;
  const where = pinWhat(d.platform);
  ctx.out(`Pocket Dev Admin in your ${where === 'taskbar' ? 'taskbar' : where}`);
  const why = unsupportedReason(d);
  if (why) return ctx.out(`  ${why}`);
  const status = pinStatus(d);
  if (status.pinned) {
    const rec = readRecord(d);
    return ctx.out(rec?.via === 'install' ? `  Done: it was added when Pocket Dev was installed (${status.where.join(', ')}). Undo any time with: pocket-dev admin unpin` : `  Already there (${status.where.join(', ')}). Nothing to do.`);
  }
  ctx.out('  One click to the Admin page, where you approve phones and manage access. I will:');
  describePin(d).forEach((item, i) => { ctx.out(`    ${i + 1}. ${item.label}`); for (const line of item.lines) ctx.out(`       ${line}`); });
  ctx.out('  Nothing needs administrator rights. Undo any time with: pocket-dev admin unpin');
  if (opts.dry) return ctx.out('  (dry run: not asked, not run)');
  if (!(await ask(ctx, opts, '  Add it?', true))) return ctx.out(`  Skipped. Add it later with: ${PIN_COMMAND}`);
  const result = pin(d);
  ctx.log?.(`admin launcher pinned (${d.platform})`);
  for (const line of result.lines) ctx.out(`  ${line}`);
}

// The line setup prints in its status-only run, where no step runs.
export function pinCheckLine(ctx) {
  const d = ctx.pin;
  if (!d || unsupportedReason(d)) return null;
  const s = pinStatus(d);
  return s.pinned ? `✓ Admin shortcut: in your ${s.where.join(' and ')}${readRecord(d)?.via === 'install' ? ' (added at install)' : ''}` : `✗ Admin shortcut: not added yet. Run: ${PIN_COMMAND}`;
}

// `pocket-dev admin pin` / `unpin` / `pin --status`. Returns the exit code (--status: 0 when it is in place, 1 when not).
export async function pinCommand(args, d = realPinDeps(), out = console.log) {
  const [action, flag] = args;
  if ((action !== 'pin' && action !== 'unpin') || (flag && !(action === 'pin' && flag === '--status'))) { out('usage: pocket-dev admin [pin [--status] | unpin]'); return 2; }
  const why = unsupportedReason(d);
  if (why) { out(why); return 1; }
  if (flag === '--status') {
    const s = pinStatus(d);
    const rec = readRecord(d);
    out(s.pinned ? `Pocket Dev Admin is in your ${s.where.join(' and ')}${rec ? ` (added ${rec.via === 'install' ? 'when Pocket Dev was installed' : 'by pocket-dev admin pin'} on ${rec.pinnedAt.slice(0, 10)}).` : '.'}` : `Pocket Dev Admin is not added yet. Run: ${PIN_COMMAND}`);
    return s.pinned ? 0 : 1;
  }
  const result = action === 'pin' ? pin(d) : unpin(d);
  for (const line of result.lines) out(line);
  return 0;
}
