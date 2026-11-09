import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatform, parseBatt } from '../platform.js';
import { servicePlan, parseServiceStatus } from '../platform-service.js';
import { startServer } from './helpers/server.mjs';

// `files` is the set of programs found on PATH (as /usr/bin/<name>) and `sys` maps /sys and /proc paths to text.
function fake({ os: system, files = [], sys = {}, answer = () => ({ code: 0, stdout: '', stderr: '' }), env = {}, nics, mem } = {}) {
  const calls = [];
  const launched = [];
  const p = createPlatform({
    platform: system, env: { PATH: '/usr/bin', ...env }, home: '/home/a', user: 'a', uid: 501, repoDir: '/repo',
    run: async (cmd, args, o) => { calls.push({ cmd, args, o }); return { signal: null, ...answer(cmd, args, o) }; },
    launch: (cmd, args) => launched.push({ cmd, args }),
    exists: (f) => files.some((n) => f === `/usr/bin/${n}` || f === n),
    readText: (f) => sys[f] ?? null,
    listDir: (d) => [...new Set(Object.keys(sys).filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1).split('/')[0]))],
    networkInterfaces: () => nics ?? {},
    memory: () => mem ?? { total: 8 * 1024 ** 3, free: 2 * 1024 ** 3 },
    hostname: () => 'My-Box',
  });
  return { p, calls, launched };
}

const OUT = (stdout) => () => ({ code: 0, stdout, stderr: '' });

test('Mac power commands are the same programs and arguments as before', async () => {
  const { p, calls } = fake({ os: 'darwin', answer: OUT("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t82%; charging; 0:45 remaining present: true") });
  assert.deepEqual(await p.battery(), { onAC: true, battery: 82, charging: true, timeRemaining: 45 });
  assert.deepEqual([calls[0].cmd, calls[0].args, calls[0].o.timeout], ['/usr/bin/pmset', ['-g', 'batt'], 5000]);
  assert.deepEqual(p.keepAwakeCommand('plugged', 42), { cmd: '/usr/bin/caffeinate', args: ['-s', '-w', '42'] });
  assert.deepEqual(p.keepAwakeCommand('always', 42), { cmd: '/usr/bin/caffeinate', args: ['-i', '-s', '-w', '42'] });
  assert.equal(p.keepAwakeCommand('off', 42), null);
  calls.length = 0;
  await p.sleepNow();
  assert.deepEqual([calls[0].cmd, calls[0].args], ['/usr/bin/pmset', ['sleepnow']]);
  calls.length = 0;
  await p.shutDown();
  assert.deepEqual([calls[0].cmd, calls[0].args], ['/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down']]);
  assert.equal(parseBatt('nothing').battery, null);
});

test('Mac shutdown turns an Automation refusal into the help text, and a timeout into the prompt hint', async () => {
  const refused = fake({ os: 'darwin', answer: () => ({ code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events (-1743)' }) });
  await assert.rejects(refused.p.shutDown(), /allow node to control System Events/);
  const timedOut = fake({ os: 'darwin', answer: () => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: '' }) });
  await assert.rejects(timedOut.p.shutDown(), /may be asking on the Mac/);
});

test('Linux power: systemd-inhibit, systemctl and the battery read from /sys', async () => {
  const sys = {
    '/sys/class/power_supply/BAT0/type': 'Battery\n', '/sys/class/power_supply/BAT0/capacity': '55\n', '/sys/class/power_supply/BAT0/status': 'Discharging\n',
    '/sys/class/power_supply/BAT0/energy_now': '30000000\n', '/sys/class/power_supply/BAT0/power_now': '15000000\n', '/sys/class/power_supply/BAT0/temp': '312\n',
    '/sys/class/power_supply/BAT0/cycle_count': '210\n', '/sys/class/power_supply/BAT0/energy_full': '40000000\n', '/sys/class/power_supply/BAT0/energy_full_design': '50000000\n',
    '/sys/class/power_supply/AC/type': 'Mains\n', '/sys/class/power_supply/AC/online': '0\n',
    '/proc/acpi/button/lid/LID0/state': 'state:      closed\n',
  };
  const { p, calls } = fake({ os: 'linux', files: ['systemd-inhibit', 'systemctl'], sys });
  assert.deepEqual(await p.battery(), { onAC: false, battery: 55, charging: false, timeRemaining: 120 });
  assert.deepEqual(await p.temperatures(), { batteryC: 31.2, thermal: null });
  assert.deepEqual(await p.batteryCondition(), { cycles: 210, designCycles: null, capacityPercent: 80 });
  assert.deepEqual(await p.lid(), { closed: true, sleepDisabled: null });
  assert.equal(calls.length, 0, 'no program runs for these readings');
  const k = p.keepAwakeCommand('always', 7);
  assert.equal(k.cmd, 'systemd-inhibit');
  assert.deepEqual(k.args.slice(-4), ['tail', '--pid=7', '-f', '/dev/null']);
  await p.sleepNow();
  await p.shutDown();
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['systemctl', 'suspend'], ['systemctl', 'poweroff']]);
  assert.deepEqual(await p.sleepHolds(7), { PreventSystemSleep: 0, PreventUserIdleSystemSleep: 0, heldByPocketDev: [] });
  assert.equal(await p.updateInProgress(), false);
});

