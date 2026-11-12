# Install Pocket Dev on Windows

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

> **Upcoming:** Google Antigravity CLI (`agy`) support, in the terminal and in Chat. It is not available yet. See the [roadmap](ROADMAP.md).

## 6. Keep it running, start at login

- Without a window, for this session: `Start-Process pocket-dev.cmd -ArgumentList 'start','--no-open' -WindowStyle Hidden`
- At login: run `pocket-dev admin`, open **Service**, and install the start-at-login task (a Task Scheduler task). This part is written from the code and not yet tested on a real PC.

Coming soon: `pocket-dev service` on Windows. Today it is macOS only.

## 7. Update and uninstall

```powershell
npm install -g @anisirji/pocket-dev@latest
npm uninstall -g @anisirji/pocket-dev
```

Settings stay in `%USERPROFILE%\.pocket-dev` until you delete that folder.

## Errors and fixes

| You see | Cause and fix |
| --- | --- |
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
