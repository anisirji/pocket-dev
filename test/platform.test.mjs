import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatform, NO_WINDOWS_ZIP } from '../platform.js';

function fake(opts = {}) {
  const calls = [];
  const launched = [];
  const p = createPlatform({
    env: { PATH: '/usr/bin:/bin' },
    run: async (cmd, args, o) => { calls.push({ cmd, args, env: o?.env }); return opts.result ?? { code: 0, stdout: '[]', stderr: '' }; },
    launch: (cmd, args) => launched.push({ cmd, args }),
    exists: (f) => (opts.files ?? []).includes(f),
    ...opts.platformOpts,
    platform: opts.os,
  });
  return { p, calls, launched };
}

test('Mac trash runs the same osascript command as before and passes paths as argv', async () => {
  const { p, calls } = fake({ os: 'darwin', result: { code: 0, stdout: '[{"trashPath":"/Users/a/.Trash/x"}]', stderr: '' } });
  assert.deepEqual(await p.trash(['/tmp/x']), [{ trashPath: '/Users/a/.Trash/x' }]);
  assert.equal(calls[0].cmd, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(calls[0].args[3], /trashItemAtURLResultingItemURLError/);
  assert.deepEqual(calls[0].args.slice(4), ['/tmp/x']);
});

test('Mac trash reports the tool error when it prints no JSON', async () => {
  const { p } = fake({ os: 'darwin', result: { code: 1, stdout: '', stderr: 'boom\n' } });
  await assert.rejects(p.trash(['/tmp/x']), /Could not move to the Trash: boom/);
});

test('Windows trash uses PowerShell with the Recycle Bin and sends paths in the environment', async () => {
  const { p, calls } = fake({ os: 'win32', result: { code: 0, stdout: '[{"trashPath":null},{"error":"in use"}]', stderr: '' } });
  assert.deepEqual(await p.trash(['C:\\a b\\x', "C:\\it's"]), [{ trashPath: null }, { error: 'in use' }]);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /Microsoft\.VisualBasic/);
  assert.match(calls[0].args.at(-1), /SendToRecycleBin/);
  assert.equal(calls[0].args.some((a) => a.includes('C:\\a b')), false, 'paths are not spliced into the command');
  assert.deepEqual(JSON.parse(calls[0].env.POCKET_DEV_PATHS), ['C:\\a b\\x', "C:\\it's"]);
});

test('Linux trash uses gio when it is installed, one call per path', async () => {
  const { p, calls } = fake({ os: 'linux', files: ['/usr/bin/gio'], result: { code: 0, stdout: '', stderr: '' } });
  assert.deepEqual(await p.trash(['/tmp/a', '/tmp/b']), [{ trashPath: null }, { trashPath: null }]);
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['gio', 'trash', '--', '/tmp/a'], ['gio', 'trash', '--', '/tmp/b']]);
});

test('Linux trash reports a gio failure per path', async () => {
  const { p } = fake({ os: 'linux', files: ['/usr/bin/gio'], result: { code: 1, stdout: '', stderr: 'denied\n' } });
  assert.deepEqual(await p.trash(['/tmp/a']), [{ error: 'denied' }]);
});