test('Windows power: PowerShell for the battery, SetThreadExecutionState to stay awake, rundll32 and shutdown.exe', async () => {
  const { p, calls } = fake({ os: 'win32', answer: OUT('{"percent":40,"status":6,"minutes":71582788}') });
  assert.deepEqual(await p.battery(), { onAC: true, battery: 40, charging: true, timeRemaining: null });
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /Win32_Battery/);
  const k = p.keepAwakeCommand('plugged', 99);
  assert.equal(k.cmd, 'powershell.exe');
  assert.match(k.args.at(-1), /SetThreadExecutionState\(0x80000001\)/);
  assert.match(k.args.at(-1), /Wait-Process -Id 99/);
  calls.length = 0;
  await p.sleepNow();
  await p.shutDown();
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'], ['shutdown.exe', '/s', '/t', '0']]);
  assert.deepEqual(await p.lid(), { closed: null, sleepDisabled: null });
  assert.equal(await p.batteryCondition(), null);
});

test('a desktop with no battery reads as plugged in with no percentage', async () => {
  assert.deepEqual(await fake({ os: 'linux' }).p.battery(), { onAC: true, battery: null, charging: false, timeRemaining: null });
  assert.deepEqual(await fake({ os: 'win32', answer: OUT('{}') }).p.battery(), { onAC: true, battery: null, charging: false, timeRemaining: null });
});

test('unsupported actions reject with a reason instead of running anything', async () => {
  const { p, calls } = fake({ os: 'linux' });
  const caps = p.capabilities();
  for (const key of ['keepAwake', 'sleepNow', 'shutDown', 'apps', 'service', 'screenshot', 'imageResize']) {
    assert.equal(caps[key].available, false, key);
    assert.ok(caps[key].reason.length > 10, key);
  }
  await assert.rejects(p.sleepNow(), /Not available on this system: .*systemctl/);
  await assert.rejects(p.shutDown(), /Not available on this system/);
  await assert.rejects(p.listApps(), /wmctrl/);
  await assert.rejects(p.screenshot('/tmp'), /Not available on this system/);
  assert.equal(calls.length, 0);
  assert.match(fake({ os: 'win32' }).p.capabilities().temperature.reason, /Windows/);
  assert.match(p.capabilities().permissions.reason, /no per-app privacy/);
  assert.match(p.capabilities().mdns.reason, /Only a Mac/);
  assert.deepEqual(Object.keys(p.unsupported(['sleepNow', 'cpu'])), ['sleepNow']);
});

test('on a Mac every capability is available', () => {
  const caps = fake({ os: 'darwin' }).p.capabilities();
  assert.deepEqual(Object.entries(caps).filter(([, c]) => !c.available).map(([k]) => k), []);
});

