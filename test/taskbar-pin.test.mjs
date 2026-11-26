import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  pin, unpin, pinStep, pinCheckLine, pinCommand, postinstallPin, describePin, readRecord, macLauncher, linuxLauncher, linuxEntry, winVbs,
  WIN_LNK_SCRIPT, shq, PIN_COMMAND, parseDockUrls,
} from '../src/setup/taskbar-pin.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = '/opt/my node/bin/node';
const CLI = "/opt/my node/lib/@anisirji/pocket dev's/bin/pocket-dev.js";

// The Dock's real XML: each tile carries binary bookmark data (which is why plutil cannot write it as JSON), a spacer has no file URL.
const esc = (x) => x.replaceAll('&', '&amp;');
const tile = (url) => (url === null
  ? '<dict><key>tile-data</key><dict/><key>tile-type</key><string>spacer-tile</string></dict>'
  : `<dict><key>GUID</key><integer>17</integer><key>tile-data</key><dict><key>book</key><data>\nYm9va0gCAAAAAAQQMAAAAA==\n</data><key>dock-extra</key><false/><key>file-data</key><dict><key>_CFURLString</key><string>${esc(url)}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>x</string></dict><key>tile-type</key><string>file-tile</string></dict>`);
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">';
const arrayXml = (urls) => `${HEAD}<array>${urls.map(tile).join('')}</array></plist>`;
const exportXml = (urls) => `${HEAD}<dict><key>persistent-apps</key><array>${urls.map(tile).join('')}</array><key>mod-count</key><integer>3</integer></dict></plist>`;
const urlsIn = (xml) => parseDockUrls(/<key>persistent-apps<\/key>\s*(<array>[\s\S]*?<\/array>)\s*<key>/.exec(xml)[1]);

// An in-memory file system and a scripted command runner. Nothing here touches the real Dock, PowerShell or gsettings.
function fixture(platform, { env = {}, gnome = false, dock = [], favorites = [], failDock = false, noGsettings = false, stubborn = 0 } = {}) {
  const files = new Map();
  const calls = [];
  const state = { dock: [...dock], favorites: [...favorites], undo: stubborn, saved: null, imports: 0, writes: 0 };
  const home = platform === 'win32' ? 'C:\\Users\\Ani Sirji' : '/Users/ani sirji';
  const d = {
    platform, home, env: { ...env, ...(platform === 'win32' ? { APPDATA: 'C:\\Users\\Ani Sirji\\AppData\\Roaming' } : {}), ...(gnome ? { XDG_CURRENT_DESKTOP: 'GNOME' } : {}) },
    node: NODE, cli: CLI, brand: '/pkg/assets/brand', stateDir: '/state', now: () => Date.UTC(2026, 10, 17, 8), sleep() {},
    fs: {
      mkdir: () => {}, write: (p, data, mode) => files.set(p, { data, mode }), copy: (a, b) => files.set(b, { copiedFrom: a }),
      rm: (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`) || k.startsWith(`${p}\\`)) files.delete(k); },
      exists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`) || k.startsWith(`${p}\\`)),
      read: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p).data; },
    },
    run(cmd, args, opts = {}) {
      calls.push({ cmd, args, input: opts.input, env: opts.env });
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      const no = (stderr = 'failed') => ({ status: 1, stdout: '', stderr });
      if (cmd === 'defaults' && args[0] === 'export') return failDock ? no('no domain') : ok(exportXml(state.dock));
      if (cmd === 'plutil' && args[0] === '-extract') {
        assert.equal(args[2], 'xml1', 'the Dock list must be read as XML: the real one holds binary data that JSON cannot carry');
        return ok(arrayXml(state.dock));
      }
      if (cmd === 'plutil' && args[0] === '-remove') {
        const urls = urlsIn(opts.input);
        urls.splice(Number(args[1].split('.')[1]), 1);
        return ok(exportXml(urls));
      }
      if (cmd === 'defaults' && args[0] === 'import') { state.imports++; state.saved = [...state.dock]; state.dock = urlsIn(opts.input); return ok(); }
      if (cmd === 'defaults' && args[0] === 'write') {
        state.writes++;
        state.saved = [...state.dock];
        state.dock.push(decodeXmlUrl(/<key>_CFURLString<\/key><string>([^<]*)<\/string>/.exec(args[4])[1]));
        return ok();
      }
      // A Dock that writes its old list back as it restarts, which undoes the change made just before.
      if (cmd === 'killall') { if (state.undo > 0 && state.saved) { state.undo--; state.dock = state.saved; } return ok(); }
      if (cmd === 'gsettings' && args[0] === '--version') return noGsettings ? no() : ok('3.38');
      if (cmd === 'gsettings' && args[0] === 'get') return ok(`[${state.favorites.map((x) => `'${x}'`).join(', ')}]`);
      if (cmd === 'gsettings' && args[0] === 'set') { state.favorites = [...args[3].matchAll(/'([^']*)'/g)].map((m) => m[1]); return ok(); }
      if (cmd === 'powershell.exe') {
        const e = opts.env;
        if (args.at(-1) === WIN_LNK_SCRIPT) {
          return ok(JSON.stringify(['Programs', 'Desktop'].map((w) => ({ path: `C:\\Users\\Ani Sirji\\${w}\\${e.PD_NAME}.lnk`, target: 'C:\\Windows\\System32\\wscript.exe', arguments: `//nologo "${e.PD_VBS}"` }))));
        }
        return ok(JSON.stringify(['C:\\Users\\Ani Sirji\\Programs\\Pocket Dev Admin.lnk']));
      }
      if (cmd === 'explorer.exe') return { status: 1, stdout: '', stderr: '' };
      return no(`unexpected ${cmd}`);
    },
  };
  return { d, files, calls, state };
}

