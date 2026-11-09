import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { servicePlan, parseServiceStatus, DEFAULT_LABEL } from './platform-service.js';

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

export const NO_WINDOWS_ZIP = 'Zipping a folder needs tar.exe, which comes with Windows 10 and 11 in the System32 folder but was not found.';

function collect(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, stdout, stderr, signal }));
  });
}

function launch(cmd, args) {
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t82%; charging; 0:45 remaining present: true"
export function parseBatt(text) {
  const onAC = text.includes("'AC Power'");
  const m = /InternalBattery[^\t]*\t(\d+)%; ([^;]+);(?: (\d+):(\d+) remaining)?/.exec(text);
  if (!m) return { onAC, battery: null, charging: false, timeRemaining: null };
  const [, percent, state, hours, minutes] = m;
  const estimating = state === 'charging' || state === 'discharging';
  return {
    onAC,
    battery: Number(percent),
    charging: state === 'charging',
    timeRemaining: estimating && hours !== undefined ? Number(hours) * 60 + Number(minutes) : null,
  };
}

// ioreg reports the battery's temperature in hundredths of a degree. It is the only temperature a Mac gives a normal
// user; CPU and chip sensors need sudo (powermetrics) or a third-party tool.
export function parseBatteryC(text) {
  const raw = Number(/"Temperature" = (\d+)/.exec(text)?.[1]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) / 100 : null;
}

// macOS's own thermal pressure (NSProcessInfo.thermalState): how hard it is throttling to cool down.
const THERMAL = ['nominal', 'fair', 'serious', 'critical'];
export function parseThermal(text) {
  const level = text.trim();
  return /^[0-3]$/.test(level) ? THERMAL[Number(level)] : null;
}

// How worn the battery is: its full-charge capacity against what it was built with, and cycles against its rated life.
export function parseBatteryCondition(text) {
  const number = (key) => Number(new RegExp(`"${key}" = (\\d+)`).exec(text)?.[1]);
  const [cycles, designCycles, current, design] = ['CycleCount', 'DesignCycleCount9C', 'AppleRawMaxCapacity', 'DesignCapacity'].map(number);
  if (!Number.isFinite(cycles) || !(design > 0) || !(current > 0)) return null;
  return { cycles, designCycles: Number.isFinite(designCycles) ? designCycles : null, capacityPercent: Math.min(100, Math.round((current / design) * 100)) };
}

export function parseAssertions(text, pid) {
  const count = (name) => Number(new RegExp(`^\\s+${name}\\s+(\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  const ownLine = new RegExp(`^\\s+pid ${pid}\\(caffeinate\\): \\S+ \\S+ (\\w+)`, 'gm');
  return {
    PreventSystemSleep: count('PreventSystemSleep'),
    PreventUserIdleSystemSleep: count('PreventUserIdleSystemSleep'),
    heldByPocketDev: pid ? [...text.matchAll(ownLine)].map((m) => m[1]) : [],
  };
}

const toMB = (n, unit) => Math.round(Number(n) * (unit === 'G' ? 1024 : 1));

// "CPU usage: 3.82% user, 6.88% sys, 89.28% idle" and "PhysMem: 7514M used (1220M wired, 3272M compressor), 97M unused."
// top is sampled twice, so only the last of each line counts: the first is an average since boot.
export function parseTop(text) {
  const cpu = [...text.matchAll(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/g)].at(-1);
  const mem = [...text.matchAll(/PhysMem: (\d+)([MG]) used \((\d+)([MG]) wired, (\d+)([MG]) compressor\), (\d+)([MG]) unused/g)].at(-1);
  return {
    cpuUsedPercent: cpu ? Math.round(100 - Number(cpu[3])) : null,
    memory: mem ? { usedMB: toMB(mem[1], mem[2]), wiredMB: toMB(mem[3], mem[4]), compressedMB: toMB(mem[5], mem[6]) } : null,
  };
}

export function parseMemoryFree(text) {
  const match = /free percentage: (\d+)%/.exec(text);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const readTextFile = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const listDirectory = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// run(cmd, args, { env, timeout }) resolves { code, stdout, stderr, signal }; it rejects only when the program cannot
// start. launch(cmd, args) starts a detached process. exists(path) says whether a file is there. readText(path) and
// listDir(path) read /sys and /proc. All of these and the rest can be replaced in tests; POCKET_DEV_PLATFORM=linux
// (or win32, darwin) makes a running server behave as that system.
export function createPlatform({
  env = process.env, platform = env.POCKET_DEV_PLATFORM || process.platform, run = collect, launch: start = launch, exists = fs.existsSync,
  home = os.homedir(), readText = readTextFile, listDir = listDirectory, networkInterfaces = os.networkInterfaces,
  memory = () => ({ total: os.totalmem(), free: os.freemem() }), hostname = os.hostname, uid = process.getuid?.() ?? 0,
  user = env.USER || env.USERNAME || os.userInfo().username, repoDir = REPO_DIR,
  cpus = os.cpus, delay = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  // How messages name the computer this runs on: the Mac keeps its own words, other systems say "computer".
  const host = mac
    ? { the: 'the Mac', The: 'The Mac', this: 'this Mac', This: 'This Mac', mac: 'Mac', Mac: 'Mac' }
    : { the: 'the host computer', The: 'The host computer', this: 'this computer', This: 'This computer', mac: 'computer', Mac: 'Computer' };
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
    if (win) {
      // Only Windows's own bsdtar writes zip. A tar earlier on PATH (Git for Windows ships GNU tar) cannot, so the path is
      // fixed. -n because the caller lists every entry itself; -T - reads the names from stdin, like zip -@.
      const tar = env.POCKET_DEV_TAR || path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
      return exists(tar) ? { available: true, cmd: tar, args: ['-n', '-c', '-f', '-', '--format', 'zip', '-T', '-'] } : { available: false, reason: NO_WINDOWS_ZIP };
    }
    const cmd = mac ? ZIP_PATHS[0] : ZIP_PATHS.find(exists);
    if (!cmd) return { available: false, reason: 'Zipping a folder needs the zip program. Install it (for example: sudo apt install zip).' };
    // -nw reads each name literally, so a "[" or "*" in a file name is not a wildcard.
    return { available: true, cmd, args: ['-q', '-nw', '-@', '-'] };
  }

  // ---- Calling programs --------------------------------------------------------------------------------------------

  // Mac tools can be replaced for tests with POCKET_DEV_<NAME>.
  const tool = (name, fallback) => env[`POCKET_DEV_${name}`] || fallback;

  // Runs a program and returns its output, or throws an error carrying stderr and, when a timeout killed it, killed.
  async function sh(cmd, args = [], opts = {}) {
    const r = await run(cmd, args, opts);
    if (r.code !== 0) {
      throw Object.assign(new Error(`${path.basename(cmd)} ${r.signal ? `was stopped (${r.signal})` : `exited ${r.code}`}: ${r.stderr.trim()}`),
        { stderr: r.stderr, stdout: r.stdout, code: r.code, killed: Boolean(r.signal) });
    }
    return r.stdout;
  }
  const powershell = (script, opts = {}) => sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts);
  const quiet = (promise, fallback = null) => promise.catch(() => fallback);
  const parseJson = (text, fallback = null) => { try { return JSON.parse(text); } catch { return fallback; } };

  // Rejects for an action this system cannot do, with the reason capabilities() gives.
  function need(key) {
    const cap = capabilities()[key];
    if (!cap.available) throw Object.assign(new Error(`Not available on this system: ${cap.reason}`), { unsupported: true, capability: key });
  }

  // ---- Power -------------------------------------------------------------------------------------------------------

  const POWER_SUPPLY = '/sys/class/power_supply';
  function supplies() {
    return listDir(POWER_SUPPLY).map((name) => ({ name, get: (key) => readText(`${POWER_SUPPLY}/${name}/${key}`)?.trim() ?? null }));
  }
  const batteries = () => supplies().filter((s) => s.get('type') === 'Battery');

  function linuxBattery() {
    const [bat] = batteries();
    const mains = supplies().filter((s) => s.get('type') !== 'Battery' && s.get('online') !== null);
    if (!bat) return { onAC: true, battery: null, charging: false, timeRemaining: null };
    const status = bat.get('status');
    const num = (key) => { const v = bat.get(key); return v === null || v === '' ? NaN : Number(v); };
    const onAC = mains.length ? mains.some((s) => s.get('online') === '1') : status === 'Charging' || status === 'Full';
    const percent = num('capacity');
    const rate = num('power_now') > 0 ? num('power_now') : num('current_now');
    const nowCharge = num('energy_now') >= 0 ? num('energy_now') : num('charge_now');
    const full = num('energy_full') >= 0 ? num('energy_full') : num('charge_full');
    let timeRemaining = null;
    if (rate > 0 && nowCharge >= 0) {
      if (status === 'Discharging') timeRemaining = Math.round((nowCharge / rate) * 60);
      else if (status === 'Charging' && full >= nowCharge) timeRemaining = Math.round(((full - nowCharge) / rate) * 60);
    }
    return { onAC, battery: Number.isFinite(percent) ? percent : null, charging: status === 'Charging', timeRemaining };
  }

  // BatteryStatus: 1 discharging, 2 on AC, 3 full, 4 low, 5 critical, 6 to 9 charging, 11 partly charged.
  async function windowsBattery() {
    const out = parseJson(await powershell('$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { ConvertTo-Json -Compress @{ percent = $b.EstimatedChargeRemaining; status = $b.BatteryStatus; minutes = $b.EstimatedRunTime } } else { "{}" }', { timeout: 10_000 }), {});
    if (out.percent === undefined) return { onAC: true, battery: null, charging: false, timeRemaining: null };
    const charging = [6, 7, 8, 9].includes(out.status);
    const onAC = charging || [2, 3, 11].includes(out.status);
    return {
      onAC, battery: out.percent, charging,
      timeRemaining: !onAC && Number.isFinite(out.minutes) && out.minutes > 0 && out.minutes < 71_582_788 ? out.minutes : null,
    };
  }

  // { onAC, battery (percent or null with no battery), charging, timeRemaining (minutes or null) }
  async function battery() {
    if (mac) return parseBatt(await sh(tool('PMSET', '/usr/bin/pmset'), ['-g', 'batt'], { timeout: 5000 }));
    return win ? windowsBattery() : linuxBattery();
  }

  // { batteryC, thermal }: null for a reading this system does not give. Linux reports the battery's own sensor.
  async function temperatures() {
    if (mac) {
      const [batteryC, thermal] = await Promise.all([
        quiet(sh(tool('IOREG', '/usr/sbin/ioreg'), ['-r', '-n', 'AppleSmartBattery'], { timeout: 5000 }).then(parseBatteryC)),
        quiet(sh(tool('OSASCRIPT', '/usr/bin/osascript'), ['-l', 'JavaScript', '-e', "ObjC.import('Foundation'); $.NSProcessInfo.processInfo.thermalState"], { timeout: 5000 }).then(parseThermal)),
      ]);
      return { batteryC, thermal };
    }
    if (win) return { batteryC: null, thermal: null };
    const raw = Number(batteries()[0]?.get('temp'));
    return { batteryC: Number.isFinite(raw) && raw > 0 ? Math.round(raw) / 10 : null, thermal: null };
  }

  async function batteryCondition() {
    if (mac) return parseBatteryCondition(await quiet(sh(tool('IOREG', '/usr/sbin/ioreg'), ['-r', '-n', 'AppleSmartBattery'], { timeout: 10_000 }), ''));
    if (win) return null;
    const bat = batteries()[0];
    if (!bat) return null;
    const num = (key) => Number(bat.get(key));
    const cycles = num('cycle_count');
    const full = num('energy_full') > 0 ? num('energy_full') : num('charge_full');
    const design = num('energy_full_design') > 0 ? num('energy_full_design') : num('charge_full_design');
    if (!Number.isFinite(cycles) || !(design > 0) || !(full > 0)) return null;
    return { cycles, designCycles: null, capacityPercent: Math.min(100, Math.round((full / design) * 100)) };
  }

  // { closed, sleepDisabled }; a Mac without a lid has no AppleClamshellState key, which reads as open. null means this
  // system does not say.
  async function lid() {
    if (mac) {
      const [settings, clamshell] = await Promise.all([
        sh(tool('PMSET', '/usr/bin/pmset'), ['-g'], { timeout: 5000 }),
        sh(tool('IOREG', '/usr/sbin/ioreg'), ['-r', '-k', 'AppleClamshellState', '-d', '4'], { timeout: 5000 }),
      ]);
      return { closed: /"AppleClamshellState" = Yes/.test(clamshell), sleepDisabled: /^\s*SleepDisabled\s+1\s*$/m.test(settings) };
    }
    if (win) return { closed: null, sleepDisabled: null };
    const state = listDir('/proc/acpi/button/lid').map((n) => readText(`/proc/acpi/button/lid/${n}/state`)).find((t) => t !== null);
    return { closed: state === undefined ? null : /closed/.test(state), sleepDisabled: null };
  }

  // What is keeping the system awake. Only a Mac lists its sleep assertions; elsewhere the counts are 0.
  async function sleepHolds(keepAwakePid) {
    if (!mac) return { PreventSystemSleep: 0, PreventUserIdleSystemSleep: 0, heldByPocketDev: [] };
    return parseAssertions(await sh(tool('PMSET', '/usr/bin/pmset'), ['-g', 'assertions'], { timeout: 5000 }), keepAwakePid);
  }

  // Only an explicit "idle" from update-check.sh counts as no update; a broken check refuses sleep and shutdown. Only
  // macOS software update is checked.
  async function updateInProgress() {
    if (!mac) return false;
    try {
      return (await sh(tool('UPDATE_CHECK', path.join(repoDir, 'scripts', 'update-check.sh')), [], { timeout: 10_000 })).trim() !== 'idle';
    } catch {
      return true;
    }
  }

  // The program that keeps this system awake while Pocket Dev runs, ending with it (pid is the server's), or null for
  // mode "off". -s holds the system awake only while on AC power; -i also blocks idle sleep on battery. Linux and
  // Windows cannot tell the two apart, so "plugged" holds on battery as well.
  function keepAwakeCommand(mode, pid) {
    const flags = { off: null, plugged: ['-s'], always: ['-i', '-s'] }[mode];
    if (!flags) return null;
    if (mac) return { cmd: '/usr/bin/caffeinate', args: [...flags, '-w', String(pid)] };
    if (win) {
      const script = `Add-Type -Namespace PD -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[PD.Awake]::SetThreadExecutionState(0x80000001) | Out-Null
Wait-Process -Id ${Number(pid)}`;
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    return { cmd: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=Pocket Dev', '--why=Keeping this computer awake for your phone', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'] };
  }

  async function sleepNow() {
    need('sleepNow');
    if (mac) return void await sh(tool('PMSET', '/usr/bin/pmset'), ['sleepnow']);
    if (win) return void await sh('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    return void await sh('systemctl', ['suspend']);
  }

  const AUTOMATION_HELP = 'macOS needs permission: on the Mac, allow node to control System Events (System Settings → Privacy & Security → Automation).';
  function osascriptError(err) {
    const text = `${err.stderr ?? ''}${err.message}`;
    if (/-1743|Not authorized to send Apple events/.test(text)) return AUTOMATION_HELP;
    // The first shutdown makes macOS ask on the Mac; nobody answers it from the phone, so osascript times out.
    if (err.killed) return `macOS may be asking on the Mac for permission. ${AUTOMATION_HELP}`;
    return `osascript failed: ${text.trim()}`;
  }

  // Asks the system to shut down, as its own menu does: an app with unsaved changes may stop it. Rejects with a message
  // that is fit to show.
  async function shutDown() {
    need('shutDown');
    try {
      if (mac) await sh(tool('OSASCRIPT', '/usr/bin/osascript'), ['-e', 'tell application "System Events" to shut down'], { timeout: 60_000 });
      else if (win) await sh('shutdown.exe', ['/s', '/t', '0']);
      else await sh('systemctl', ['poweroff']);
    } catch (err) {
      throw new Error(mac ? osascriptError(err) : `${win ? 'shutdown' : 'systemctl poweroff'} failed: ${err.stderr?.trim() || err.message}`);
    }
  }

  // Names of the apps still open, to say what is holding a shutdown up.
  async function openAppNames() {
    if (mac) return (await sh(tool('OSASCRIPT', '/usr/bin/osascript'), ['-e', 'tell application "System Events" to get name of (processes where background only is false)'], { timeout: 60_000 })).trim().split(', ').filter(Boolean);
    return (await listApps()).map((a) => a.name);
  }

  // ---- Health ------------------------------------------------------------------------------------------------------

  // Total and idle time summed over all cores, from /proc/stat (Linux) or os.cpus().
  function cpuTimes() {
    const stat = !win && !mac ? /^cpu\s+(.+)$/m.exec(readText('/proc/stat') ?? '')?.[1].split(/\s+/).map(Number) : null;
    if (stat && stat.length >= 5 && stat.every(Number.isFinite)) {
      return { total: stat.slice(0, 8).reduce((a, b) => a + b, 0), idle: stat[3] + stat[4] };
    }
    const list = cpus();
    if (!Array.isArray(list) || !list.length) return null;
    let total = 0, idle = 0;
    for (const c of list) {
      for (const k of ['user', 'nice', 'sys', 'idle', 'irq']) total += c.times?.[k] ?? 0;
      idle += c.times?.idle ?? 0;
    }
    return total > 0 ? { total, idle } : null;
  }

  // Busy share between two readings 250 ms apart: the same counters top and Task Manager use.
  async function cpuByCounters() {
    const a = cpuTimes();
    if (!a) return null;
    await delay(250);
    const b = cpuTimes();
    if (!b || b.total <= a.total) return null;
    const used = Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100);
    return used >= 0 && used <= 100 ? used : null;
  }

  // Windows asks the processor load from WMI (what Task Manager shows); a machine that gives no figure falls back to
  // the counters. The result is kept for 5 seconds and shared, so frequent polling starts at most one PowerShell.
  const WIN_CPU_SCRIPT = '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average';
  let cpuCache = null, cpuPending = null;
  function cpuPercent() {
    if (mac) return Promise.resolve(null);
    if (cpuCache && now() - cpuCache.at < 5000) return Promise.resolve(cpuCache.value);
    cpuPending ??= (async () => {
      let value = null;
      if (win) {
        const text = (await quiet(powershell(WIN_CPU_SCRIPT, { timeout: 8000 }), '')).trim();
        const n = Number(text);
        if (/^\d+(\.\d+)?$/.test(text) && n <= 100) value = Math.round(n);
      }
      value ??= await quiet(cpuByCounters());
      cpuCache = { at: now(), value };
      return value;
    })().finally(() => { cpuPending = null; });
    return cpuPending;
  }

  // { cpuUsedPercent, memory: { usedMB, wiredMB, compressedMB } }. A reading that cannot be taken is null, never a
  // guess. Elsewhere memory has no wired or compressed split.
  async function cpuMemory() {
    if (mac) return parseTop(await quiet(sh(tool('TOP', '/usr/bin/top'), ['-l', '2', '-n', '0', '-s', '1'], { timeout: 10_000 }), ''));
    const { total, free } = memory();
    return { cpuUsedPercent: await cpuPercent(), memory: total > 0 ? { usedMB: Math.round((total - free) / 1024 ** 2), wiredMB: null, compressedMB: null } : null };
  }

  // Free memory as a percentage, or null. A Mac's own memory_pressure; elsewhere the free share of installed memory.
  async function memoryFreePercent() {
    if (mac) return parseMemoryFree(await quiet(sh(tool('MEMORY_PRESSURE', '/usr/bin/memory_pressure'), [], { timeout: 2000 }), ''));
    const { total, free } = memory();
    return total > 0 ? Math.round((free / total) * 100) : null;
  }

  // ---- Open apps ---------------------------------------------------------------------------------------------------

  // NSWorkspace lists exactly what the Mac's own Force Quit window lists (regular, Dock-visible apps),
  // and unlike System Events it needs no Automation permission.
  const MAC_LIST_APPS = `
ObjC.import('AppKit');
JSON.stringify($.NSWorkspace.sharedWorkspace.runningApplications.js
  .filter((a) => a.activationPolicy === $.NSApplicationActivationPolicyRegular)
  .map((a) => ({
    name: a.localizedName.js,
    bundleId: a.bundleIdentifier.js || null,
    pid: a.processIdentifier,
    frontmost: a.active,
    hidden: a.hidden,
  })));`;

  // terminate sends the app a normal quit, so it can still ask "Save changes?" or refuse.
  const MAC_QUIT_APP = `
function run([pid]) {
  ObjC.import('AppKit');
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid));
  return JSON.stringify(app.js ? app.terminate : false);
}`;

  const MAC_LIST_WINDOWS = `
function run([pid]) {
  const proc = Application('System Events').processes.whose({ unixId: Number(pid) })[0];
  return JSON.stringify(proc.windows().map((w) => {
    let document = null;
    try { document = w.attributes.byName('AXDocument').value(); } catch {}
    return { title: w.name(), document };
  }));
}`;

  // Counting Finder's windows touches the same two permissions the window list needs.
  const MAC_PROBE_WINDOWS = "Application('System Events').processes.byName('Finder').windows.length; 'ok'";

  // Runs osascript and returns { code, stdout, stderr, signal } whatever the exit status. Only a Mac has it.
  function macScript(script, { args = [], timeout = 15_000 } = {}) {
    if (!mac) throw Object.assign(new Error('Not available on this system: macOS scripting is only on a Mac.'), { unsupported: true });
    return run(tool('OSASCRIPT', '/usr/bin/osascript'), ['-l', 'JavaScript', '-e', script, ...args], { timeout });
  }
  const jxa = async (script, args, opts) => {
    const r = await macScript(script, { args, ...opts });
    if (r.code !== 0) throw Object.assign(new Error(`osascript exited ${r.code}: ${r.stderr.trim()}`), { stderr: r.stderr, killed: Boolean(r.signal) });
    return JSON.parse(r.stdout);
  };

  // 'needs-automation' or 'needs-accessibility' when a window-list error is about a permission, else null.
  function windowPermission(err) {
    const text = `${err.stderr ?? ''} ${err.message}`;
    if (/-1743|Not authorized to send Apple events/i.test(text)) return 'needs-automation';
    // -1719 alone is also "invalid index", so only the assistive-access wording counts.
    if (/-25211|assistive access/i.test(text)) return 'needs-accessibility';
    return null;
  }

  // 'granted'; 'automation' or 'accessibility' for the one still missing (Automation is checked first, so a missing
  // Automation hides the Accessibility answer); 'waiting' when macOS is asking on the Mac and nobody has answered; 'error'.
  async function probeWindowAccess(timeout = 15_000) {
    try {
      await sh(tool('OSASCRIPT', '/usr/bin/osascript'), ['-l', 'JavaScript', '-e', MAC_PROBE_WINDOWS], { timeout });
      return 'granted';
    } catch (err) {
      const needed = windowPermission(err);
      if (needed) return needed.replace('needs-', '');
      return err.killed ? 'waiting' : 'error';
    }
  }

  // [{ name, bundleId, pid, frontmost, hidden }] for the windowed apps a person would call "open".
  async function listApps() {
    need('apps');
    if (mac) return jxa(MAC_LIST_APPS);
    if (win) {
      const out = await powershell('ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id; title = $_.MainWindowTitle } })', { timeout: 15_000 });
      return (parseJson(out, []) ?? []).map((a) => ({ name: a.name, bundleId: null, pid: a.pid, frontmost: false, hidden: false }));
    }
    const pids = new Set((await sh('wmctrl', ['-lp'], { timeout: 15_000 })).split('\n').map((l) => Number(l.trim().split(/\s+/)[2])).filter((n) => n > 0));
    const names = new Map((await sh('ps', ['-axo', 'pid=,comm='], { timeout: 15_000 })).split('\n').flatMap((l) => {
      const m = /^\s*(\d+)\s+(.+)$/.exec(l);
      return m ? [[Number(m[1]), path.basename(m[2])]] : [];
    }));
    return [...pids].filter((pid) => names.has(pid)).map((pid) => ({ name: names.get(pid), bundleId: null, pid, frontmost: false, hidden: false }));
  }

  // Asks the app to quit the way a person would, so it can still ask to save.
  async function quitApp(pid) {
    need('apps');
    if (mac) return void await jxa(MAC_QUIT_APP, [String(pid)]);
    if (win) return void await powershell(`(Get-Process -Id ${Number(pid)}).CloseMainWindow() | Out-Null`, { timeout: 15_000 });
    return void await sh('kill', ['-TERM', String(Number(pid))]);
  }

  // [{ title, document? }] from the Mac's System Events; may reject with a permission error (see windowPermission).
  async function appWindows(pid) {
    need('appWindows');
    return jxa(MAC_LIST_WINDOWS, [String(pid)]);
  }

  // Map of pid -> { ppid, cpu, rssKB } for every process.
  async function processTable() {
    const table = new Map();
    if (win) {
      const rows = parseJson(await powershell('ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; rss = [int]($_.WorkingSetSize / 1024) } })', { timeout: 30_000 }), []);
      for (const r of rows ?? []) if (r.pid) table.set(r.pid, { ppid: r.ppid, cpu: 0, rssKB: r.rss });
      return table;
    }
    for (const line of (await sh(mac ? '/bin/ps' : 'ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], { timeout: 15_000 })).split('\n')) {
      const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
      if (pid) table.set(pid, { ppid, cpu, rssKB: rss });
    }
    return table;
  }

  // Apps Pocket Dev refuses to quit because the system itself runs on them.
  const SYSTEM_APPS = {
    darwin: ['Finder', 'Dock', 'SystemUIServer', 'loginwindow', 'WindowServer', 'ControlCenter', 'NotificationCenter', 'Spotlight', 'Pocket Dev'],
    win32: ['explorer', 'dwm', 'winlogon', 'csrss', 'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost', 'TextInputHost', 'SystemSettings'],
    linux: ['gnome-shell', 'plasmashell', 'xfdesktop', 'Xorg', 'Xwayland', 'systemd', 'sddm', 'gdm', 'lightdm', 'kwin_x11', 'kwin_wayland', 'mutter'],
  };
  const systemApps = () => new Set(SYSTEM_APPS[platform] ?? SYSTEM_APPS.linux);
  const osName = mac ? 'macOS' : win ? 'Windows' : 'Linux';

  // ---- Screen and pictures -----------------------------------------------------------------------------------------

  const LINUX_CAPTURE = [
    ['grim', (f) => ['-t', 'jpeg', f], 'jpg'], ['scrot', (f) => ['-o', f], 'jpg'], ['maim', (f) => [f], 'jpg'],
    ['import', (f) => ['-window', 'root', f], 'jpg'], ['gnome-screenshot', (f) => ['-f', f], 'png'],
  ];
  const linuxCapture = () => LINUX_CAPTURE.find(([name]) => onPath(name));
  const linuxResizer = () => ['magick', 'convert'].find(onPath);

  const WIN_CAPTURE = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:POCKET_DEV_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg)`;

  const WIN_RESIZE = `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:POCKET_DEV_IN)
$side = [double]$env:POCKET_DEV_SIDE
$scale = $side / [Math]::Max($src.Width, $src.Height)
if ($env:POCKET_DEV_SHRINK_ONLY -eq '1' -and $scale -gt 1) { $scale = 1 }
$w = [int][Math]::Max(1, [Math]::Round($src.Width * $scale)); $h = [int][Math]::Max(1, [Math]::Round($src.Height * $scale))
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $w, $h)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]$env:POCKET_DEV_QUALITY)
$bmp.Save($env:POCKET_DEV_OUT, $codec, $params)
$src.Dispose()`;

  // Takes a picture of the main screen into folder `dir` and resolves the file's path (a .jpg, or a .png from tools that
  // cannot write JPEG). Rejects with stderr when the capture fails.
  async function screenshot(dir) {
    need('screenshot');
    if (mac) {
      const file = path.join(dir, 'raw.jpg');
      await sh(tool('SCREENCAPTURE', '/usr/sbin/screencapture'), ['-x', '-m', '-t', 'jpg', file], { timeout: 15_000 });
      return file;
    }
    if (win) {
      const file = path.join(dir, 'raw.jpg');
      await powershell(WIN_CAPTURE, { timeout: 15_000, env: { ...env, POCKET_DEV_OUT: file } });
      return file;
    }
    const [name, args, ext] = linuxCapture();
    const file = path.join(dir, `raw.${ext}`);
    await sh(name, args(file), { timeout: 15_000 });
    return file;
  }

  // sips -Z also enlarges, so a small screen would be blown up when onlyShrink is asked for: only shrink what is wider.
  async function longestSide(file) {
    const out = await sh(tool('SIPS', '/usr/bin/sips'), ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 15_000 });
    return Math.max(...[...out.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
  }

  // Writes `output` as a JPEG whose longest side is `side` pixels (never bigger than the original with onlyShrink).
  async function resizeImage({ input, output, side, quality, onlyShrink = false }) {
    need('imageResize');
    if (mac) {
      const sips = tool('SIPS', '/usr/bin/sips');
      const scale = onlyShrink && (await longestSide(input)) <= side ? [] : ['-Z', String(side)];
      return void await sh(sips, [...scale, '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), input, '--out', output], { timeout: 15_000 });
    }
    if (win) {
      return void await powershell(WIN_RESIZE, { timeout: 15_000, env: { ...env, POCKET_DEV_IN: input, POCKET_DEV_OUT: output, POCKET_DEV_SIDE: String(side), POCKET_DEV_QUALITY: String(quality), POCKET_DEV_SHRINK_ONLY: onlyShrink ? '1' : '0' } });
    }
    const tail = ['-resize', `${side}x${side}${onlyShrink ? '>' : ''}`, '-quality', String(quality), '-strip', `jpeg:${output}`];
    return void await sh(linuxResizer(), [input, ...tail], { timeout: 15_000 });
  }

  // ---- Background service ------------------------------------------------------------------------------------------

  const servicePlanFor = (opts = {}) => servicePlan({
    platform, label: opts.label ?? (env.LABEL || DEFAULT_LABEL), node: opts.node ?? process.execPath, repo: opts.repo ?? repoDir, port: opts.port ?? env.PORT ?? 7777,
    home, user, uid, env, log: opts.log ?? env.LOG,
  });

  async function runPlan(commands) {
    const outputs = [];
    for (const [cmd, args, { ignoreFailure } = {}] of commands) {
      try { outputs.push(await sh(cmd, args, { timeout: 60_000 })); } catch (err) { if (!ignoreFailure) throw err; outputs.push(''); }
    }
    return outputs;
  }

  async function writePlanFiles(plan) {
    for (const f of plan.files) {
      await fsp.mkdir(path.dirname(f.path), { recursive: true });
      const bom = { utf16le: [0xff, 0xfe], utf8bom: [0xef, 0xbb, 0xbf] }[f.encoding];
      await fsp.writeFile(f.path, bom ? Buffer.concat([Buffer.from(bom), Buffer.from(f.content, f.encoding === 'utf16le' ? 'utf16le' : 'utf8')]) : f.content);
    }
    await fsp.mkdir(path.dirname(plan.log), { recursive: true });
  }

  // Installs and starts the background service. A Mac runs scripts/install-service.sh, which also checks the port and
  // waits for the server to answer; the others write the unit or task and run its commands.
  async function installService({ port, force = false, label } = {}) {
    need('service');
    if (mac) {
      const r = await run(path.join(repoDir, 'scripts', 'install-service.sh'), force ? ['--force'] : [], {
        cwd: repoDir, env: { ...env, LABEL: label ?? (env.LABEL || DEFAULT_LABEL), PORT: String(port) }, timeout: 60_000,
      });
      const output = `${r.stdout}${r.stderr}`.trim();
      if (r.code !== 0) throw Object.assign(new Error(output || `install-service.sh exited ${r.code}`), { output });
      return output;
    }
    const plan = servicePlanFor({ port, label });
    await writePlanFiles(plan);
    await runPlan(plan.commands.install);
    return `Installed ${plan.unit} (${plan.kind}). It starts at login and restarts after it stops. Log: ${plan.log}`;
  }

  // { installed, autostart, running, pid }. A Mac's `installed` is the plist file, so the caller adds it.
  async function serviceStatus({ label } = {}) {
    need('service');
    const plan = servicePlanFor({ label });
    const outputs = [];
    for (const [cmd, args] of plan.commands.status) outputs.push(await quiet(sh(cmd, args, { timeout: 10_000 }), ''));
    const parsed = parseServiceStatus(plan.kind, outputs, plan.unit);
    return { ...parsed, installed: mac ? exists(plan.files[0].path) : parsed.installed };
  }

  // Changes only what happens at the next login; it never starts or stops the running service.
  async function setAutostart(enabled, { label } = {}) {
    need('service');
    await runPlan(servicePlanFor({ label }).commands[enabled ? 'enable' : 'disable']);
  }

  // Unloads the service without removing it, so it is not restarted. Returns without waiting (the process may be this one).
  function stopService({ label } = {}) {
    need('service');
    for (const [cmd, args] of servicePlanFor({ label }).commands.stop) start(cmd, args);
  }

  async function uninstallService({ label } = {}) {
    need('service');
    const plan = servicePlanFor({ label });
    await runPlan(plan.commands.uninstall);
    for (const f of plan.files) await fsp.rm(f.path, { force: true });
  }

  // ---- Network and terminals ---------------------------------------------------------------------------------------

  // Interfaces that are not a way to reach this computer from a phone.
  const VIRTUAL = /^(docker|veth|br-|virbr|vmnet|vboxnet|tailscale|zt|utun|lo)|vEthernet|VirtualBox|VMware|Loopback|Hyper-V/i;
  const PREFERRED = /^(en\d|wl|eth|wlan|Wi-?Fi|Ethernet)/i;

  // Every IPv4 address this computer has on a network, best first (a Mac's en0 first). POCKET_DEV_LAN_IP_FILE replaces
  // the interface lookup in tests.
  function lanIps() {
    if (env.POCKET_DEV_LAN_IP_FILE) {
      const ip = readText(env.POCKET_DEV_LAN_IP_FILE)?.trim();
      return ip ? [ip] : [];
    }
    const ifaces = networkInterfaces();
    const all = Object.keys(ifaces);
    const names = mac ? ['en0', ...all.filter((n) => n !== 'en0')]
      : [...all.filter((n) => PREFERRED.test(n) && !VIRTUAL.test(n)), ...all.filter((n) => !PREFERRED.test(n) && !VIRTUAL.test(n))];
    return names.flatMap((name) => (ifaces[name] ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
  }

  // The name this computer announces on the local network, or null. Only a Mac announces <name>.local without setup.
  function localName() {
    if (!mac) return null;
    const name = hostname().toLowerCase();
    return name.endsWith('.local') ? name : `${name}.local`;
  }

  // Login shells take -l; PowerShell and cmd have no such flag.
  function shellArgs(shell) {
    const name = shell.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (name === 'powershell' || name === 'pwsh') return ['-NoLogo'];
    if (name === 'cmd' || win) return [];
    return ['-l'];
  }

  // { pid, command } for the process listening on a TCP port, or null.
  async function portOwner(port) {
    const n = Number(port);
    if (!Number.isInteger(n)) return null;
    try {
      if (win) {
        const out = parseJson(await powershell(`$c = Get-NetTCPConnection -LocalPort ${n} -State Listen -ErrorAction Stop | Select-Object -First 1; $p = Get-Process -Id $c.OwningProcess; ConvertTo-Json -Compress @{ pid = $p.Id; command = $p.ProcessName }`, { timeout: 10_000 }));
        return out?.pid ? { pid: out.pid, command: out.command ?? null } : null;
      }
      if (mac || onPath('lsof')) {
        // `lsof -F pc` prints p<pid> and c<command> lines for each listener.
        const out = await sh('lsof', ['-nP', `-iTCP:${n}`, '-sTCP:LISTEN', '-F', 'pc'], { timeout: 10_000 });
        const pid = /^p(\d+)$/m.exec(out)?.[1];
        return pid ? { pid: Number(pid), command: /^c(.+)$/m.exec(out)?.[1] ?? null } : null;
      }
      const out = await sh('ss', ['-ltnpH', `sport = :${n}`], { timeout: 10_000 });
      const pid = /pid=(\d+)/.exec(out)?.[1];
      return pid ? { pid: Number(pid), command: /users:\(\("([^"]+)"/.exec(out)?.[1] ?? null } : null;
    } catch {
      return null;
    }
  }

  const yes = { available: true };
  const no = (reason) => ({ available: false, reason });
  // Each entry is { available: true } or { available: false, reason }, where the reason is fit to show a person.
  function capabilities() {
    const zip = zipCommand();
    const open = mac || win || onPath('xdg-open');
    const missing = (program, what, hint) => no(`${what} needs ${program}, which is not installed${hint ? ` (${hint})` : ''}.`);
    const captureTool = mac || win || linuxCapture();
    const resizeTool = mac || win || linuxResizer();
    return {
      trash: { available: true, via: mac ? 'NSFileManager' : win ? 'PowerShell' : onPath('gio') ? 'gio' : 'XDG Trash folder' },
      openUrl: open ? yes : no('Opening a page needs xdg-open, which is not installed.'),
      shell: { available: true, path: defaultShell() },
      zip: zip.available ? yes : no(zip.reason),
      battery: yes,
      keepAwake: mac || win || onPath('systemd-inhibit') ? yes : missing('systemd-inhibit', 'Keeping this computer awake', 'part of systemd'),
      sleepNow: mac || win || onPath('systemctl') ? yes : missing('systemctl', 'Putting this computer to sleep', 'part of systemd'),
      shutDown: mac || win || onPath('systemctl') ? yes : missing('systemctl', 'Shutting this computer down', 'part of systemd'),
      temperature: win ? no('Windows gives no battery or processor temperature without extra software.') : mac ? yes : { available: true, partial: 'battery only' },
      batteryCondition: win ? no('Windows does not report battery wear without a battery report.') : yes,
      lid: win ? no('Windows does not say whether the lid is closed.') : yes,
      lidSleep: mac ? yes : no(`Staying awake with the lid closed is only set up for macOS. ${win ? 'On Windows, change what closing the lid does in Power Options.' : 'On Linux, set HandleLidSwitch in logind.conf.'}`),
      updateCheck: mac ? yes : no('Only macOS software updates are checked before sleep and shutdown.'),
      cpu: yes,
      memory: yes,
      disk: yes,
      apps: mac || win || onPath('wmctrl') ? yes : missing('wmctrl', 'Listing open apps', 'works on X11 desktops only'),
      appWindows: mac ? yes : no(`Window names are only available on macOS.`),
      permissions: mac ? yes : no('This system has no per-app privacy permissions to check.'),
      screenshot: !captureTool ? missing('a screenshot tool', 'Showing the screen', 'install grim, scrot, maim or ImageMagick')
        : !resizeTool ? missing('ImageMagick', 'Showing the screen')
          : yes,
      imageResize: resizeTool ? yes : missing('ImageMagick', 'Shrinking pictures'),
      service: mac || win || onPath('systemctl') ? yes : missing('systemctl', 'Running in the background at login', 'part of systemd'),
      mdns: mac ? yes : no('Only a Mac announces a .local name on the network. Use the address instead.'),
      portLookup: mac || win || onPath('lsof') || onPath('ss') ? yes : missing('lsof or ss', 'Finding what uses a port'),
      processScan: win ? no('Finding a program that has a conversation open is not available on Windows yet.') : yes,
    };
  }

  // The capabilities a screen should say are missing, as { key: reason }.
  function unsupported(keys) {
    const caps = capabilities();
    return Object.fromEntries(keys.filter((k) => !caps[k].available).map((k) => [k, caps[k].reason]));
  }

  return {
    platform, osName, host, trash, openUrl, defaultShell, zipCommand, capabilities, unsupported,
    battery, temperatures, batteryCondition, lid, sleepHolds, updateInProgress, keepAwakeCommand, sleepNow, shutDown, openAppNames,
    cpuMemory, memoryFreePercent,
    listApps, quitApp, appWindows, processTable, systemApps, macScript, windowPermission, probeWindowAccess,
    screenshot, resizeImage,
    installService, serviceStatus, setAutostart, stopService, uninstallService, servicePlan: servicePlanFor,
    lanIps, localName, hostname, shellArgs, portOwner,
  };
}

export const platform = createPlatform();
