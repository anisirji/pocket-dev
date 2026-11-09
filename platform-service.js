import path from 'node:path';

// What it takes to run Pocket Dev in the background at login on each system: a definition file (launchd plist,
// systemd user unit, Task Scheduler task) and the commands that install, query and remove it. Pure: nothing here
// touches the system, so every OS is tested from a Mac. platform.js runs the commands.

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// systemd splits ExecStart and Environment on spaces; double quotes keep a path with a space whole.
const systemdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const DEFAULT_LABEL = 'dev.pocket.server';
export const PASS_THROUGH = ['POCKET_DEV_CONFIG', 'POCKET_DEV_STATE_DIR', 'POCKET_DEV_ADMIN_PORT'];

// Where the service writes its log, per system.
export function defaultLog({ platform, home, env }) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Logs', 'pocket-dev.log');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'pocket-dev', 'pocket-dev.log');
  return path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'pocket-dev', 'pocket-dev.log');
}

// Byte-for-byte what scripts/install-service.sh printed before it moved here (with XML escaping added).
function plist({ label, node, repo, port, log, home, user, extraEnv }) {
  const extra = Object.entries(extraEnv).map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(repo)}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:${escapeXml(home)}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>HOME</key><string>${escapeXml(home)}</string>
    <key>SHELL</key><string>/bin/zsh</string>
    <key>USER</key><string>${escapeXml(user)}</string>
    <key>PORT</key><string>${port}</string>
    <key>LABEL</key><string>${escapeXml(label)}</string>
${extra}  </dict>
</dict>
</plist>
`;
}

function systemdUnit({ label, node, repo, port, log, home, extraEnv }) {
  const env = {
    PATH: `${path.posix.dirname(node)}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'en_US.UTF-8', PORT: String(port), LABEL: label, POCKET_DEV_SERVICE: label, ...extraEnv,
  };
  return `[Unit]
Description=Pocket Dev (${label})
After=network-online.target

[Service]
ExecStart=${systemdQuote(node)} ${systemdQuote(`${repo}/server.js`)}
WorkingDirectory=${systemdQuote(repo)}
Restart=always
RestartSec=10
${Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`).join('\n')}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

// Task Scheduler cannot restart a program that exits cleanly, and Pocket Dev restarts itself by exiting, so the task
// runs this small loop, which is launchd's KeepAlive with its 10 second throttle.
function windowsRunner({ node, repo, port, label, log, extraEnv }) {
  const env = { PORT: String(port), LABEL: label, POCKET_DEV_SERVICE: label, ...extraEnv };
  return `${Object.entries(env).map(([k, v]) => `$env:${k} = ${psQuote(v)}`).join('\n')}
Set-Location -LiteralPath ${psQuote(repo)}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(log)}) | Out-Null
while ($true) {
  & ${psQuote(node)} ${psQuote(`${repo}\\server.js`)} *>> ${psQuote(log)}
  Start-Sleep -Seconds 10
}
`;
}

