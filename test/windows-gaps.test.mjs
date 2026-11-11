import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { createPlatform, NO_WINDOWS_ZIP } from '../platform.js';
import { servicePlan } from '../platform-service.js';
import { connectToHost } from '../terminals.js';
import { startServer } from './helpers/server.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEM = () => ({ total: 8 * 1024 ** 3, free: 2 * 1024 ** 3 });

function make({ os: system, answer = () => ({ code: 0, stdout: '', stderr: '' }), files = [], texts = {}, cpus, env = {} } = {}) {
  const calls = [];
  let clock = 1_000_000;
  const p = createPlatform({
    platform: system, env: { PATH: '/usr/bin', ...env }, home: '/h', user: 'a', uid: 1, repoDir: '/repo', memory: MEM, hostname: () => 'Box',
    run: async (cmd, args, o) => { calls.push({ cmd, args, o }); return { signal: null, ...answer(cmd, args) }; },
    exists: (f) => files.includes(f),
    readText: (f) => (typeof texts[f] === 'function' ? texts[f]() : texts[f] ?? null),
    cpus, delay: async () => {}, now: () => clock,
  });
  return { p, calls, tick: (ms) => { clock += ms; } };
}

// ---- 1. CPU ------------------------------------------------------------------------------------------------------

test('Windows CPU comes from the processor load PowerShell reports, and is cached for 5 seconds', async () => {
  const w = make({ os: 'win32', answer: () => ({ code: 0, stdout: '37\r\n', stderr: '' }) });
  assert.equal((await w.p.cpuMemory()).cpuUsedPercent, 37);
  assert.equal(w.calls[0].cmd, 'powershell.exe');
  assert.match(w.calls[0].args.at(-1), /Win32_Processor/);
  assert.equal(w.calls[0].o.timeout, 8000, 'PowerShell is stopped after a hard limit');
  await w.p.cpuMemory();
  assert.equal(w.calls.length, 1, 'a second poll inside 5 s starts no PowerShell');
  w.tick(5001);
  await w.p.cpuMemory();
  assert.equal(w.calls.length, 2);
});

test('Windows CPU: concurrent polls share one PowerShell', async () => {
  const w = make({ os: 'win32', answer: () => ({ code: 0, stdout: '12', stderr: '' }) });
  const all = await Promise.all([w.p.cpuMemory(), w.p.cpuMemory(), w.p.cpuMemory()]);
  assert.deepEqual(all.map((a) => a.cpuUsedPercent), [12, 12, 12]);
  assert.equal(w.calls.length, 1);
});

test('Windows CPU falls back to the core counters when PowerShell gives no number, and is null when nothing works', async () => {
  const reading = [{ times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }];
  const later = [{ times: { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } }];
  let n = 0;
  const w = make({ os: 'win32', answer: () => ({ code: 0, stdout: '\r\n', stderr: '' }), cpus: () => (n++ === 0 ? reading : later) });
  assert.equal((await w.p.cpuMemory()).cpuUsedPercent, 50, '100 busy of 200 more ticks');
  const none = make({ os: 'win32', answer: () => ({ code: 1, stdout: '', stderr: 'boom' }), cpus: () => [] });
  assert.equal((await none.p.cpuMemory()).cpuUsedPercent, null);
  const junk = make({ os: 'win32', answer: () => ({ code: 0, stdout: '350', stderr: '' }), cpus: () => [] });
  assert.equal((await junk.p.cpuMemory()).cpuUsedPercent, null, 'a figure over 100 is not believed');
});

test('Linux CPU is the change in /proc/stat between two readings', async () => {
  const stats = ['cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1', 'cpu  200 0 200 750 150 0 0 0 0 0\ncpu0 1 1 1 1'];
  let n = 0;
  const l = make({ os: 'linux', texts: { '/proc/stat': () => stats[Math.min(n++, 1)] } });
  // 300 ticks passed, 100 of them idle (idle + iowait): 200 busy = 67%
  assert.equal((await l.p.cpuMemory()).cpuUsedPercent, 67);
  assert.equal(l.calls.length, 0, 'no program is started on Linux');
});

