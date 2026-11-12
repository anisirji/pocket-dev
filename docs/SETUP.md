# Guided setup: `pocket-dev setup`

One guided pass takes a computer from nothing to a working, logged-in Pocket Dev on macOS, Windows or Linux. It opens by itself on the first start, and `pocket-dev setup` runs it again any time.

```
npm install -g @anisirji/pocket-dev
pocket-dev start
```

## Decisions

These were made without asking, so they are written down here.

- **Required means Node.js 22 or newer with npm.** Pocket Dev cannot run without it, and `pocket-dev setup --check` exits 0 exactly when it is fine. Git is recommended. Claude Code and Codex are each optional, but chats need at least one, so setup says so when neither is ready. GitHub CLI and cloudflared are optional.
- **Setup never runs administrator commands.** On Linux every package manager command needs `sudo`, so setup prints the exact command for you to run and carries on. The same goes for `npm install -g` when npm's global folder is not writable by you. Setup never runs `sudo`, never asks for an administrator password and never tries to work around it.
- **winget runs as you.** Windows shows its own permission prompt in its own window if an installer needs one. Setup does not hide or answer it.
- **Only official packages, never a downloaded script.** `@anthropic-ai/claude-code` and `@openai/codex` from npm; Git, GitHub CLI and cloudflared from Homebrew or winget. No `curl | sh`, no `iex (irm ...)`. A missing Homebrew or winget is not installed for you: setup prints how to get it yourself.
- **Node is never updated by setup.** Setup is running on that Node. If it is too old, setup prints the command and stops short.
- **Logins belong to the tool.** Setup runs `claude auth login`, `codex login` or `gh auth login` with your terminal attached, so the browser flow works. Setup never reads, prints, stores or sends a token, and a built-in guard refuses any command line carrying a password, token or API key flag. Status checks are reduced to yes, no or "could not check" and their output is thrown away.
- **No terminal means no changes.** If stdin or stdout is not a terminal (a pipe, CI, a script), setup behaves like `--check`: it prints the status and what to run, and changes nothing, even with `--yes`.
- **The guide opens on the first start, not on install.** npm hides `postinstall` output and many installs use `--ignore-scripts`, so the first `pocket-dev start` with a terminal attached runs the full guide before the server starts. When it finishes, `~/.pocket-dev/setup-done` is written and later starts skip it. A finished `pocket-dev setup` writes the same file. Only `pocket-dev start` opens the guide; other commands never do, so scripts that call them keep working.
- **No terminal, no questions.** A start without a terminal (a script, CI, `npx` in a pipe) or with `CI` set prints the status table and the command `pocket-dev setup`, then starts as usual. `pocket-dev start --no-setup` or `POCKET_DEV_NO_SETUP=1` skips even that.
- **Accounts are explicit opt-ins.** Installing or logging in to Claude Code, Codex and GitHub CLI asks `[y/N]`, and `--yes` never does it. Turning on internet access and Windows automatic login are never pre-selected either, and anything that needs administrator rights is printed for you to run.
- **`--yes` applies the recommended set, not secrets.** It installs Git and cloudflared when missing, applies the Always on list (start at login, Keep awake), and keeps the existing network setting and password. If no password exists it does not invent one: Pocket Dev makes one on its first start and prints it there.
- **Always on asks one question, then once more.** "Should this computer always be reachable from your phone?" defaults to yes on a computer without a battery and to no on a laptop. Then one numbered list ("I will: 1 ... 2 ...") and one "Apply the recommended settings? [Y/n]". Answer n to choose item by item. Nothing outside the list changes.
- **The end always shows how to log in.** A server that setup just started can take a few seconds to listen, so setup asks it for a login code for up to 10 seconds. Then it prints the address, the internet address when a link runs, and the QR code. Without a terminal it prints the address and the command `pocket-dev qr`, no QR art and no login key.
- **The greeting is made on your computer.** After the QR code, two boxes with a note from Ani and links to https://theani.me and https://github.com/anisirji/pocket-dev. Personal touches come only from this computer: the first name when the user name looks like one, the time of day, the system, whether a Claude Code or Codex command was found, and the Keep awake setting setup just made. No network call, no analytics. It never shows without a terminal or in CI. `--quiet` hides it and `pocket-dev config set greeting plain` turns the personal touches off. The words are in `public/greeting-copy.js`. The phone shows the plain wording once, as "Welcome to Pocket Dev", after its first login.
- **`--dry-run` runs only read-only checks** (`--version`, login status, `npm prefix -g`, and a look at the start-at-login state). It asks nothing, installs nothing, logs in to nothing and writes nothing, including the log.
- **Linux start at login uses the existing systemd user unit** (the same code as the admin page). Without systemd, setup says so and prints `pocket-dev start`.
- **cloudflared needs no login.** A Quick link needs none. A link on your own domain uses a tunnel token you paste in Admin or give to `pocket-dev internet domain`; setup does not handle that token.
- **Setup and the app find tools the same way.** `POCKET_DEV_CLAUDE`, `POCKET_DEV_CODEX` and `POCKET_DEV_CLOUDFLARED` win when set; otherwise the same PATH and install folders the chats use. If you point one at a file that does not exist, setup reports it as not installed, which is what the app would hit.