function windowsTask({ label, runnerPath, repo }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Pocket Dev (${escapeXml(label)}): starts at login and restarts after it stops.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${escapeXml(runnerPath)}"</Arguments>
      <WorkingDirectory>${escapeXml(repo)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const WIN_TASK_STATE = (label) => `Get-ScheduledTask -TaskName ${psQuote(label)} -ErrorAction Stop | ForEach-Object { ConvertTo-Json -Compress @{ state = [string]$_.State } }`;

// plan({ platform, label, node, repo, port, home, user, env }) -> { kind, unit, files, commands, log }
//   files:    [{ path, content, encoding? }] to write before the commands run
//   commands: install, uninstall, start, stop, status, enable, disable: lists of [cmd, args, { ignoreFailure? }]
// Linux and Windows files go in the user's own folders and need no administrator rights.
export function servicePlan({ platform, label = DEFAULT_LABEL, node, repo, port, home, user = '', uid = 0, env = {}, log }) {
  const logFile = log ?? defaultLog({ platform, home, env });
  const extraEnv = Object.fromEntries(PASS_THROUGH.filter((k) => env[k]).map((k) => [k, env[k]]));
  const opts = { label, node, repo, port, log: logFile, home, user, extraEnv };

  if (platform === 'darwin') {
    const domain = `gui/${uid}`;
    const file = path.posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      kind: 'launchd', unit: label, log: logFile, domain,
      files: [{ path: file, content: plist(opts) }],
      commands: {
        install: [['launchctl', ['enable', `${domain}/${label}`]], ['launchctl', ['bootstrap', domain, file]]],
        uninstall: [['launchctl', ['bootout', `${domain}/${label}`], { ignoreFailure: true }]],
        stop: [['launchctl', ['bootout', `${domain}/${label}`]]],
        enable: [['launchctl', ['enable', `${domain}/${label}`]]],
        disable: [['launchctl', ['disable', `${domain}/${label}`]]],
        status: [['launchctl', ['print-disabled', domain]], ['launchctl', ['print', `${domain}/${label}`]]],
      },
    };
  }

  if (platform === 'win32') {
    const dir = path.win32.dirname(logFile);
    const runnerPath = path.win32.join(dir, 'service-run.ps1');
    const taskPath = path.win32.join(dir, `${label}.xml`);
    return {
      kind: 'schtasks', unit: label, log: logFile,
      files: [
        { path: runnerPath, content: windowsRunner(opts) },
        { path: taskPath, content: windowsTask({ label, runnerPath, repo }), encoding: 'utf16le' },
      ],
      commands: {
        install: [['schtasks', ['/Create', '/TN', label, '/XML', taskPath, '/F']], ['schtasks', ['/Run', '/TN', label]]],
        uninstall: [['schtasks', ['/End', '/TN', label], { ignoreFailure: true }], ['schtasks', ['/Delete', '/TN', label, '/F']]],
        stop: [['schtasks', ['/End', '/TN', label]]],
        enable: [['schtasks', ['/Change', '/TN', label, '/ENABLE']]],
        disable: [['schtasks', ['/Change', '/TN', label, '/DISABLE']]],
        status: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_TASK_STATE(label)]]],
      },
    };
  }

  const unit = `${label}.service`;
  const file = path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'systemd', 'user', unit);
  const ctl = (...args) => ['systemctl', ['--user', ...args]];
  return {
    kind: 'systemd', unit, log: logFile,
    files: [{ path: file, content: systemdUnit(opts) }],
    commands: {
      install: [ctl('daemon-reload'), ctl('enable', unit), ctl('restart', unit)],
      uninstall: [[...ctl('disable', '--now', unit), { ignoreFailure: true }], ctl('daemon-reload')],
      stop: [ctl('stop', unit)],
      enable: [ctl('enable', unit)],
      disable: [ctl('disable', unit)],
      status: [ctl('show', unit, '--property=MainPID,ActiveState,UnitFileState,LoadState')],
    },
  };
}

// Reads what the status command printed into { installed, autostart, running, pid }.
export function parseServiceStatus(kind, outputs, label) {
  if (kind === 'systemd') {
    const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(outputs[0] ?? '')?.[1]?.trim();
    const pid = Number(get('MainPID')) || null;
    const installed = get('LoadState') === 'loaded';
    return { installed, autostart: installed && get('UnitFileState') === 'enabled', running: get('ActiveState') === 'active' && pid !== null, pid };
  }
  if (kind === 'schtasks') {
    let state = null;
    try { state = JSON.parse(outputs[0] ?? '').state; } catch {}
    return { installed: state !== null, autostart: state !== null && state !== 'Disabled', running: state === 'Running', pid: null };
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const override = new RegExp(`"${escapeRe(label)}" => (\\w+)`).exec(outputs[0] ?? '')?.[1];
  const pid = Number(/^\tpid = (\d+)$/m.exec(outputs[1] ?? '')?.[1]) || null;
  return { autostart: override !== 'disabled' && override !== 'true', running: pid !== null, pid };
}