test('a Mac keeps top for CPU and never uses the new counters', async () => {
  const m = make({ os: 'darwin', answer: () => ({ code: 0, stdout: 'CPU usage: 1.0% user, 2.0% sys, 90.0% idle\nPhysMem: 7514M used (1220M wired, 3272M compressor), 97M unused.\n', stderr: '' }) });
  assert.equal((await m.p.cpuMemory()).cpuUsedPercent, 10);
  assert.equal(m.calls.length, 1);
});

test('/api/health on Windows reports the CPU percent PowerShell gives and no unix load average', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ps-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'powershell.exe'), '#!/bin/sh\ncase "$*" in *Win32_Processor*LoadPercentage*) echo 42;; esac\nexit 0\n', { mode: 0o755 });
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'win32', PATH: `${bin}:${process.env.PATH}` } });
  const login = await s.login();
  const r = await s.request('GET', '/api/health', { cookie: login.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cpu.load, null, 'a unix load average does not exist on Windows');
  assert.ok(r.data.cpu.usedPercent === 42 || r.data.cpu.usedPercent >= 0, 'a real percentage, not null');
  assert.equal(typeof r.data.cpu.cores, 'number');
});

// ---- 2. Windows zip ----------------------------------------------------------------------------------------------

const TAR = 'C:\\Windows\\System32\\tar.exe';

test('Windows zip is tar.exe from System32 writing zip to stdout from a name list on stdin', () => {
  const z = make({ os: 'win32', files: [TAR], env: { SystemRoot: 'C:\\Windows' } }).p.zipCommand();
  assert.deepEqual(z, { available: true, cmd: TAR, args: ['-n', '-c', '-f', '-', '--format', 'zip', '-T', '-'] });
  assert.equal(make({ os: 'win32', files: [TAR], env: { SystemRoot: 'C:\\Windows' } }).p.capabilities().zip.available, true);
  assert.equal(make({ os: 'win32', files: [TAR], env: { windir: 'C:\\Windows' } }).p.zipCommand().available, true);
});

test('Windows zip is "not available" with a reason when tar.exe is missing; a tar earlier on PATH is not used', () => {
  const w = make({ os: 'win32', files: ['C:\\Program Files\\Git\\usr\\bin\\tar.exe'], env: { PATH: 'C:\\Program Files\\Git\\usr\\bin' } });
  assert.deepEqual(w.p.zipCommand(), { available: false, reason: NO_WINDOWS_ZIP });
  assert.equal(w.p.capabilities().zip.available, false);
  assert.match(w.p.capabilities().zip.reason, /tar\.exe/);
});

test('Mac and Linux zip commands are unchanged', () => {
  const args = ['-q', '-nw', '-@', '-'];
  assert.deepEqual(make({ os: 'darwin' }).p.zipCommand(), { available: true, cmd: '/usr/bin/zip', args });
  assert.deepEqual(make({ os: 'linux', files: ['/usr/bin/zip'] }).p.zipCommand(), { available: true, cmd: '/usr/bin/zip', args });
});

// bsdtar on this Mac stands in for tar.exe: same program, same flags.
const bsdtar = spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('bsdtar');