## Commands

| Command | What it does |
| --- | --- |
| `pocket-dev setup` | The guided flow below. Asks before every change. |
| `pocket-dev setup --check` | Read-only status table and the command to fix each gap. Exit code 0 when everything required is OK, 1 otherwise. |
| `pocket-dev setup --yes` | Applies the recommended set (see Decisions). Needs a terminal. |
| `pocket-dev setup --dry-run` | Prints the plan: what it would run and ask. Changes nothing. |
| `pocket-dev setup --quiet` | The same guide without the greeting at the end. |
| `pocket-dev setup --only <step>` | One step: `node`, `git`, `claude`, `codex`, `gh`, `cloudflared`, `terminals`, `password`, `network`, `always-on` (also `autostart`) or `finish`. |
| `pocket-dev start --no-setup` | Starts without the first-start guide. `POCKET_DEV_NO_SETUP=1` does the same. |

Setup is safe to run again. A step that is already done says so and does nothing. Ctrl+C stops between steps; every change setup makes is a finished write, so nothing is left half done.

What ran is appended to `~/.pocket-dev/setup.log` (on Windows, `%USERPROFILE%\.pocket-dev\setup.log`): a timestamp, the command line and how it ended. Never anything a program printed, and no secret.

## What you see, step by step

Each tool step prints a status line first.

```
✓ Git: installed 2.52.0
✗ Codex: not installed
  Will run: npm install -g @openai/codex
  Source: npm package @openai/codex.
  Install now? [Y/n]
```

The guide opens with why it is worth two minutes and what it will never do. On yes, the command runs with its output streaming, then the tool is checked again. If it is installed but logged out:

```
✗ Claude Code: installed 2.1.319, not logged in
  Will run: claude auth login   (your browser opens; Pocket Dev never sees what you type there)
  Log in now? [y/N]
```

Git and cloudflared ask `[Y/n]`. Claude Code, Codex and GitHub CLI ask `[y/N]`: they are your accounts.

If a step cannot be done by setup, it says why, prints the exact manual steps and a link, and moves on.

1. **Node.js and npm.** Needs Node 22 or newer. Too old or missing: manual steps, and setup stops short at the end.
2. **Git.** Recommended. Lets the Git screen work.
3. **Claude Code** (`claude`). Install, then `claude auth login`.
4. **Codex** (`codex`). Install, then `codex login`.
5. **GitHub CLI** (`gh`). Optional, for pull requests. Install, then `gh auth login`.
6. **cloudflared.** Optional, for the internet link.
7. **Password.** Choose or change the password (6 to 200 characters, typing hidden, asked twice). Only a scrypt hash is saved in `config.json`, the same way the admin page does it. Skipped if the password comes from `POCKET_DEV_PASSWORD`.
8. **Phone access.** Wi-Fi only (the default), or Wi-Fi plus a Quick internet link. The link option needs cloudflared. Your own domain is set with `pocket-dev internet domain` or on the admin page, and setup leaves it alone.
9. **Always on.** One question, "Should this computer always be reachable from your phone?", then one list and one confirm:

   ```
   I will:
     1. Keep this computer awake: always (stays awake on battery too).
        Will run: pocket-dev config set awake always
     2. Run Pocket Dev in the background and start it at login. This also starts it now.
        Will run: pocket-dev service install   (writes ~/Library/LaunchAgents/dev.pocket.server.plist and loads it)
   Then I show the address and a QR code to log in. Nothing outside this list changes.
   Apply the recommended settings? [Y/n]
   ```

   Keep awake is `always` for a computer meant to stay reachable and `plugged` otherwise. Start at login is launchd on macOS, the Task Scheduler task on Windows (the same one `scripts\windows-install.ps1` creates), and a systemd user unit on Linux. Then a "Good to know" list that setup changes nothing about: the firewall prompt (on Windows the Private-network rule to run yourself as administrator), the system's own sleep and hibernate settings, automatic login and its trade-off (anyone who can switch the computer on gets your account; setup never turns it on and never stores the password), "Restore on AC power loss" in the BIOS for a desktop, what a Quick link does to the address after a restart and `pocket-dev internet domain` for a fixed one, and the headless limits. It ends with a checked table: starts at login, running, Keep awake.