test('health: top and memory_pressure on Mac, os memory elsewhere', async () => {
  const mac = fake({ os: 'darwin', answer: (cmd) => ({ code: 0, stderr: '', stdout: cmd.endsWith('top')
    ? 'CPU usage: 1.0% user, 2.0% sys, 90.0% idle\nPhysMem: 7514M used (1220M wired, 3272M compressor), 97M unused.\n' : 'System-wide memory free percentage: 37%\n' }) });
  assert.deepEqual(await mac.p.cpuMemory(), { cpuUsedPercent: 10, memory: { usedMB: 7514, wiredMB: 1220, compressedMB: 3272 } });
  assert.equal(await mac.p.memoryFreePercent(), 37);
  assert.deepEqual(mac.calls[0].args, ['-l', '2', '-n', '0', '-s', '1']);
  const linux = fake({ os: 'linux' });
  assert.deepEqual(await linux.p.cpuMemory(), { cpuUsedPercent: null, memory: { usedMB: 6144, wiredMB: null, compressedMB: null } });
  assert.equal(await linux.p.memoryFreePercent(), 25);
  assert.equal(linux.calls.length, 0);
});

test('open apps: JXA on Mac, wmctrl and ps on Linux, Get-Process on Windows; quit per system', async () => {
  const mac = fake({ os: 'darwin', answer: OUT('[{"name":"Safari","pid":5}]') });
  assert.deepEqual(await mac.p.listApps(), [{ name: 'Safari', pid: 5 }]);
  assert.deepEqual(mac.calls[0].args.slice(0, 2), ['-l', 'JavaScript']);
  await mac.p.quitApp(5);
  assert.equal(mac.calls[1].args.at(-1), '5');
  assert.match(mac.calls[1].args.at(-2), /terminate/);

  const linux = fake({ os: 'linux', files: ['wmctrl'], answer: (cmd) => ({ code: 0, stderr: '', stdout: cmd === 'wmctrl'
    ? '0x01 0 321 host Terminal\n0x02 0 654 host Browser\n' : ' 321 gnome-terminal-\n 654 firefox\n   1 init\n' }) });
  assert.deepEqual((await linux.p.listApps()).map((a) => [a.name, a.pid]), [['gnome-terminal-', 321], ['firefox', 654]]);
  await linux.p.quitApp(654);
  assert.deepEqual([linux.calls.at(-1).cmd, linux.calls.at(-1).args], ['kill', ['-TERM', '654']]);
  assert.ok(linux.p.systemApps().has('gnome-shell'));

  const win = fake({ os: 'win32', answer: OUT('[{"name":"chrome","pid":12,"title":"x"}]') });
  assert.deepEqual(await win.p.listApps(), [{ name: 'chrome', bundleId: null, pid: 12, frontmost: false, hidden: false }]);
  await win.p.quitApp(12);
  assert.match(win.calls.at(-1).args.at(-1), /Get-Process -Id 12\)\.CloseMainWindow/);
  assert.ok(win.p.systemApps().has('explorer'));
  await assert.rejects(win.p.appWindows(12), /only available on macOS/);
});