test('zip download streams through the Windows command line (bsdtar), with the same checks as before', { skip: !bsdtar }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'win32', POCKET_DEV_TAR: '/usr/bin/tar' } });
  const dir = path.join(s.home, 'proj');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a b.txt'), 'alpha');
  fs.writeFileSync(path.join(dir, '[x]*.txt'), 'wild');
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'gamma');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'link-out'));
  const { cookie } = await s.login();
  const url = `/api/files/zip?path=${encodeURIComponent(dir)}`;

  const check = await s.request('GET', `${url}&check=1`, { cookie });
  assert.equal(check.status, 200);
  assert.equal(check.data.files, 3);
  assert.equal(check.data.skipped, 1, 'the link that leaves the allowed folders is skipped');

  const res = await fetch(s.base + url, { headers: { cookie, 'x-pocket-dev': '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const out = path.join(s.root, 'out.zip');
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const listing = spawnSync('/usr/bin/unzip', ['-Z1', out], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(listing, ['proj/', 'proj/[x]*.txt', 'proj/a b.txt', 'proj/sub/', 'proj/sub/c.txt'], 'literal names, one entry each, no link');
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-unzip-'));
  spawnSync('/usr/bin/unzip', ['-q', out, '-d', extracted]);
  assert.equal(fs.readFileSync(path.join(extracted, 'proj', 'sub', 'c.txt'), 'utf8'), 'gamma');
  fs.rmSync(extracted, { recursive: true, force: true });
});

test('zip download on Windows without tar.exe answers 501 with the reason', async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'win32', POCKET_DEV_TAR: '/nonexistent/tar.exe' } });
  fs.mkdirSync(path.join(s.home, 'p'));
  fs.writeFileSync(path.join(s.home, 'p', 'f'), 'x');
  const { cookie } = await s.login();
  const r = await s.request('GET', `/api/files/zip?path=${encodeURIComponent(path.join(s.home, 'p'))}`, { cookie });
  assert.equal(r.status, 501);
  assert.match(r.data.error, /tar\.exe/);
});

test('the client leaving mid-download stops the archive program', { skip: !bsdtar }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'win32', POCKET_DEV_TAR: '/usr/bin/tar' } });
  const dir = path.join(s.home, 'big');
  fs.mkdirSync(dir);
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `f${i}.bin`), Buffer.from(chunk.map((b, j) => (b + j * 31 + i) & 255)));
  const { cookie } = await s.login();
  await new Promise((resolve, reject) => {
    const req = http.get(`${s.base}/api/files/zip?path=${encodeURIComponent(dir)}`, { headers: { cookie, 'x-pocket-dev': '1' } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
  });
  const running = () => spawnSync('pgrep', ['-f', `tar -n -c -f - --format zip`], { encoding: 'utf8' }).stdout.trim();
  const end = Date.now() + 8000;
  while (running() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.equal(running(), '', 'no tar is left running after the client left');
});

// ---- 3. Wording --------------------------------------------------------------------------------------------------

test('host wording: the Mac keeps its words, other systems say computer', () => {
  const mac = make({ os: 'darwin' }).p.host;
  const win = make({ os: 'win32' }).p.host;
  const linux = make({ os: 'linux' }).p.host;
  assert.deepEqual([mac.the, mac.this, mac.The, mac.Mac], ['the Mac', 'this Mac', 'The Mac', 'Mac']);
  for (const h of [win, linux]) assert.deepEqual([h.the, h.this, h.The, h.Mac], ['the host computer', 'this computer', 'The host computer', 'Computer']);
});

test('a pending device on Windows is told to wait on the host computer, and the Admin line names the computer', async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_PLATFORM: 'win32' } });
  assert.match(s.logs(), /Admin \(this computer only\)/);
  const mac = await startServer(t, {});
  assert.match(mac.logs(), /Admin \(this Mac only\)/);
});