10. **Open it on your phone.** Waits up to 10 seconds for a server that is still starting, then prints the Wi-Fi address (and the internet address when a link is running, with `pocket-dev qr --link <address>` for its QR code), a one-time QR code valid for a few minutes, and how to use it: scan it with the phone camera, or open the address and type the password, then use the browser menu's Add to Home Screen. When it runs in the background, setup says so: do not run `pocket-dev start` again. A new code any time: `pocket-dev qr`.
11. **The greeting.** Two boxes: a short note from Ani, then who made Pocket Dev, with the links. See Decisions.

If setup installed a tool while Pocket Dev was already running, it ends with: restart Pocket Dev so it sees the new tool (`pocket-dev service restart`). A running copy keeps the PATH it started with.

## Commands per tool per OS

This is exactly what setup runs, or prints when it may not run it.

| Tool | Installed check | macOS | Windows | Linux |
| --- | --- | --- | --- | --- |
| Node.js 22+ and npm | `node --version`, `npm --version` | prints `brew install node` | prints `winget install OpenJS.NodeJS` | prints the link https://nodejs.org/en/download (or nvm, fnm, your package manager) |
| Git | `git --version` | with Homebrew: `brew install git`. Without: prints `xcode-select --install` | `winget install --id Git.Git -e` | prints `sudo apt install git`, `sudo dnf install git`, `sudo pacman -S git` or `sudo zypper install git`; with Homebrew on Linux, runs `brew install git` |
| Claude Code | `claude --version`; login `claude auth status` | `npm install -g @anthropic-ai/claude-code` | same | same |
| Codex | `codex --version`; login `codex login status` | `npm install -g @openai/codex` | same | same |
| GitHub CLI | `gh --version`; login `gh auth status` | `brew install gh` | `winget install --id GitHub.cli -e` | prints `sudo apt install gh`, `sudo dnf install gh`, `sudo pacman -S github-cli` or `sudo zypper install gh`; with Homebrew, `brew install gh`; link https://github.com/cli/cli/blob/trunk/docs/install_linux.md |
| cloudflared | `cloudflared --version` | `brew install cloudflared` | `winget install Cloudflare.cloudflared` | with Homebrew, `brew install cloudflared`; `sudo pacman -S cloudflared` printed on Arch; otherwise the download page https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |

| Login | Command |
| --- | --- |
| Claude Code | `claude auth login` |
| Codex | `codex login` |
| GitHub CLI | `gh auth login` |

Rules that apply to the table:

