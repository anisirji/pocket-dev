# Install Pocket Dev on Windows

Prefer your coding assistant? **[Copy the setup prompt](https://www.theani.me/work/pocket-dev/prompts)** and paste it into an agent running on your PC. [AI setup details](AI_SETUP.md).

Checked on Windows 11 with Node 26 and npm 11. Run every command in a normal PowerShell window unless a step says "administrator".

## 1. Prerequisites

- Windows 10 or 11.
- Node.js 22 or newer from [nodejs.org](https://nodejs.org/en/download) (the LTS installer is fine). `winget` is not installed on every PC, so the installer download is the safe route.
- A phone on the same Wi-Fi as the PC.

Check Node. Open a new PowerShell window after installing it:

```powershell
node -v
npm -v
```

You should see `v22` or higher, then an npm version number.

## 2. Install

Keep the `@anisirji/` and the `-g`:

```powershell
npm install -g @anisirji/pocket-dev
pocket-dev doctor
```

`pocket-dev doctor` is the check. It prints a tick or a cross for Node, npm's global folder on PATH, the `pocket-dev` command, terminals, the tools and port 7777, and the exact next command for each cross. It exits 0 when everything required works.

Installing also adds **Pocket Dev Admin** shortcuts, with the Pocket Dev logo, to your Desktop and Start menu. Windows does not let a program pin itself to the taskbar, so the last click is yours: right-click the shortcut and choose **Pin to taskbar**. Undo: `pocket-dev admin unpin` (and unpin it from the taskbar yourself). Skip: `$env:POCKET_DEV_NO_PIN=1` before installing, or `npm install -g --ignore-scripts`; `pocket-dev setup` still offers it. This part is written and covered by tests, but it has not been run on a real Windows PC yet.

Camera capture uses a tab in the computer browser, so there is no extra camera software to install. Before leaving the computer, open **Admin → This computer → Remote camera → Prepare remote camera** and allow a persistent browser camera permission. Later, Start camera on the phone opens or reuses the camera tab automatically; no one needs to operate the computer for each preview. [Camera details](CAMERA.md).

## 3. Start

```powershell
pocket-dev start
```

You should see a QR code, then:

```
Pocket Dev running at http://192.168.1.20:7777
Password: Xk3p9QwR2tLm
```

The password is shown once, so copy it. On your phone, scan the QR code, or open the address and type the password. On the PC itself, `http://localhost:7777` also works. If you missed the address, `ipconfig` shows the IPv4 address of your Wi-Fi adapter.

## 4. Firewall

The first time, Windows Defender Firewall asks whether Node.js may accept connections. Choose **Private networks** and Allow.

If you dismissed the prompt, or chose Public only, the phone cannot connect. Add the rule from an **administrator** PowerShell (Start, type PowerShell, right-click, Run as administrator):

```powershell
New-NetFirewallRule -DisplayName "Pocket Dev" -Direction Inbound -Program "C:\Program Files\nodejs\node.exe" -Action Allow -Profile Private
```

Your Wi-Fi must be classed as a Private network (Settings, Network and internet, Wi-Fi, your network, Network profile type). If Node is installed elsewhere, change the `-Program` path (`where.exe node` prints it).

## 5. Optional tools

Chats need at least one of Claude Code or Codex. Everything else works without them. `pocket-dev setup --check` lists what is missing; `pocket-dev setup` offers to install each item and shows the command first.

| Tool | Install | Log in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Git | [git-scm.com/download/win](https://git-scm.com/download/win) | none |
| GitHub CLI (`gh`) | Installer (.msi) from [cli.github.com](https://cli.github.com/) | `gh auth login` |
| cloudflared (internet access only) | `.msi` from [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | none for a Quick link |

If you do have winget, `winget install --id Git.Git -e`, `winget install --id GitHub.cli -e` and `winget install Cloudflare.cloudflared` also work. After installing a tool, open a new terminal and restart Pocket Dev so its terminals see the new PATH.

> **Experimental:** Google Antigravity CLI (`agy`) in Chat. Pocket Dev starts `agy acp` and talks to it over the Agent Client Protocol. It was tested by hand on macOS with Antigravity CLI 1.5.9, and not yet on this system, so it may not work here. See the [roadmap](ROADMAP.md).

> **Experimental:** GitHub Copilot CLI (`copilot`) in Chat. Pocket Dev starts `copilot --acp --stdio` and talks to it over the Agent Client Protocol, with the sign-in that `copilot login` made. It was tested on macOS with Copilot CLI 1.0.112, and not yet on this system. See the [roadmap](ROADMAP.md).

## 6. Keep it running, start at login

- Without a window, for this session: `Start-Process pocket-dev.cmd -ArgumentList 'start','--no-open' -WindowStyle Hidden`
- At login: run `pocket-dev admin`, open **Service**, and install the start-at-login task (a Task Scheduler task). This part is written from the code and not yet tested on a real PC.

Coming soon: `pocket-dev service` on Windows. Today it is macOS only.

## 7. Update and uninstall

The Admin page's **Update** button and `pocket-dev update` stop Pocket Dev while npm installs, because Windows cannot replace files that are in use, then start it again. Open terminals close. From 2.1.4 on this happens by itself. To update 2.1.3 or older, or by hand, stop Pocket Dev first:

```powershell
schtasks /End /TN dev.pocket.server; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*pocket-dev*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
npm install -g @anisirji/pocket-dev@latest
pocket-dev start
```

To remove it: `npm uninstall -g @anisirji/pocket-dev`.

Settings stay in `%USERPROFILE%\.pocket-dev` until you delete that folder.

## Errors and fixes

| You see | Cause and fix |
| --- | --- |
| `npm error code EBUSY` ... `rename` when updating | Pocket Dev was still running, and Windows will not replace a folder in use. Versions before 2.1.4 update from inside Pocket Dev, so this always happens there. Stop it and install by hand, as in [Update and uninstall](#7-update-and-uninstall). |
| `EEXIST ... pocket-dev.cmd` while installing | A different npm package named `pocket-dev` owns the command. Run `npm uninstall -g pocket-dev`, then `npm install -g @anisirji/pocket-dev`. |
| `unknown command 'start'. See 'main --help'` | Same cause: you are running the other package. Same fix. |
| After the fix above, `cli.js` is missing or the command still fails | The install was left half done. In PowerShell: `Remove-Item -Recurse -Force "$env:APPDATA\npm\node_modules\@anisirji"` and `Remove-Item -Force "$env:APPDATA\npm\pocket-dev*"`, then `npm install -g @anisirji/pocket-dev`. |
| `pocket-dev` is not recognized | Open a new PowerShell window. Still missing: `npm config get prefix` prints npm's global folder (normally `%APPDATA%\npm`); it must be on PATH. `pocket-dev doctor` prints the fix; if the command is missing run `npx -y @anisirji/pocket-dev doctor`. |
| `npm error 404` or you installed `anisirji/pocket-dev` | Use the scoped name with the `@`: `npm install -g @anisirji/pocket-dev`. Without the `@` npm installs from GitHub. |
| `ENOENT`, `TAR_ENTRY_ERROR`, or `spawn cmd.exe ... node-pty` | npm lost files while unpacking (antivirus or a bad cache). Remove `%APPDATA%\npm\node_modules\@anisirji` as above, run `npm cache clean --force`, then `npm install -g @anisirji/pocket-dev --foreground-scripts`. Pause real-time antivirus or exclude `%APPDATA%\npm` and `%LOCALAPPDATA%\npm-cache`. |
| "Terminals are not available on this computer" | `node-pty` did not install. Run `pocket-dev doctor --fix`, then restart Pocket Dev. If it must build, install Visual Studio Build Tools (Desktop development with C++) and Python 3 first. |
| The phone cannot open the address | Same Wi-Fi (not mobile data or a guest network)? Firewall rule in step 4? Wi-Fi marked Private? Use the numeric address, not `localhost`. Run `pocket-dev doctor`. |
| Port 7777 is in use | An older copy or another program has it. `pocket-dev start --port 7780`, or `pocket-dev config set port 7780`. |
| Forgot the password | `pocket-dev admin`, then **Password**. No old password needed. |
| Device screen says "Could not capture the screen" | Unlock the PC and sign in. Pocket Dev must run as you, from `pocket-dev start` or Start at login, not as a system service. |
| Install fails with `EACCES` | Do not use an administrator window for npm. Reinstall Node for the current user, or fix npm's prefix. |

## Not on Windows

Temperature, lid control and window names show "Not available on this system". Do not use the remote Sleep button unless you know the PC wakes; nothing remote can wake it.

More: [full guide](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md), [reference](https://github.com/anisirji/pocket-dev/blob/main/docs/REFERENCE.md).