const decodeXmlUrl = (x) => x.replaceAll('&amp;', '&');
const writes = (calls) => calls.filter((c) => c.cmd === 'defaults' && c.args[0] === 'write');
const app = '/Users/ani sirji/Applications/Pocket Dev Admin.app';

// ---- macOS -----------------------------------------------------------------------------------------------------------

test('macOS: the app is built with the logo and a launcher that quotes every path, and goes into the Dock once', () => {
  const { d, files, calls, state } = fixture('darwin');
  const r = pin(d);
  assert.equal(r.changed, true);
  assert.match(files.get(`${app}/Contents/Info.plist`).data, /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/);
  assert.equal(files.get(`${app}/Contents/Resources/AppIcon.icns`).copiedFrom, '/pkg/assets/brand/pocket-dev.icns');
  const launcher = files.get(`${app}/Contents/MacOS/PocketDevAdmin`);
  assert.equal(launcher.mode, 0o755);
  assert.match(launcher.data, /^NODE='\/opt\/my node\/bin\/node'$/m);
  assert.match(launcher.data, /^CLI='\/opt\/my node\/lib\/@anisirji\/pocket dev'\\''s\/bin\/pocket-dev\.js'$/m);
  assert.match(launcher.data, /"\$NODE" "\$CLI" admin >\/dev\/null 2>&1/);
  assert.equal(writes(calls).length, 1);
  assert.deepEqual(writes(calls)[0].args.slice(0, 4), ['write', 'com.apple.dock', 'persistent-apps', '-array-add']);
  assert.equal(state.dock.length, 1);
  assert.equal(decodeURIComponent(state.dock[0]), 'file:///Users/ani sirji/Applications/Pocket Dev Admin.app/');
  assert.equal(calls.filter((c) => c.cmd === 'killall').length, 1);
  assert.equal(readRecord(d).via, 'command');
});

test('macOS: pinning twice never adds a second Dock tile and does not restart the Dock again', () => {
  const { d, calls, state } = fixture('darwin');
  pin(d);
  calls.length = 0;
  const again = pin(d);
  assert.equal(state.dock.length, 1);
  assert.equal(writes(calls).length, 0);
  assert.equal(calls.filter((c) => c.cmd === 'killall').length, 0);
  assert.match(again.lines.join('\n'), /already in your Dock/);
});

test('macOS: other Dock tiles are left alone, in place, when pinning and unpinning', () => {
  const { d, state } = fixture('darwin', { dock: ['file:///Applications/Safari.app/', null, 'file:///Applications/Notes%20%26%20More.app/'] });
  pin(d);
  assert.equal(state.dock.length, 4);
  unpin(d);
  assert.deepEqual(state.dock, ['file:///Applications/Safari.app/', null, 'file:///Applications/Notes%20%26%20More.app/']);
});

test('macOS: unpin removes the tile, restarts the Dock, deletes the app and the record', () => {
  const { d, files, calls, state } = fixture('darwin');
  pin(d);
  calls.length = 0;
  const r = unpin(d);
  assert.equal(state.dock.length, 0);
  assert.equal(files.has(`${app}/Contents/Info.plist`), false);
  assert.equal(readRecord(d), null);
  assert.equal(calls.filter((c) => c.cmd === 'killall').length, 1);
  assert.match(r.lines.join('\n'), /Removed it from your Dock/);
  assert.equal(unpin(d).lines[0], 'Nothing to remove.');
});

test('macOS: when the Dock settings cannot be read the app is still made and the person is told what to do', () => {
  const { d, calls } = fixture('darwin', { failDock: true });
  const r = pin(d);
  assert.match(r.lines.join('\n'), /Drag the app/);
  assert.equal(writes(calls).length, 0);
});

test('macOS: nothing here needs administrator rights', () => {
  const { d, calls } = fixture('darwin');
  pin(d);
  assert.equal(calls.some((c) => /^(sudo|osascript)$/.test(c.cmd) || c.args.includes('sudo')), false);
});

// ---- Windows ---------------------------------------------------------------------------------------------------------

test('Windows: shortcuts go to the Start menu and Desktop, the script gets paths through the environment, and the person is told to pin', () => {
  const { d, files, calls } = fixture('win32');
  const r = pin(d);
  const dir = 'C:\\Users\\Ani Sirji\\AppData\\Roaming\\Pocket Dev';
  const vbs = files.get(`${dir}\\pocket-dev-admin.vbs`).data;
  assert.match(vbs, /sh\.Run\("""\/opt\/my node\/bin\/node"" ""\/opt\/my node\/lib\/@anisirji\/pocket dev's\/bin\/pocket-dev\.js"" admin", 0, True\)/);
  assert.match(vbs, /MsgBox "Pocket Dev is not running\./);
  assert.equal(files.get(`${dir}\\pocket-dev.ico`).copiedFrom, '/pkg/assets/brand/pocket-dev.ico');
  const ps = calls.find((c) => c.cmd === 'powershell.exe');
  assert.equal(ps.env.PD_NAME, 'Pocket Dev Admin');
  assert.equal(ps.env.PD_VBS, `${dir}\\pocket-dev-admin.vbs`);
  assert.equal(ps.env.PD_ICO, `${dir}\\pocket-dev.ico`);
  assert.equal(ps.args.includes(WIN_LNK_SCRIPT), true);
  assert.equal(WIN_LNK_SCRIPT.includes('Ani Sirji'), false);
  assert.match(WIN_LNK_SCRIPT, /wscript\.exe/);
  assert.match(r.lines.join('\n'), /Windows requires you to pin it yourself: right-click "Pocket Dev Admin" and choose Pin to taskbar/);
  assert.equal(calls.some((c) => c.cmd === 'explorer.exe' && c.args[0].startsWith('/select,')), true);
});

test('Windows: a quiet pin (the install) opens no Explorer window; pinning again recreates the same two shortcuts', () => {
  const { d, calls } = fixture('win32');
  pin(d, { via: 'install', quiet: true });
  pin(d, { via: 'install', quiet: true });
  assert.equal(calls.some((c) => c.cmd === 'explorer.exe'), false);
  assert.equal(calls.filter((c) => c.cmd === 'powershell.exe').length, 2);
  assert.equal(readRecord(d).via, 'install');
});

test('Windows: unpin deletes the shortcuts, the launcher and the icon and says how to unpin from the taskbar', () => {
  const { d, files } = fixture('win32');
  pin(d);
  const r = unpin(d);
  assert.equal([...files.keys()].some((k) => k.includes('pocket-dev-admin.vbs') || k.endsWith('pocket-dev.ico')), false);
  assert.match(r.lines.join('\n'), /Unpin from taskbar/);
});

test('Windows: the launcher text doubles quotes so a path cannot break out of the script', () => {
  const vbs = winVbs({ node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\a b\\bin\\pocket-dev.js' });
  assert.match(vbs, /sh\.Run\("""C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\a b\\bin\\pocket-dev\.js"" admin", 0, True\)/);
});

// ---- Linux -----------------------------------------------------------------------------------------------------------

const entry = '/Users/ani sirji/.local/share/applications/pocket-dev-admin.desktop';

test('Linux: the applications menu entry, launcher script and logo icons are written, and GNOME gets the favourite once', () => {
  const { d, files, state } = fixture('linux', { gnome: true, favorites: ['firefox.desktop'] });
  pin(d);
  const text = files.get(entry).data;
  assert.match(text, /^Exec="\/Users\/ani sirji\/\.local\/share\/pocket-dev\/pocket-dev-admin\.sh"$/m);
  assert.match(text, /^Icon=pocket-dev-admin$/m);
  assert.equal(files.get('/Users/ani sirji/.local/share/icons/hicolor/256x256/apps/pocket-dev-admin.png').copiedFrom, '/pkg/assets/brand/png/pocket-dev-256.png');
  assert.equal(files.get('/Users/ani sirji/.local/share/icons/hicolor/scalable/apps/pocket-dev-admin.svg').copiedFrom, '/pkg/assets/brand/pocket-dev.svg');
  assert.equal(files.get('/Users/ani sirji/.local/share/pocket-dev/pocket-dev-admin.sh').mode, 0o755);
  assert.deepEqual(state.favorites, ['firefox.desktop', 'pocket-dev-admin.desktop']);
  pin(d);
  assert.deepEqual(state.favorites, ['firefox.desktop', 'pocket-dev-admin.desktop']);
});

test('Linux: unpin takes it out of the favourites and deletes the files', () => {
  const { d, files, state } = fixture('linux', { gnome: true, favorites: ['firefox.desktop'] });
  pin(d);
  unpin(d);
  assert.deepEqual(state.favorites, ['firefox.desktop']);
  assert.equal(files.has(entry), false);
});

test('Linux: a desktop that is not GNOME stops at the applications menu and says so', () => {
  const { d, calls } = fixture('linux', { env: { XDG_CURRENT_DESKTOP: 'KDE' } });
  const r = pin(d);
  assert.match(r.lines.join('\n'), /not GNOME/);
  assert.equal(calls.some((c) => c.cmd === 'gsettings' && c.args[0] === 'set'), false);
});

test('Linux: the Exec line quotes characters that the desktop entry format treats specially', () => {
  const text = linuxEntry({ home: '/home/a', env: { XDG_DATA_HOME: '/data/with "quote" and $x and 100%' } });
  assert.match(text, /^Exec="\/data\/with \\"quote\\" and \\\$x and 100%%\/pocket-dev\/pocket-dev-admin\.sh"$/m);
});

// ---- The launchers really run -----------------------------------------------------------------------------------------

test('the shell launcher opens nothing and says so when Pocket Dev is not running, and stays quiet when it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-launcher-'));
  const bin = path.join(dir, 'a bin');
  fs.mkdirSync(bin);
  const fakeNode = path.join(bin, 'node');
  const note = path.join(dir, 'note');
  fs.writeFileSync(fakeNode, '#!/bin/sh\n[ -f "$PD_UP" ] && exit 0\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\nprintf '%s | %s' "$1" "$2" > ${shq(note)}\n`, { mode: 0o755 });
  const script = path.join(dir, 'launch.sh');
  fs.writeFileSync(script, linuxLauncher({ node: fakeNode, cli: '/x/pocket dev/cli.js' }), { mode: 0o755 });
  const run = (extra) => spawnSync('/bin/sh', [script], { env: { PATH: `${bin}:/usr/bin:/bin`, ...extra } });
  assert.equal(run({}).status, 0);
  assert.match(fs.readFileSync(note, 'utf8'), /^Pocket Dev Admin \| Pocket Dev is not running\. Start it with: pocket-dev start/);
  fs.rmSync(note);
  fs.writeFileSync(path.join(dir, 'up'), '');
  assert.equal(run({ PD_UP: path.join(dir, 'up') }).status, 0);
  assert.equal(fs.existsSync(note), false);
  fs.rmSync(dir, { recursive: true });
});

test('the macOS launcher shows a dialog instead of a silent failure', () => {
  assert.match(macLauncher({ node: NODE, cli: CLI }), /osascript -e 'display dialog "Pocket Dev is not running\./);
});

test('pocket-dev admin in a folder with no running server prints the plain message and fails', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-admin-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pocket-dev.js'), 'admin'], { env: { ...process.env, POCKET_DEV_STATE_DIR: state }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Pocket Dev is not running\. Start it with: pocket-dev start/);
  fs.rmSync(state, { recursive: true });
});

// ---- Setup step ------------------------------------------------------------------------------------------------------

function setupCtx(d, answers = []) {
  const out = [];
  return { out, pin: d, log() {}, ask: async () => answers.shift() ?? true };
}
const ask = async (ctx, opts, question, def) => (opts.yes ? def : ctx.ask(question, def));

test('setup step: shows exactly what it will change, asks once, and Enter (yes) does it', async () => {
  const { d, state } = fixture('darwin');
  const ctx = setupCtx(d);
  const lines = [];
  ctx.out = (l) => lines.push(l);
  await pinStep(ctx, {}, ask);
  const text = lines.join('\n');
  assert.match(text, /Will write: \/Users\/ani sirji\/Applications\/Pocket Dev Admin\.app/);
  assert.match(text, /Will run: defaults write com\.apple\.dock persistent-apps -array-add/);
  assert.match(text, /Nothing needs administrator rights/);
  assert.equal(state.dock.length, 1);
});

test('setup step: declining changes nothing and prints the command for later', async () => {
  const { d, state, files } = fixture('darwin');
  const lines = [];
  const ctx = { ...setupCtx(d, [false]), out: (l) => lines.push(l) };
  await pinStep(ctx, {}, ask);
  assert.equal(state.dock.length, 0);
  assert.equal(files.size, 0);
  assert.match(lines.join('\n'), new RegExp(`Skipped. Add it later with: ${PIN_COMMAND}`));
});

test('setup step: --yes accepts, --dry-run only shows', async () => {
  const yesRun = fixture('darwin');
  await pinStep({ ...setupCtx(yesRun.d), out() {} }, { yes: true }, ask);
  assert.equal(yesRun.state.dock.length, 1);
  const dryRun = fixture('darwin');
  const lines = [];
  await pinStep({ ...setupCtx(dryRun.d), out: (l) => lines.push(l) }, { dry: true }, ask);
  assert.equal(dryRun.state.dock.length, 0);
  assert.equal(dryRun.calls.filter((c) => c.cmd === 'defaults' && c.args[0] !== 'export').length, 0);
  assert.equal(dryRun.files.size, 0);
  assert.match(lines.join('\n'), /dry run: not asked, not run/);
});

test('setup step: already added at install shows as done and asks nothing', async () => {
  const { d } = fixture('darwin');
  pin(d, { via: 'install', quiet: true });
  const lines = [];
  let asked = false;
  await pinStep({ ...setupCtx(d), out: (l) => lines.push(l) }, {}, async () => { asked = true; return true; });
  assert.equal(asked, false);
  assert.match(lines.join('\n'), /Done: it was added when Pocket Dev was installed/);
});

test('setup step: the install ran with --ignore-scripts (no record, nothing pinned), so the step still offers it', async () => {
  const { d } = fixture('darwin');
  let asked = false;
  await pinStep({ ...setupCtx(d), out() {} }, {}, async () => { asked = true; return true; });
  assert.equal(asked, true);
});

test('setup step: a context without a pin helper skips the step silently, and an unsupported system says so', async () => {
  const lines = [];
  await pinStep({ out: (l) => lines.push(l) }, {}, ask);
  assert.deepEqual(lines, []);
  const { d } = fixture('freebsd');
  await pinStep({ ...setupCtx(d), out: (l) => lines.push(l) }, {}, ask);
  assert.match(lines.join('\n'), /not supported on freebsd/);
});

test('setup check (non-interactive): prints the command to run, or the state when it is already there', () => {
  const { d } = fixture('darwin');
  assert.equal(pinCheckLine({ pin: d }), `✗ Admin shortcut: not added yet. Run: ${PIN_COMMAND}`);
  pin(d, { via: 'install' });
  assert.equal(pinCheckLine({ pin: d }), '✓ Admin shortcut: in your Dock (added at install)');
  assert.equal(pinCheckLine({}), null);
});

test('describePin lists the changes for each system', () => {
  assert.equal(describePin(fixture('darwin').d).length, 2);
  assert.equal(describePin(fixture('win32').d).length, 2);
  assert.match(describePin(fixture('linux', { gnome: true }).d)[1].lines[0], /gsettings set org\.gnome\.shell favorite-apps/);
});

// ---- The command -----------------------------------------------------------------------------------------------------

test('pocket-dev admin pin, pin --status and unpin', async () => {
  const { d } = fixture('darwin');
  const out = [];
  const say = (l) => out.push(l);
  assert.equal(await pinCommand(['pin', '--status'], d, say), 1);
  assert.match(out.at(-1), /not added yet/);
  assert.equal(await pinCommand(['pin'], d, say), 0);
  assert.equal(await pinCommand(['pin', '--status'], d, say), 0);
  assert.match(out.at(-1), /in your Dock \(added by pocket-dev admin pin on 2026-11-17\)/);
  assert.equal(await pinCommand(['unpin'], d, say), 0);
  assert.equal(await pinCommand(['pin', '--status'], d, say), 1);
  assert.equal(await pinCommand(['pin', '--wat'], d, say), 2);
  assert.equal(await pinCommand(['unpin', '--status'], d, say), 2);
});

// ---- The install hook ------------------------------------------------------------------------------------------------

const GLOBAL = { npm_config_global: 'true' };

test('postinstall: does nothing for a local install, npx, CI, the opt-out or an unsupported system', () => {
  const cases = [
    [{}, 'darwin'], [{ npm_config_global: 'false' }, 'darwin'], [{ ...GLOBAL, CI: 'true' }, 'darwin'], [{ ...GLOBAL, CI: '1' }, 'win32'],
    [{ ...GLOBAL, POCKET_DEV_NO_PIN: '1' }, 'darwin'], [GLOBAL, 'freebsd'], [GLOBAL, 'linux'],
  ];
  for (const [env, platform] of cases) {
    const { d, calls, files } = fixture(platform);
    assert.equal(postinstallPin(env, d), null, JSON.stringify([env, platform]));
    assert.equal(calls.length, 0);
    assert.equal(files.size, 0);
  }
});

test('postinstall: a global install on a desktop pins, prints one plain line, and records it', () => {
  const mac = fixture('darwin');
  const line = postinstallPin(GLOBAL, mac.d);
  assert.match(line, /^Pocket Dev: added a "Pocket Dev Admin" tile to your Dock\. Undo: pocket-dev admin unpin\. Skip next time: POCKET_DEV_NO_PIN=1\.$/);
  assert.equal(readRecord(mac.d).via, 'install');
  assert.equal(readRecord(mac.d).platform, 'darwin');
  const win32 = fixture('win32');
  assert.match(postinstallPin(GLOBAL, win32.d), /Desktop and Start menu\. Windows needs you to right-click one and choose Pin to taskbar/);
  const linux = fixture('linux', { gnome: true, env: { DISPLAY: ':0' } });
  assert.match(postinstallPin({ ...GLOBAL, DISPLAY: ':0' }, linux.d), /applications menu and GNOME favourites/);
});

test('postinstall: running it again (npm update) re-points the launcher and adds no second tile', () => {
  const { d, files, state } = fixture('darwin');
  postinstallPin(GLOBAL, d);
  d.node = '/new/node';
  d.cli = '/new prefix/bin/pocket-dev.js';
  postinstallPin(GLOBAL, d);
  assert.equal(state.dock.length, 1);
  assert.match(files.get(`${app}/Contents/MacOS/PocketDevAdmin`).data, /^CLI='\/new prefix\/bin\/pocket-dev\.js'$/m);
});

test('postinstall: never throws, whatever fails', () => {
  const { d } = fixture('darwin');
  d.run = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => postinstallPin(GLOBAL, d));
  const broken = fixture('darwin').d;
  broken.fs.write = () => { throw new Error('disk full'); };
  assert.match(postinstallPin(GLOBAL, broken), /could not add the Admin shortcut/);
  assert.equal(postinstallPin(GLOBAL, null), null);
});

