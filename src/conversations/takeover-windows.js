import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// How Windows answers what takeover.js asks: the process table, which process holds each Codex thread lock, and how to
// stop a program gently. The PowerShell scripts only print data; everything that reads it is a pure function below.

// -EncodedCommand, because powershell.exe re-parses quotes in a -Command argument and the C# below is full of them.
export const encodeScript = (script) => Buffer.from(script, 'utf16le').toString('base64');
const powershell = (script, env = {}) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)],
    { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 32 << 20, windowsHide: true },
    (err, out) => (err ? reject(err) : resolve(out)));
});

// Windows has no uid; a process in the same logon session as Pocket Dev counts as the same user.
const PROCESS_SCRIPT = 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { @{ '
  + 'pid = $_.ProcessId; ppid = $_.ParentProcessId; session = $_.SessionId; name = $_.Name; exe = $_.ExecutablePath; args = $_.CommandLine; '
  + 'started = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } })';

// Win32_Process rows to the { pid, ppid, uid, stat, started, exe, args, argv } that listProcesses returns. `uid` is 0 for
// Pocket Dev's own session and -1 for any other, so findCopies' uid check reads "same session".
export function parseWinProcesses(rows, selfPid) {
  const list = [].concat(rows ?? []).filter((r) => Number.isInteger(r?.pid) && r.pid > 0);
  const self = list.find((r) => r.pid === selfPid);
  return list.map((r) => {
    const exe = r.exe || r.name || '';
    const args = r.args || exe;
    return {
      pid: r.pid, ppid: r.ppid ?? 0, uid: self && r.session === self.session ? 0 : -1, stat: 'R',
      started: Number.isFinite(r.started) ? r.started : NaN, exe, args, argv: splitCommandLine(args).slice(1),
    };
  });
}

export async function listWinProcesses() {
  return parseWinProcesses(JSON.parse(await powershell(PROCESS_SCRIPT) || '[]'), process.pid);
}

// A Windows command line split the way CommandLineToArgvW does it. The program name ends at the next space, or at the
// closing quote when it starts with one. In the arguments, 2n backslashes before a quote are n backslashes and the quote
// opens or closes a quoted part, 2n+1 are n and a literal quote, "" inside a quoted part is a literal quote, and
// backslashes before anything else are kept as they are.
export function splitCommandLine(line) {
  const out = [];
  let i = 0;
  const quotedProgram = line[0] === '"';
  const programEnd = quotedProgram ? line.indexOf('"', 1) : line.search(/[ \t]/);
  const end = programEnd === -1 ? line.length : programEnd;
  out.push(line.slice(quotedProgram ? 1 : 0, end));
  i = end + (quotedProgram && programEnd !== -1 ? 1 : 0);
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) return out;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (!quoted && (c === ' ' || c === '\t')) break;
      if (c === '\\') {
        let n = 0;
        while (line[i + n] === '\\') n++;
        if (line[i + n] === '"') {
          arg += '\\'.repeat(n >> 1);
          if (n % 2) arg += '"';
          else quoted = !quoted;
          i += n;
        } else {
          arg += '\\'.repeat(n);
          i += n - 1;
        }
      } else if (c === '"') {
        if (quoted && line[i + 1] === '"') { arg += '"'; i++; } else quoted = !quoted;
      } else {
        arg += c;
      }
    }
    out.push(arg);
  }
}

// Restart Manager reports every process that has a file open. Each lock gets its own session, so each pid is tied to its
// thread. A lock that no process holds is one Codex left after a crash, and prints nothing.
const LOCKS_SCRIPT = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class PocketDevLocks {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int AppType; public uint AppStatus; public uint SessionId; [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, IntPtr appList, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] list, ref uint reasons);
  public static List<int> Holders(string file) {
    var pids = new List<int>();
    uint handle;
    if (RmStartSession(out handle, 0, new StringBuilder(33)) != 0) return pids;
    try {
      if (RmRegisterResources(handle, 1, new[] { file }, 0, IntPtr.Zero, 0, null) != 0) return pids;
      uint needed, count = 0, reasons = 0;
      if (RmGetList(handle, out needed, ref count, null, ref reasons) != 234) return pids;
      var list = new ProcessInfo[needed];
      count = needed;
      if (RmGetList(handle, out needed, ref count, list, ref reasons) == 0) for (int i = 0; i < count; i++) pids.Add(list[i].Process.Pid);
    } finally { RmEndSession(handle); }
    return pids;
  }
}
'@
Get-ChildItem -LiteralPath $env:POCKET_DEV_LOCK_DIR -Filter *.lock | ForEach-Object {
  $thread = $_.BaseName
  foreach ($holder in [PocketDevLocks]::Holders($_.FullName)) { "$holder $thread" }
}`;

// "<pid> <thread id>" lines to [{ pid, threadId }].
export function parseLockHolders(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), threadId: m[2] }] : [];
  });
}

export async function winCodexLocks(dir) {
  const any = fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && path.extname(e.name) === '.lock');
  return any ? parseLockHolders(await powershell(LOCKS_SCRIPT, { POCKET_DEV_LOCK_DIR: dir })) : [];
}

// A Ctrl+C to the console the program runs in, which Node programs such as claude and codex hear as SIGINT. The helper is
// its own PowerShell process, so Pocket Dev's console is never detached or signalled; it ignores the Ctrl+C it sends.
const CTRL_C_SCRIPT = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PocketDevCtrlC {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
  public static string Send(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "no-console";
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    bool sent = GenerateConsoleCtrlEvent(0, 0);
    FreeConsole();
    return sent ? "sent" : "failed";
  }
}
'@
[PocketDevCtrlC]::Send([uint32]$env:POCKET_DEV_CTRL_C_PID)`;

export async function sendCtrlC(pid) {
  return (await powershell(CTRL_C_SCRIPT, { POCKET_DEV_CTRL_C_PID: String(pid) })).trim();
}

// process.kill on Windows ends a program at once (TerminateProcess), whatever the signal. So SIGINT becomes a Ctrl+C, and
// a program with no console to receive it is ended at once instead. Returns the signal that took effect: 'SIGINT' for a
// Ctrl+C, 'SIGKILL' for an immediate end, which can cut off a write the program was making.
export const WINDOWS_ACTIONS = { SIGINT: 'ctrl-c', SIGTERM: 'terminate', SIGKILL: 'terminate' };

export async function winKill(pid, signal, { ctrlC = sendCtrlC, terminate = (p) => process.kill(p) } = {}) {
  if (WINDOWS_ACTIONS[signal] === 'ctrl-c' && await ctrlC(pid).catch(() => 'failed') === 'sent') return 'SIGINT';
  terminate(pid);
  return 'SIGKILL';
}
