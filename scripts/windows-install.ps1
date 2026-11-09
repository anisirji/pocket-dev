# Sets up Pocket Dev on Windows in one go. Run it from a normal (not administrator) PowerShell in the project folder:
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows-install.ps1
#
# It checks Node 22 or newer, runs npm install, registers a Task Scheduler task that starts Pocket Dev hidden at every
# login and restarts it after it stops, starts it now, and prints the address and the first password. Run it again at
# any time: it only repairs what is missing (npm install, the task definition) and never starts a second server.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a byte order mark as ANSI.
[CmdletBinding()]
param(
  # The port to listen on. Default: "port" in config.json, else 7777.
  [int]$Port = 0,
  # Skip npm install (the packages are already there).
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

function Update-SessionPath {
  # A tool installed after this window opened (Node, Git) is on the registry PATH but not on this window's.
  $registry = foreach ($scope in 'Machine', 'User') { [Environment]::GetEnvironmentVariable('Path', $scope) }
  $env:Path = (($registry + $env:Path) | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }) -join ';'
}
function Stop-Setup([string]$message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

Update-SessionPath

# 1. Node 22 or newer
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Stop-Setup 'Node.js is not installed. Install version 22 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS), then run this again.' }
$nodeVersion = (& node --version).Trim()
if ([int](($nodeVersion -replace '^v', '').Split('.')[0]) -lt 22) { Stop-Setup "Node $nodeVersion is too old. Pocket Dev needs Node 22 or newer (winget install OpenJS.NodeJS)." }
Write-Host "Node $nodeVersion found at $($nodeCommand.Source)"

# 2. Packages
if ($SkipInstall) {
  Write-Host 'Skipping npm install.'
} else {
  Write-Host 'Running npm install (a minute or two the first time)...'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm install failed. The messages above say why; fix that and run this again.' }
}

# 3. Port: the -Port argument, else config.json, else 7777.
if ($Port -le 0) {
  $fromConfig = (& node bin/pocket-dev.js config get port 2>$null | Out-String).Trim()
  $Port = if ($fromConfig -match '^\d+$') { [int]$fromConfig } else { 7777 }
}

$log = Join-Path $env:LOCALAPPDATA 'pocket-dev\pocket-dev.log'

# 5. The task. The definition (hidden window, registry PATH, restart after a stop) comes from platform-service.js, the
#    same code the admin page uses. Creating it replaces an existing one; starting a running task does nothing.
$listening = $false
try { $listening = [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop) } catch { }
$taskState = ''
try { $taskState = [string](Get-ScheduledTask -TaskName 'dev.pocket.server' -ErrorAction Stop).State } catch { }
if ($listening -and $taskState -ne 'Running') {
  Stop-Setup "Port $Port is already used by another program. Close it, or run this again with -Port <another number>."
}
Write-Host 'Registering the start-at-login task...'
$env:PORT = [string]$Port
# (single quotes inside: Windows PowerShell 5.1 drops double quotes from arguments it passes to programs)
$install = 'import { platform } from ''./platform.js''; console.log(await platform.installService({ port: Number(process.env.PORT) }));'
& node --input-type=module -e $install
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Could not create the scheduled task. The message above says why.' }

# 6. Wait for the server to answer.
$url = "http://127.0.0.1:$Port/"
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true }
  catch { if ($_.Exception.Response) { $up = $true } else { Start-Sleep -Seconds 1 } }
}
if (-not $up) { Stop-Setup "Pocket Dev did not answer on port $Port within 40 seconds. Read the log for the reason: $log" }

# 7. Windows Firewall asks on first use whether node may accept connections. A task has no window to ask in, so without
#    an allow rule a phone on Wi-Fi cannot connect. Adding a rule needs administrator rights; without them, say how.
$nodePath = $nodeCommand.Source
$ruleName = 'Pocket Dev (node.exe)'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hasRule = $false
try { $hasRule = [bool](Get-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop) } catch { }
if (-not $hasRule) {
  if ($admin) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Program $nodePath -Profile Private | Out-Null
    Write-Host 'Added a firewall rule so phones on your private network can connect.'
  } else {
    Write-Host 'If your phone cannot connect, allow node through the firewall. In an administrator PowerShell run:' -ForegroundColor Yellow
    Write-Host "  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Program '$nodePath' -Profile Private"
  }
}

# 8. What the user needs to know. The server prints "Password: ..." only on its very first start.
$text = ''
if (Test-Path -LiteralPath $log) {
  $stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try { $text = (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
}
# Only the newest "Password:" line counts: a later start prints "(set; change it in Settings)", which does not match.
$passwordLine = [regex]::Matches($text, '(?m)^Password: .*$') | Select-Object -Last 1
$password = if ($passwordLine) { [regex]::Match($passwordLine.Value, '^Password: (\S+)\s*$') } else { $null }
if ($password -and -not $password.Success) { $password = $null }
$address = [regex]::Matches($text, '(?m)^Pocket Dev running at (\S+)') | Select-Object -Last 1

Write-Host ''
Write-Host 'Pocket Dev is running.' -ForegroundColor Green
if ($address) { Write-Host "  Open on your phone: $($address.Groups[1].Value)" } else { Write-Host "  Open on this PC: http://localhost:$Port/  (the address for your phone is in the log: $log)" }
if ($password) {
  Write-Host "  First password:     $($password.Groups[1].Value)" -ForegroundColor Cyan
  Write-Host '  It is shown only once. Write it down, then change it in Settings on the phone.'
  Write-Host "  (It stays in the log file until you delete the line: $log)"
} else {
  Write-Host '  A password is already set (it is only shown on the very first start).'
}
Write-Host ''
Write-Host 'If you lose the password:'
Write-Host '  1. Stop it:   schtasks /End /TN dev.pocket.server'
Write-Host "  2. Open $env:USERPROFILE\.pocket-dev\config.json in Notepad and either delete the line with passwordHash"
Write-Host '     (a new password is printed in the log at the next start) or add  "password": "your new password",'
Write-Host '     (it is turned into a hash at the next start and removed from the file).'
Write-Host '  3. Start it: schtasks /Run /TN dev.pocket.server'
Write-Host "Log: $log"
Write-Host 'Remove it later with:  schtasks /End /TN dev.pocket.server ; schtasks /Delete /TN dev.pocket.server /F'