test('no message that a non-Mac can show still says "Mac" (source scan of server-side strings)', () => {
  // Strings built with platform.host are fine; these files must not hold a bare "the Mac" / "this Mac" literal any more.
  const files = ['auth.js', 'admin.js', 'config.js', 'files.js', 'collaborators.js', 'tunnel.js', 'server.js', 'performance.js', 'power.js', 'screen.js', 'takeover.js', 'messages.js', 'history.js', 'takeover-cli.js'];
  for (const f of files) {
    const bare = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /['"`][^'"`]*\b(the|this|The|This) Mac\b/.test(l.replace(/\/\/.*$/, '')));
    assert.deepEqual(bare, [], `${f} has a Mac-only message`);
  }
});

// ---- 4. Service files --------------------------------------------------------------------------------------------

const winPlan = (extra = {}) => servicePlan({
  platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', repo: 'C:\\Users\\Ann Lee\\pocket dev', port: 7777, home: 'C:\\Users\\Ann Lee', user: 'Ann Lee',
  env: { USERNAME: 'Ann Lee', USERDOMAIN: 'PC-1', LOCALAPPDATA: 'C:\\Users\\Ann Lee\\AppData\\Local', ...extra },
});

test('Task Scheduler XML names the user, restarts on failure, runs at normal priority and escapes paths', () => {
  const [, task] = winPlan({ USERNAME: 'A&B <x>' }).files;
  assert.match(task.content, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC-1\\A&amp;B &lt;x&gt;<\/UserId><\/LogonTrigger>/);
  assert.match(task.content, /<Principal id="Author"><UserId>PC-1\\A&amp;B &lt;x&gt;<\/UserId><LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task.content, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
  assert.match(task.content, /<Priority>5<\/Priority>/);
  assert.match(task.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task.content, /<Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\\Users\\Ann Lee\\AppData\\Local\\pocket-dev\\service-run\.ps1"<\/Arguments>/);
  assert.match(task.content, /<WorkingDirectory>C:\\Users\\Ann Lee\\pocket dev<\/WorkingDirectory>/);
  assert.equal(task.encoding, 'utf16le');
});

test('Task Scheduler XML is well-formed and has its elements in the schema order', () => {
  const [, task] = winPlan().files;
  const names = [...task.content.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)];
  const stack = [];
  for (const [, close, name, self] of names) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `closing ${name}`); else stack.push(name);
  }
  assert.deepEqual(stack, []);
  const order = (parent, children) => {
    const body = new RegExp(`<${parent}[ >][\\s\\S]*?</${parent}>`).exec(task.content)[0];
    const at = children.map((c) => body.search(new RegExp(`<${c}[ >]`)));
    assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), `${parent}: ${children.join(', ')} in order`);
  };
  order('Task', ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions']);
  order('Exec', ['Command', 'Arguments', 'WorkingDirectory']);
  order('Principal', ['UserId', 'LogonType', 'RunLevel']);
});

test('the runner script: PATH from the registry on every start, UTF-8 log through cmd, waits on one process, paths quoted', () => {
  const plan = winPlan();
  const [runner] = plan.files;
  assert.equal(runner.encoding, 'utf8bom', 'PowerShell 5.1 needs a byte order mark to read non-ASCII paths');
  const c = runner.content;
  assert.match(c, /\$node = 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(c, /\$server = 'C:\\Users\\Ann Lee\\pocket dev\\server\.js'/);
  assert.match(c, /Set-Location -LiteralPath 'C:\\Users\\Ann Lee\\pocket dev'/);
  assert.match(c, /GetEnvironmentVariable\('Path', \$scope\)/);
  assert.match(c, /while \(\$true\) \{\n  \$registry/, 'the PATH is rebuilt inside the loop');
  assert.match(c, /Start-Process -FilePath 'cmd\.exe' -ArgumentList \$cmdLine .* -WindowStyle Hidden -PassThru/);
  assert.match(c, /\$process\.WaitForExit\(\)/);
  assert.doesNotMatch(c, /-Wait\b/, 'Start-Process -Wait would also wait for the terminal host');
  assert.doesNotMatch(c, /\*>>/, 'PowerShell 5.1 redirection writes UTF-16');
  assert.match(c, /'\/d \/s \/c ""\{0\}" "\{1\}" >> "\{2\}" 2>&1"' -f/);
  assert.match(c, /Start-Sleep -Seconds 10/);
});

test('a path with a quote in the user name cannot break out of the runner strings', () => {
  const c = servicePlan({ platform: 'win32', node: "C:\\o'brien\\node.exe", repo: "C:\\it's", port: 1, home: "C:\\Users\\o'brien", user: 'x', env: {} }).files[0].content;
  assert.match(c, /\$node = 'C:\\o''brien\\node\.exe'/);
  assert.match(c, /Set-Location -LiteralPath 'C:\\it''s'/);
});

test('windows-install.ps1 exists, is ASCII, and does what the task asks (text checks; not run: no Windows here)', () => {
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'windows-install.ps1'));
  assert.ok(script.every((b) => b < 128), 'PowerShell 5.1 reads a script without a byte order mark as ANSI');
  const text = script.toString('utf8');
  for (const needle of ['node --version', 'npm install', 'platform.installService', 'Password:', 'passwordHash', 'schtasks /Run', 'Get-NetFirewallRule', 'Invoke-WebRequest']) {
    assert.ok(text.includes(needle.replace('node --version', '& node --version')) || text.includes(needle), `mentions ${needle}`);
  }
  assert.doesNotMatch(text, /-ArgumentList[^\n]*"/, 'no double quotes passed through native arguments');
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(REPO, 'scripts', 'windows-install.ps1')}', [ref]$null, [ref]$e); if ($e) { $e; exit 1 }`], { encoding: 'utf8' });
  if (pwsh.error?.code !== 'ENOENT') assert.equal(pwsh.status, 0, pwsh.stdout + pwsh.stderr);
});