test('scripts/postinstall.js exits 0 and prints nothing unless it is a global install', () => {
  const env = { ...process.env, POCKET_DEV_NO_PIN: '1', POCKET_DEV_NO_CAMERA_INSTALL: '1', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-post-')) };
  delete env.npm_config_global;
  for (const extra of [{}, { npm_config_global: 'true' }, { npm_config_global: 'true', CI: 'true' }]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'postinstall.js')], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('package.json runs the install hook and ships the logo', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node scripts/postinstall.js || exit 0');
  assert.ok(pkg.files.includes('assets'));
  for (const f of ['pocket-dev.icns', 'pocket-dev.ico', 'pocket-dev.svg', 'png/pocket-dev-256.png']) assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'brand', f)), f);
  assert.equal(fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'), 'utf8'), fs.readFileSync(path.join(ROOT, 'assets', 'brand', 'pocket-dev.svg'), 'utf8'));
});

test('the Dock tile list is read from XML with binary data, nested dictionaries, spacers and escaped characters', () => {
  const xml = arrayXml(['file:///System/Applications/Launchpad.app/', null, 'file:///Applications/A%20%26%20B.app/']);
  assert.deepEqual(parseDockUrls(xml), ['file:///System/Applications/Launchpad.app/', null, 'file:///Applications/A%20%26%20B.app/']);
  assert.deepEqual(parseDockUrls('<array/>'), []);
  assert.deepEqual(parseDockUrls(''), []);
});