- **"prints"** means setup shows the command and does not run it: it needs administrator rights, or it replaces the Node that is running setup.
- **npm global installs** run as you. If npm's global folder is not writable by you (common with a system Node on Linux or macOS), setup prints `sudo npm install -g <package>` instead of running it. A Node installed in your home folder (nvm, fnm) avoids that.
- **No Homebrew (macOS) or no winget (Windows):** setup prints how to get it (https://brew.sh, https://aka.ms/getwinget) and the tool's own download page, and continues.

Start at login, per OS:

| OS | What setup does |
| --- | --- |
| macOS | `pocket-dev service install` (a launchd agent, `~/Library/LaunchAgents/dev.pocket.server.plist`). |
| Windows | Writes the runner and task definition under `%LOCALAPPDATA%\pocket-dev` and runs `schtasks /Create ...` then `schtasks /Run ...` as you. `scripts\windows-install.ps1` does the same plus `npm install` when you work from a source checkout. |
| Linux | Writes `~/.config/systemd/user/dev.pocket.server.service`, then `systemctl --user daemon-reload`, `systemctl --user enable dev.pocket.server.service` and `systemctl --user restart dev.pocket.server.service`. To start before you log in, run once `loginctl enable-linger $USER` (printed, not run). Without systemd, run `pocket-dev start`. |

## Per-OS notes

**macOS.** Homebrew (https://brew.sh) is the only package manager setup uses. `/usr/bin/git` on a Mac without Apple's command line tools is a stub that opens an installer window; setup detects that without running it and treats Git as not installed.

**Windows.** Run it in a normal (not administrator) PowerShell or Command Prompt. After winget installs something, the window you are in may not see it yet. Setup says so: open a new terminal and run `pocket-dev setup` again. Tools installed with npm are found in `%APPDATA%\npm`.

**Linux.** Package manager installs are printed for you to run with `sudo`. Setup does not need root for anything else. If Homebrew for Linux is installed, setup uses it for Git, GitHub CLI and cloudflared.

## On the phone

Settings has a **Tools on this computer** section: a tick or cross for Node, Git, Claude Code, Codex, GitHub CLI and cloudflared, and for anything missing or logged out the exact command to run on that computer, with a Copy button. It reads `GET /api/setup/status` (after login, owner devices only). The answer holds each tool's name, version and yes/no state and the command to fix it. It never holds file paths, account names, emails or what any command printed. It is cached for 20 seconds.

## Troubleshooting

- **Something is wrong with the installation.** Run `pocket-dev doctor`. It checks Node, npm's global folder on PATH, the `pocket-dev` command, terminals (it starts a shell for a second), the tools, the settings folder and port 7777, and prints the exact next command for each problem. Exit code 0 means everything required works, 1 means something required is missing. `pocket-dev setup` runs the same terminal check as a step.
- **"Terminals are not available on this computer".** `node-pty` is optional, so a failed download or build never fails the install. Run `pocket-dev doctor --fix` (it shows each command and asks `[Y/n]` first; it never uses `sudo` or downloads scripts), then restart Pocket Dev.
- **Windows install failed with `ENOENT`, `TAR_ENTRY_ERROR` or `spawn cmd.exe ... node-pty`.** In PowerShell: `Remove-Item -Recurse -Force "$env:APPDATA\npm\node_modules\@anisirji"`, then `npm cache clean --force`, then `npm install -g @anisirji/pocket-dev` (keep the `@anisirji/` and the `-g`; `npm i anisirji/pocket-dev` installs from GitHub into the current folder), then `pocket-dev doctor --fix`. Antivirus that deletes files while npm unpacks can cause this; add an exclusion for `%APPDATA%\npm` and `%LOCALAPPDATA%\npm-cache`.
- **`pocket-dev doctor` says "local" or "npx".** That copy is not installed for the whole computer. Install it with `npm install -g @anisirji/pocket-dev`; the doctor prints the command that removes the stray copy.
- **"This is not an interactive terminal"** You ran setup from a pipe, a script or an editor task. Open a real terminal and run `pocket-dev setup`.
- **Installed, but this window cannot see it yet.** The installer updated PATH for new windows only. Open a new terminal and run `pocket-dev setup` again.
- **`EACCES` or "npm cannot write to its global folder".** Run the printed `sudo npm install -g ...` yourself, or install Node with nvm or fnm so npm writes to your home folder.
- **"Could not check the login in 8 seconds".** The tool's status command was slow (often a network wait). Run it yourself: `claude auth status`, `codex login status` or `gh auth status`.
- **A tool shows "not installed" but you installed it.** Check `which claude` (macOS, Linux) or `where claude` (Windows) from the same terminal. If it lives somewhere unusual, set `POCKET_DEV_CLAUDE`, `POCKET_DEV_CODEX` or `POCKET_DEV_CLOUDFLARED` to its full path. Setup and the app both honour them.
- **Start at login failed on macOS because port 7777 is in use.** Another Pocket Dev is running. Stop it, or see `pocket-dev service status`.
- **Start at login is not available on Linux.** There is no `systemctl`. Run `pocket-dev start` in a terminal or write your own service.
- **"Pocket Dev is not running yet, so there is no address."** Run `pocket-dev start`. It prints the address and a QR code.
- **`pocket-dev start` says "Pocket Dev is already running in the background".** That is the copy setup started. Nothing is wrong: it prints the address and a fresh QR code. Restart it with `pocket-dev service restart`.
- **`pocket-dev doctor` and the port.** A tick with "Pocket Dev is running on it" is the healthy state. A cross means another program holds the port, and the doctor suggests a free one, never 7778 (the Admin page port).
- **A tool you just installed is missing in Pocket Dev's terminals or chats.** Restart Pocket Dev: `pocket-dev service restart`, or stop it and run `pocket-dev start`.
- **Forgot the password.** `pocket-dev setup --only password` sets a new one.
- **What did setup do?** Read `~/.pocket-dev/setup.log`.