test('Linux trash without gio moves the file into the XDG Trash with a .trashinfo, and keeps names apart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-xdg-'));
  try {
    const data = path.join(dir, 'data');
    const { p, calls } = fake({ os: 'linux', platformOpts: { env: { PATH: '/nowhere', XDG_DATA_HOME: data } } });
    const a = path.join(dir, 'note.txt');
    fs.writeFileSync(a, 'one');
    const [r1] = await p.trash([a]);
    assert.equal(r1.trashPath, path.join(data, 'Trash', 'files', 'note.txt'));
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.readFileSync(r1.trashPath, 'utf8'), 'one');
    assert.match(fs.readFileSync(path.join(data, 'Trash', 'info', 'note.txt.trashinfo'), 'utf8'), /^\[Trash Info\]\nPath=.*note\.txt\nDeletionDate=\d{4}-/);
    fs.writeFileSync(a, 'two');
    const [r2] = await p.trash([a]);
    assert.equal(r2.trashPath, path.join(data, 'Trash', 'files', 'note 1.txt'));
    const [r3] = await p.trash([path.join(dir, 'missing')]);
    assert.match(r3.error, /Could not move to the Trash/);
    assert.equal(calls.length, 0, 'no external command runs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open a URL: open on Mac, xdg-open on Linux, start on Windows', () => {
  const url = 'http://127.0.0.1:3001/';
  const mac = fake({ os: 'darwin' });
  assert.equal(mac.p.openUrl(url), true);
  assert.deepEqual(mac.launched, [{ cmd: 'open', args: [url] }]);
  const linux = fake({ os: 'linux', files: ['/usr/bin/xdg-open'] });
  assert.equal(linux.p.openUrl(url), true);
  assert.deepEqual(linux.launched, [{ cmd: 'xdg-open', args: [url] }]);
  const win = fake({ os: 'win32', platformOpts: { env: { PATH: 'C:\\Windows' } } });
  assert.equal(win.p.openUrl(url), true);
  assert.deepEqual(win.launched, [{ cmd: 'cmd', args: ['/c', 'start', '""', url] }]);
});

test('open a URL on Linux without xdg-open launches nothing and says why', () => {
  const { p, launched } = fake({ os: 'linux' });
  assert.equal(p.openUrl('http://x/'), false);
  assert.deepEqual(launched, []);
  assert.match(p.capabilities().openUrl.reason, /xdg-open/);
});

test('default shell: $SHELL first, else /bin/zsh on Mac, zsh then bash on Linux, PowerShell on Windows', () => {
  const sh = (os, files = [], env = {}) => fake({ os, files, platformOpts: { env } }).p.defaultShell();
  assert.equal(sh('darwin', [], { SHELL: '/opt/homebrew/bin/fish' }), '/opt/homebrew/bin/fish');
  assert.equal(sh('darwin'), '/bin/zsh');
  assert.equal(sh('linux', ['/usr/bin/zsh', '/bin/bash']), '/usr/bin/zsh');
  assert.equal(sh('linux', ['/bin/bash']), '/bin/bash');
  assert.equal(sh('linux'), '/bin/sh');
  assert.equal(sh('win32'), 'powershell.exe');
  assert.equal(sh('win32', [], { SHELL: 'C:\\git\\bash.exe' }), 'C:\\git\\bash.exe');
});

test('zip: Mac keeps /usr/bin/zip and its exact arguments; Linux uses zip when present', () => {
  const args = ['-q', '-nw', '-@', '-'];
  assert.deepEqual(fake({ os: 'darwin' }).p.zipCommand(), { available: true, cmd: '/usr/bin/zip', args });
  assert.deepEqual(fake({ os: 'linux', files: ['/bin/zip'] }).p.zipCommand(), { available: true, cmd: '/bin/zip', args });
});

test('zip reports clearly when it cannot run: Windows needs tar.exe, Linux needs the zip program', () => {
  const win = fake({ os: 'win32' }).p.zipCommand();
  assert.deepEqual(win, { available: false, reason: NO_WINDOWS_ZIP });
  assert.match(win.reason, /tar\.exe/);
  const linux = fake({ os: 'linux' }).p.zipCommand();
  assert.equal(linux.available, false);
  assert.match(linux.reason, /zip program/);
});

test('capabilities says which actions this system can do', () => {
  const caps = (os, files) => fake({ os, files }).p.capabilities();
  const mac = caps('darwin', []);
  assert.deepEqual([mac.trash.available, mac.openUrl.available, mac.shell.available, mac.zip.available], [true, true, true, true]);
  const win = caps('win32', []);
  assert.equal(win.zip.available, false);
  assert.equal(win.trash.via, 'PowerShell');
  const bare = caps('linux', []);
  assert.deepEqual([bare.openUrl.available, bare.zip.available, bare.trash.via], [false, false, 'XDG Trash folder']);
  assert.equal(caps('linux', ['/usr/bin/gio', '/usr/bin/xdg-open', '/usr/bin/zip']).trash.via, 'gio');
});