test('screenshot and resize: Mac keeps screencapture and sips; Linux and Windows use their own tools', async () => {
  const mac = fake({ os: 'darwin', answer: OUT('  pixelWidth: 3000\n  pixelHeight: 2000\n') });
  assert.equal(await mac.p.screenshot('/t'), '/t/raw.jpg');
  assert.deepEqual([mac.calls[0].cmd, mac.calls[0].args], ['/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', '/t/raw.jpg']]);
  await mac.p.resizeImage({ input: '/t/raw.jpg', output: '/t/small.jpg', side: 1600, quality: 60, onlyShrink: true });
  assert.deepEqual(mac.calls.slice(1).map((c) => c.args), [
    ['-g', 'pixelWidth', '-g', 'pixelHeight', '/t/raw.jpg'],
    ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', '/t/raw.jpg', '--out', '/t/small.jpg'],
  ]);
  const small = fake({ os: 'darwin', answer: OUT('  pixelWidth: 800\n  pixelHeight: 600\n') });
  await small.p.resizeImage({ input: 'a', output: 'b', side: 1600, quality: 60, onlyShrink: true });
  assert.deepEqual(small.calls[1].args.slice(0, 2), ['-s', 'format'], 'a small picture is not enlarged');
  const thumb = fake({ os: 'darwin' });
  await thumb.p.resizeImage({ input: 'a', output: 'b', side: 480, quality: 70 });
  assert.deepEqual(thumb.calls.map((c) => c.args), [['-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', 'a', '--out', 'b']]);

  const linux = fake({ os: 'linux', files: ['grim', 'magick'] });
  assert.equal(await linux.p.screenshot('/t'), '/t/raw.jpg');
  await linux.p.resizeImage({ input: '/t/raw.jpg', output: '/t/s.jpg', side: 1600, quality: 60, onlyShrink: true });
  assert.deepEqual(linux.calls.map((c) => [c.cmd, ...c.args]), [['grim', '-t', 'jpeg', '/t/raw.jpg'], ['magick', '/t/raw.jpg', '-resize', '1600x1600>', '-quality', '60', '-strip', 'jpeg:/t/s.jpg']]);
  assert.equal(fake({ os: 'linux', files: ['gnome-screenshot', 'convert'] }).p.capabilities().screenshot.available, true);
  assert.match(fake({ os: 'linux', files: ['grim'] }).p.capabilities().screenshot.reason, /ImageMagick/);

  const win = fake({ os: 'win32' });
  await win.p.screenshot('C:\\t');
  await win.p.resizeImage({ input: 'in.jpg', output: 'out.jpg', side: 480, quality: 70 });
  assert.equal(win.calls[0].cmd, 'powershell.exe');
  assert.match(win.calls[0].args.at(-1), /CopyFromScreen/);
  assert.equal(win.calls[1].o.env.POCKET_DEV_SIDE, '480');
  assert.equal(win.calls[1].o.env.POCKET_DEV_SHRINK_ONLY, '0');
  assert.equal(win.calls[1].args.some((a) => a.includes('in.jpg')), false, 'paths travel in the environment');
});

test('service definitions: launchd plist, systemd user unit and Task Scheduler task, with their commands', () => {
  const base = { label: 'dev.pocket.server', node: '/usr/bin/node', repo: '/opt/pd', port: 7777, home: '/home/a', user: 'a', uid: 501, env: { POCKET_DEV_STATE_DIR: '/s' } };
  const mac = servicePlan({ ...base, platform: 'darwin', home: '/Users/a' });
  assert.equal(mac.files[0].path, '/Users/a/Library/LaunchAgents/dev.pocket.server.plist');
  assert.match(mac.files[0].content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(mac.files[0].content, /<key>PORT<\/key><string>7777<\/string>/);
  assert.match(mac.files[0].content, /<key>POCKET_DEV_STATE_DIR<\/key><string>\/s<\/string>/);
  assert.deepEqual(mac.commands.stop, [['launchctl', ['bootout', 'gui/501/dev.pocket.server']]]);
  assert.deepEqual(mac.commands.disable, [['launchctl', ['disable', 'gui/501/dev.pocket.server']]]);

  const linux = servicePlan({ ...base, platform: 'linux', repo: '/opt/my pd' });
  assert.equal(linux.files[0].path, '/home/a/.config/systemd/user/dev.pocket.server.service');
  assert.match(linux.files[0].content, /ExecStart="\/usr\/bin\/node" "\/opt\/my pd\/server.js"/);
  assert.match(linux.files[0].content, /Restart=always\nRestartSec=10/);
  assert.match(linux.files[0].content, /Environment="POCKET_DEV_SERVICE=dev.pocket.server"/);
  assert.match(linux.files[0].content, /WantedBy=default.target/);
  assert.deepEqual(linux.commands.install.map((c) => c[1].join(' ')), ['--user daemon-reload', '--user enable dev.pocket.server.service', '--user restart dev.pocket.server.service']);
  assert.deepEqual(linux.commands.disable, [['systemctl', ['--user', 'disable', 'dev.pocket.server.service']]]);

  const win = servicePlan({ ...base, platform: 'win32', home: 'C:\\Users\\a', repo: 'C:\\pd', node: 'C:\\node\\node.exe', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } });
  const [runner, task] = win.files;
  assert.match(runner.content, /\$env:PORT = '7777'/);
  assert.match(runner.content, /Start-Sleep -Seconds 10/);
  assert.match(runner.content, /& 'C:\\node\\node.exe' 'C:\\pd\\server.js'/);
  assert.equal(task.encoding, 'utf16le');
  assert.match(task.content, /<LogonTrigger>/);
  assert.match(task.content, /powershell.exe/);
  assert.deepEqual(win.commands.install[0], ['schtasks', ['/Create', '/TN', 'dev.pocket.server', '/XML', task.path, '/F']]);
  assert.deepEqual(win.commands.disable, [['schtasks', ['/Change', '/TN', 'dev.pocket.server', '/DISABLE']]]);
});