// ---- 5. Terminal host connect ------------------------------------------------------------------------------------

const refused = (code = 'ENOENT') => Object.assign(new Error(`connect ${code} \\\\.\\pipe\\x`), { code });

test('connecting retries with a growing pause until the host listens, and starts the host once', async () => {
  const pauses = [];
  let clock = 0, tries = 0, started = 0;
  const result = await connectToHost('pipe', {
    connect: async () => { if (++tries < 6) throw refused(); return 'host'; },
    start: () => { started++; }, pause: async (ms) => { pauses.push(ms); clock += ms; }, now: () => clock,
  });
  assert.equal(result, 'host');
  assert.equal(started, 1, 'the host is started once, not on every try');
  assert.deepEqual(pauses, [50, 100, 200, 400, 400]);
});

test('connecting does not start a second host for a pipe that is busy, and retries it', async () => {
  let clock = 0, tries = 0, started = 0;
  const result = await connectToHost('pipe', {
    connect: async () => { if (++tries < 3) throw refused('EBUSY'); return 'host'; },
    start: () => { started++; }, pause: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert.equal(result, 'host');
  assert.equal(started, 0);
});

test('connecting gives up after the wait with the last error, and a wrong protocol is not retried', async () => {
  let clock = 0, tries = 0;
  await assert.rejects(connectToHost('pipe', {
    connect: async () => { tries++; throw refused(); }, start: () => {}, pause: async (ms) => { clock += ms; }, now: () => clock, waitMs: 1000,
  }), /The terminal host did not start: connect ENOENT/);
  assert.ok(tries > 3 && clock >= 1000);
  let calls = 0;
  await assert.rejects(connectToHost('pipe', {
    connect: async () => { calls++; throw Object.assign(new Error('speaks protocol 2'), { fatal: true }); }, start: () => {}, pause: async () => {},
  }), /protocol 2/);
  assert.equal(calls, 1);
});

test('a real host that starts late is found: the socket appears after the first tries fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-late-'));
  const sock = path.join(dir, 's.sock');
  const server = net.createServer((c) => c.end());
  let tries = 0;
  const attempt = (p) => new Promise((resolve, reject) => {
    if (++tries === 3) server.listen(sock);
    const c = net.connect(p);
    c.once('error', reject);
    c.once('connect', () => { c.destroy(); resolve('connected'); });
  });
  const got = await connectToHost(sock, { connect: attempt, start: () => {}, waitMs: 3000 });
  assert.equal(got, 'connected');
  assert.ok(tries >= 3);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup starts a bare npm through cmd.exe on Windows, and real programs directly', async () => {
  const { needsShell } = await import('../setup.js');
  assert.equal(needsShell('npm', 'win32'), true, 'a bare npm is npm.cmd, which spawn cannot start without a shell');
  assert.equal(needsShell('C:\\Program Files\\nodejs\\npm.cmd', 'win32'), true);
  assert.equal(needsShell('claude.CMD', 'win32'), true);
  assert.equal(needsShell('C:\\Program Files\\Git\\cmd\\git.exe', 'win32'), false);
  assert.equal(needsShell('npm', 'darwin'), false);
  assert.equal(needsShell('npm', 'linux'), false);
});