test('macOS: a Dock that writes its old list back as it restarts is checked and the change is made again', () => {
  const removing = fixture('darwin', { stubborn: 1 });
  pin(removing.d);
  removing.state.undo = 0;
  assert.equal(removing.state.dock.length, 1);
  removing.state.undo = 1;
  const r = unpin(removing.d);
  assert.equal(removing.state.dock.length, 0);
  assert.equal(removing.state.imports, 2);
  assert.match(r.lines.join('\n'), /Removed it from your Dock/);
  const adding = fixture('darwin', { stubborn: 1 });
  const p = pin(adding.d);
  assert.equal(adding.state.dock.length, 1);
  assert.equal(adding.state.writes, 2);
  assert.match(p.lines.join('\n'), /Added it to your Dock/);
});

test('macOS: a Dock that never keeps the change gets plain instructions instead of a false success', () => {
  const adding = fixture('darwin', { stubborn: 99 });
  assert.match(pin(adding.d).lines.join('\n'), /Drag the app from Applications into the Dock yourself/);
  const removing = fixture('darwin');
  pin(removing.d);
  removing.state.undo = 99;
  assert.match(unpin(removing.d).lines.join('\n'), /Right-click it, choose Options, then Remove from Dock/);
});

test('the install hook cannot fail an install even when the module it needs is missing or broken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-hook-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'postinstall.js'), path.join(dir, 'scripts', 'postinstall.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, npm_config_global: 'true', HOME: dir };
  delete env.CI;
  const run = () => spawnSync(process.execPath, ['scripts/postinstall.js'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(run().status, 0, 'taskbar-pin.js is missing');
  fs.mkdirSync(path.join(dir, 'src', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'setup', 'taskbar-pin.js'), 'throw new Error("broken");');
  const r = run();
  assert.equal(r.status, 0, 'taskbar-pin.js throws');
  assert.equal(r.stdout, '');
  // and with the script itself gone, the `|| exit 0` in package.json is what keeps npm happy
  const shell = process.platform === 'win32' ? ['cmd', ['/c', 'node scripts/missing.js || exit 0']] : ['/bin/sh', ['-c', 'node scripts/missing.js || exit 0']];
  assert.equal(spawnSync(shell[0], shell[1], { cwd: dir, encoding: 'utf8' }).status, 0);
  fs.rmSync(dir, { recursive: true });
});