test('service status is read from launchctl, systemctl and the task state', () => {
  const label = 'dev.pocket.server';
  assert.deepEqual(parseServiceStatus('launchd', ['"dev.pocket.server" => disabled\n', '\tpid = 55\n'], label), { autostart: false, running: true, pid: 55 });
  assert.deepEqual(parseServiceStatus('systemd', ['MainPID=812\nActiveState=active\nUnitFileState=enabled\nLoadState=loaded\n'], label), { installed: true, autostart: true, running: true, pid: 812 });
  assert.equal(parseServiceStatus('systemd', ['LoadState=not-found\nMainPID=0\n'], label).installed, false);
  assert.deepEqual(parseServiceStatus('schtasks', ['{"state":"Running"}'], label), { installed: true, autostart: true, running: true, pid: null });
  assert.equal(parseServiceStatus('schtasks', ['{"state":"Disabled"}'], label).autostart, false);
  assert.equal(parseServiceStatus('schtasks', [''], label).installed, false);
});

test('installing writes the definition and runs the install commands (injected runner, nothing real)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-svc-'));
  try {
    const calls = [];
    const p = createPlatform({ platform: 'linux', env: { PATH: '/usr/bin' }, home, user: 'a', uid: 1, repoDir: '/repo', exists: (f) => f === '/usr/bin/systemctl',
      run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '', signal: null }; } });
    const text = await p.installService({ port: 7777 });
    assert.match(text, /dev.pocket.server.service/);
    assert.match(fs.readFileSync(path.join(home, '.config/systemd/user/dev.pocket.server.service'), 'utf8'), /server.js/);
    assert.deepEqual(calls.map((c) => c.slice(0, 4).join(' ')), ['systemctl --user daemon-reload', 'systemctl --user enable dev.pocket.server.service', 'systemctl --user restart dev.pocket.server.service']);
    calls.length = 0;
    await p.uninstallService();
    assert.equal(fs.existsSync(path.join(home, '.config/systemd/user/dev.pocket.server.service')), false);
    assert.equal(calls[0].includes('--now'), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('LAN addresses and names: en0 first and .local on Mac; real interfaces first and no .local elsewhere', () => {
  const nic = (address, internal = false) => [{ family: 'IPv4', address, internal }];
  const nics = { lo0: nic('127.0.0.1', true), bridge0: nic('10.0.0.9'), en0: nic('192.168.1.5'), en1: nic('192.168.1.6') };
  const mac = fake({ os: 'darwin', nics });
  assert.deepEqual(mac.p.lanIps(), ['192.168.1.5', '10.0.0.9', '192.168.1.6']);
  assert.equal(mac.p.localName(), 'my-box.local');
  const linux = fake({ os: 'linux', nics: { docker0: nic('172.17.0.1'), wlan0: nic('192.168.1.7'), tun0: nic('10.8.0.2') } });
  assert.deepEqual(linux.p.lanIps(), ['192.168.1.7', '10.8.0.2']);
  assert.equal(linux.p.localName(), null);
  const win = fake({ os: 'win32', nics: { 'vEthernet (WSL)': nic('172.20.0.1'), 'Wi-Fi': nic('192.168.0.4') } });
  assert.deepEqual(win.p.lanIps(), ['192.168.0.4']);
  assert.equal(win.p.localName(), null);
  assert.equal(win.p.capabilities().mdns.available, false);
});

test('terminal shell arguments: -l for login shells, none for PowerShell and cmd', () => {
  const { p } = fake({ os: 'darwin' });
  assert.deepEqual(p.shellArgs('/bin/zsh'), ['-l']);
  assert.deepEqual(p.shellArgs('/usr/bin/bash'), ['-l']);
  assert.deepEqual(p.shellArgs('/opt/homebrew/bin/pwsh'), ['-NoLogo']);
  const win = fake({ os: 'win32' }).p;
  assert.deepEqual(win.shellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo']);
  assert.deepEqual(win.shellArgs('powershell.exe'), ['-NoLogo']);
  assert.deepEqual(win.shellArgs('C:\\Windows\\System32\\cmd.exe'), []);
});

test('process by port: lsof on Mac, lsof or ss on Linux, Get-NetTCPConnection on Windows', async () => {
  const mac = fake({ os: 'darwin', answer: OUT('p123\ncnode\n') });
  assert.deepEqual(await mac.p.portOwner(7777), { pid: 123, command: 'node' });
  assert.deepEqual([mac.calls[0].cmd, mac.calls[0].args], ['lsof', ['-nP', '-iTCP:7777', '-sTCP:LISTEN', '-F', 'pc']]);
  const ss = fake({ os: 'linux', files: ['ss'], answer: OUT('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=4242,fd=19))\n') });
  assert.deepEqual(await ss.p.portOwner(3000), { pid: 4242, command: 'node' });
  assert.deepEqual([ss.calls[0].cmd, ss.calls[0].args], ['ss', ['-ltnpH', 'sport = :3000']]);
  const lsof = fake({ os: 'linux', files: ['lsof', 'ss'], answer: OUT('p9\ncpython\n') });
  assert.equal((await lsof.p.portOwner(80)).command, 'python');
  const win = fake({ os: 'win32', answer: OUT('{"pid":77,"command":"node"}') });
  assert.deepEqual(await win.p.portOwner(8080), { pid: 77, command: 'node' });
  assert.match(win.calls[0].args.at(-1), /Get-NetTCPConnection -LocalPort 8080/);
  assert.equal(await fake({ os: 'linux', files: ['ss'], answer: () => ({ code: 1, stdout: '', stderr: '' }) }).p.portOwner(1), null);
  assert.equal(await mac.p.portOwner('1; rm -rf'), null);
});

test('a server started as Linux answers power, health and apps without errors and says what is unsupported', async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'linux', PATH: '/nonexistent' } });
  const { cookie } = await s.login();
  const power = await s.request('GET', '/api/power', { cookie });
  assert.equal(power.status, 200);
  assert.equal(power.data.caffeinatePid, null);
  assert.ok(power.data.unsupported.keepAwake, 'keep awake is reported as unsupported');
  assert.ok(power.data.unsupported.sleepNow);
  assert.ok(power.data.unsupported.lidSleep);
  const health = await s.request('GET', '/api/health', { cookie });
  assert.equal(health.status, 200);
  assert.ok(health.data.unsupported.keepAwake);
  assert.equal(health.data.memory.wiredMB, null);
  const apps = await s.request('GET', '/api/apps', { cookie });
  assert.equal(apps.status, 200);
  assert.deepEqual(apps.data.apps, []);
  assert.match(apps.data.unsupported, /wmctrl/);
  const sleep = await s.request('POST', '/api/power/sleep', { cookie });
  assert.equal(sleep.status, 501);
  assert.match(sleep.data.error, /Not available on this system/);
  const put = await s.request('PUT', '/api/power', { cookie, body: { awake: 'always' } });
  assert.equal(put.status, 501);
  const screen = await s.request('GET', '/api/screen', { cookie });
  assert.equal(screen.status, 503);
  assert.match(screen.data.error, /Not available on this system/);
  assert.doesNotMatch(s.logs(), /caffeinate|ENOENT|pmset|osascript|Error/i);
});
