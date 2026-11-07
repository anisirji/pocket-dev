# Pocket Dev

Control your Mac from your phone's browser on the same Wi-Fi: terminals, Claude Code and Codex chats, Git and GitHub pull requests, files, open apps, and power.

Pocket Dev is one Node.js server that runs on the Mac as your user. The phone opens `http://<mac-lan-ip>:7777`, logs in with a password or a one-time QR code, and gets a mobile web app. Nothing is installed on the phone.

- A one-page summary of what Pocket Dev can access on the Mac: [ACCESS.md](ACCESS.md).

## Features

### Terminal

| Feature | What it does | Does not |
| --- | --- | --- |
| Real terminals | Each tab is a login shell (`$SHELL -l`, zsh) in a pty on the Mac. Output streams over a WebSocket. | Survive a server restart. Run as root. |
| Folder picker | **+** lists Home, pinned folders, the last 5 folders, and every folder in `~/Desktop` and `~/Desktop/Projects` with `.git` or `package.json`. Type any other path. | Scan deeper than one level for the project list. |
| Tab names | Named after the folder (`app`, `app 2`). Resumed tabs are `claude · app` or `codex · app`. | |
| Input and key bar | **Send** types the input and then Enter 30 ms later. Empty **Send** sends Enter. Keys: ⚡, 📋, Ctrl+C, Enter, Esc, Tab, arrows (application cursor mode aware), Ctrl+D. | |
| Scrolling | Touch scroll with fling, 5,000 lines on the phone. **↓ latest** jumps to the bottom. | |
| Reconnect | Terminals keep running when the phone sleeps. On reconnect, the server replays up to about 500 KB per terminal. Dead sockets are pinged out every 30 s. | |
| Shared terminals | Several pages can attach to one terminal. The page that types last sets the size. | Keep two different sizes at once. |
| Copy | **📋** shows the last 300 lines as selectable text with **Copy all**. Works on plain http. | |
| Upload | **📎** or paste an image. Saves to `~/.pocket-dev/uploads` (25 MB per file) and inserts the quoted path into the input. | Press Enter. Delete old uploads. |
| Shortcuts | **⚡** runs saved commands. Up to 30, each 1 to 200 characters, stored in `config.json`. | |

### Ports

Forward `localhost:<port>` on the Mac to `<mac-lan-ip>:<port>`, so the phone can open a dev server. It is a raw TCP pipe (127.0.0.1 first, then ::1), so HMR WebSockets work. When the Mac's LAN IP changes, every forward moves to the new IP within about 10 s.

It does not protect forwarded ports with a password, persist forwards across restarts, forward ports below 1024, or forward Pocket Dev's own port.

### Git

| Feature | What it does | Does not |
| --- | --- | --- |
| Repo picker | Finds repositories up to two levels below `~/Desktop`, `~/Desktop/Projects`, and `~`, or below `repoRoots`. Only scanned repositories are accepted. | Open a repository outside the roots. |
| Graph | Last 300 commits on all branches with lanes, **Load more**, branch and tag chips. | |
| Commit detail | Message, author, files with line counts, per-file diffs. Merge commits diff against the first parent. Diffs are cut at 3,000 lines. | |
| Changes | Branch, ahead and behind, staged, unstaged, and untracked files with diffs. | Stage, commit, pull, or switch branches. |
| Pull requests | Up to 50 open PRs with review state and checks. Detail shows description, checks, files, diffs, reviews, and comments. | Show issues. |
| Review | Approve, request changes, or comment through `gh pr review`. | Approve your own PR (GitHub refuses). |
| Merge | Squash, merge commit, or rebase, with `--match-head-commit` so a newer push makes the merge fail. Optional **Delete branch** removes the branch on GitHub only. | Delete the local branch or a fork's branch. |
| Close and reopen | `gh pr close` and `gh pr reopen`. | Delete the branch. |
| Create PR | Head, base (default branch first), title, description, draft. Pushes first with `git push -u origin <branch>` when the branch is not on GitHub or has unpushed commits. | |

### Resume

Lists the 30 most recent Claude Code and Codex conversations from `~/.claude/projects` and `~/.codex`, filtered by **All**, **Claude**, or **Codex**. Shows the latest 20 messages. **Continue in terminal** opens a terminal in the conversation's folder and types `claude --resume <id>` or `codex resume <id>`. A conversation is marked **open on laptop?** when a running process has its id on the command line or its file changed in the last 2 minutes.

Choose **Continue in terminal** or **Continue in chat**. Resume reads the history files; the selected engine writes its normal history when you continue. Close the conversation on the laptop before resuming elsewhere.

### Chat

| Feature | What it does | Does not |
| --- | --- | --- |
| Engines | Claude through `@anthropic-ai/claude-agent-sdk` 0.2.139, which runs your installed `claude`. Codex through one shared `codex app-server`. Both use your existing logins. | Store any Claude or Codex credentials. |
| Chat screens | Chat list, new chat (engine, folder, model, mode), and a conversation view with markdown, tool folds, and diffs. | |
| Allow and Deny | Cards for commands, file edits, tools, and plans: **Allow once**, **Always allow in this chat**, **Always allow in this project** when Claude offers it, and **Deny** with an optional reason. The Permissions screen lists and removes remembered rules. | Time out a waiting card. |
| Questions | Answers `AskUserQuestion` (Claude) and `requestUserInput` (Codex), with **Other…**. | Multi-select on Codex. |
| Stop | Interrupts the turn. The server ends it after 5 s if the engine does not stop. | |
| Models and modes | Model lists come from each engine, with custom model names supported. Claude has Ask every time, Accept edits, Plan, Auto, Don’t ask, and Bypass. Codex has independent Approval (Ask first, On request, Never ask), Sandbox (Read only, Workspace, Full access), and Effort controls. Bypass and Full access need confirmation. Chips report whether a change applies now or next turn; replies show their model. | |
| Sessions | Pocket Dev keeps `~/.pocket-dev/chats/<id>.json`. Claude Code and Codex keep their own transcripts in `~/.claude` and `~/.codex`, shared with VS Code and the CLI. | Delete the engine's own transcripts. |
| Idle sleep | Stops an idle engine after `chatIdleMinutes` (default 10). The next message wakes and resumes it. | Sleep a chat with a running turn or a waiting card. |

### Files

Browse `fileRoots` (by default your home folder), with every path checked again after symlinks resolve. Sort by name, date, or size, show hidden files, and pin folders. Upload several files in a queue with progress (2 GB each, never overwrites), download files (byte ranges), zip a selection or a folder (`/usr/bin/zip`, 4 GB before compression, 200,000 files), new folder, rename files and folders, move to the macOS Trash, name search (4 levels, 500 results, 2 s), copy path, and preview (images, video, audio, PDF, and the first 200 KB of text; HTML shows as text; previews are sandboxed).

Trash uses macOS’s native Trash operation. Restore items in Finder on the Mac. Files does not permanently delete, restore from its own interface, move or copy between folders, or search file contents.

### Open apps

Lists regular apps (the same set as the Force Quit window) with memory and CPU summed over each app's process tree, frontmost first, refreshed every 10 s. Shows each app's windows and document paths. **Quit** sends a normal quit and waits 8 s. **Force quit** sends SIGTERM, then SIGKILL after 3 s.

It does not quit protected apps (Finder, Dock, SystemUIServer, loginwindow, WindowServer, ControlCenter, NotificationCenter, Spotlight, and the app Pocket Dev runs inside), list windows on other Spaces, open apps, or move windows.

### Power

| Feature | What it does | Does not |
| --- | --- | --- |
| Keep Mac awake | `off`, `plugged` (default, `caffeinate -s`), or `always` (`caffeinate -i -s`). caffeinate runs with `-w <server pid>`, so it ends with the server. | Change system settings. Keep the display on. |
| Battery badge | `pmset -g batt` every 60 s. Red at 20% or less on battery. | |
| Lid closed | `sudo pmset -a disablesleep 1` or `0`, run by `npm run lid` in a new terminal where you type your password. Refused while the lid is closed. | Store or send your password anywhere. Turn itself off. |
| Sleep | `pmset sleepnow` after 2 s. With Lid closed on, `npm run sleep` turns lid sleep back on first (password). | Wake the Mac. |
| Shut down | Ends Pocket Dev terminals, then `osascript` tells System Events to shut down. After 45 s the phone shows a blocked screen with **Try shut down again**, **See open apps**, **Force shut down…** (`sudo shutdown -h now` in a terminal), and **Keep the Mac on**. | Force without your password. |
| Update guard | Refuses sleep and shutdown while a macOS update installs, or when the check fails. | Guard the lid switch. |

### Login and security

| Feature | What it does |
| --- | --- |
| Password | scrypt hash (N=16384, r=8, p=1) in `config.json` as `passwordHash`. A random 12-character password is printed on the first start only. A plaintext `password` key is converted at start. Wrong passwords wait 1 s. New passwords need 6 to 200 characters. |
| QR login | One-time key, 10 minutes, kept in memory. Printed at start, by `npm run qr`, or by **Show login QR** on a logged-in phone. Only the Mac can mint keys (loopback, no proxy headers, secret from `~/.pocket-dev/local-secret`). |
| Devices | Each login is a device in `~/.pocket-dev/devices.json` (sha256 of the cookie, never the cookie). Rename, log out, online now (open terminal or a request in the last 60 s). |
| Device limit | `maxDevices`, default 2, 1 to 20. Password logins stop at the limit. A QR login evicts the least recently used device. |
| Rate limit | 10 wrong passwords per IP in 15 minutes locks that IP for 15 minutes. The Admin page warns at 5 failures in an hour. |
| Cookie | `pd_token`, HttpOnly, SameSite=Strict, 1 year. No `Secure` flag, because the transport is http. |
| CSRF | Every POST, PUT, PATCH, and DELETE needs `x-pocket-dev: 1`. JSON bodies need `content-type: application/json`. WebSocket upgrades check `Origin`. |
| Approve, block, lockdown, security log | `requireApproval` makes password logins wait up to 10 minutes for approval on the Mac, with a 4-character code to compare. Blocked devices are refused on every route, across restarts. Lockdown logs out every non-blocked device, stops forwards, voids QR keys, disconnects phone access, and optionally closes terminals or sets a new password. Only the Mac can reconnect phone access. Events go to `~/.pocket-dev/security.log` (JSONL, mode 0600, rotated at 1 MB to `security.log.1`). |
| Admin page | `http://localhost:7778` (`adminPort`, default phone port + 1), bound to 127.0.0.1 and ::1, with a Host allowlist, Origin and proxy-header refusal, and an `x-pocket-admin: 1` header on writes. It has no password, because only a process on the Mac can reach it. Sections: Connection, Waiting, Devices (rename, log out, block, unblock), Security log (latest 200, filters), Password (no old password needed), Settings (device limit, approval, login QR, addresses), Live (close terminals, stop forwards and active chats, read-only Power and Open apps status), Service (install, Start automatically, stop), Lockdown. |
| Connect and Disconnect | Disconnect closes port 7777 and all forwards. Terminals keep running and devices stay logged in. A phone can disconnect, only the Mac can connect. With **Keep connection open** off, access closes about 30 s after the last Admin page closes (10 s heartbeat) and a restart starts disconnected. Saved as `access` in `config.json`. |
| Start automatically | `launchctl enable` or `disable` for `dev.pocket.server`, from the Admin page, the phone, or `npm run autostart`. Does not stop the running server. |

## Requirements

- macOS. Tested on macOS 14.5.
- Node.js 22.
- Xcode Command Line Tools (`xcode-select --install`), to build `node-pty`.
- Optional: `claude` (Claude Code), `codex`, and `gh` (GitHub CLI, logged in with `gh auth login`). Features that need a missing tool show an error.
- The phone needs internet access, because it loads xterm.js from `cdn.jsdelivr.net`.

## Install and run

```sh
npm install
npm start
```

`postinstall` marks node-pty's `spawn-helper` as executable, because node-pty 1.1.0 ships it without the execute bit.

The first start writes `config.json` (mode 0600) and prints the password once, a login QR code, and the URL.

| Command | What it does |
| --- | --- |
| `npm start` | Run the server in the foreground. |
| `npm run qr` | Print a fresh login QR code and URL from the running server. |
| `npm run admin` | Open the Mac-only Admin page. |
| `npm run connect`, `npm run disconnect` | Turn phone access on or off. |
| `npm run autostart -- on\|off\|status` | Turn the launchd agent's start at login on or off, or show it. |
| `npm run service:install` | Install or restart the launchd agent `dev.pocket.server` (`--force` if the port is busy). |
| `npm run service:uninstall` | Stop and remove the launchd agent. |
| `npm run service:status` | Show job state, URL, caffeinate assertions, and the last 20 log lines. |
| `npm run service:logs` | Follow `~/Library/Logs/pocket-dev.log`. |
| `npm run awake -- on\|plugged\|off\|status` | Set or show the Keep awake mode (`on` is `always`). |
| `npm run lid -- on\|off\|status` | Set or show lid-closed sleep with `sudo pmset -a disablesleep`. Refused while the lid is closed. |
| `npm run sleep` | Turn lid sleep back on (sudo) and sleep the Mac. |
| `npm run shutdown [-- --force]` | Shut down through System Events, or with `--force` through `sudo shutdown -h now`. |

The launchd agent writes `~/Library/LaunchAgents/dev.pocket.server.plist`, starts at login (not at boot), restarts within about 10 s after a crash, and logs to `~/Library/Logs/pocket-dev.log`. Each restart closes all terminals. Devices stay logged in.

## Configuration

`config.json` lives in the repository folder (or at `POCKET_DEV_CONFIG`). Pocket Dev rereads it at use, and app changes write back only the changed key, so you can edit it while the server runs.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `7777` | Phone port. `PORT` overrides it. |
| `passwordHash` | generated | scrypt hash of the password. |
| `password` | none | Plaintext password to migrate. Converted to `passwordHash` at start. |
| `maxDevices` | `2` | Device limit, 1 to 20. |
| `folders` | `[]` | Pinned folders (terminal picker and Files). |
| `recentFolders` | `[]` | Last 5 terminal folders. |
| `shortcuts` | `claude`, `codex`, `npm run dev`, `git status`, `git pull` | ⚡ commands. |
| `repoRoots` | `~/Desktop`, `~/Desktop/Projects`, `~` | Git scan roots. `POCKET_DEV_REPO_ROOTS` (colon-separated) overrides it. |
| `awake` | `plugged` | Keep awake mode: `off`, `plugged`, or `always`. |
| `allowedHosts` | `[]` | Additional hostnames accepted by the phone listener. |
| `chatDefaults` | saved by Chat | Last safe tool, folder, model, mode, and effort choices. Bypass and Full access are never silently remembered. |
| `chatIdleMinutes` | `10` | Idle minutes before a chat engine stops. |
| `requireApproval` | `false` | New devices wait for approval on the Mac. |
| `fileRoots` | home folder | Folders Files may show. |
| `fileUploadMax` | 2 GiB | Files upload limit in bytes. |
| `fileZipMax` | 4 GiB | Zip limit in bytes, before compression. |
| `adminPort` | phone port + 1 (`7778`) | Admin page port. `POCKET_DEV_ADMIN_PORT` overrides it. |
| `access` | `{"connected": true, "keepOpen": true}` | Phone access and Keep connection open. |

Environment variables: `PORT`, `POCKET_DEV_CONFIG`, `POCKET_DEV_PASSWORD` (overrides the stored password and is printed at start), `POCKET_DEV_REPO_ROOTS`, `POCKET_DEV_STATE_DIR` (instead of `~/.pocket-dev` for authentication, security logs, Admin metadata, and chats), `POCKET_DEV_CHAT_DIR` (an explicit chat-storage override), `POCKET_DEV_ADMIN_PORT`, and `POCKET_DEV_NO_OPEN` (do not open the Admin page at start).

## Permissions it needs

Pocket Dev runs as your user, never as root, and never runs `sudo` itself.

| Permission | Needed for |
| --- | --- |
| Firewall: incoming connections for `node` | The phone can connect (only when the firewall is on). |
| Automation: control **System Events** | Normal shutdown, window names in Open apps. |
| Accessibility | Window names in Open apps. |
| Full Disk Access (maybe) | Files, for TCC-protected folders. |
| Your `claude`, `codex`, and `gh` logins | Chat, terminals, Git. |
| Your Mac password, typed by you in a terminal | Lid closed, sleep with Lid closed on, force shutdown. |

macOS grants TCC permissions to the app that started `node`: Terminal or VS Code for `npm start`, `node` for the launchd agent.

## Security model

- Same Wi-Fi only, plain http. Anyone who can read the Wi-Fi traffic can see the cookie and terminal contents. Use a trusted network.
- Port 7777 listens on all interfaces (`0.0.0.0`). Forwarded ports listen on the LAN IP and have no password.
- A logged-in device has the full rights of your user: shell, files, and your Claude, Codex, and GitHub logins (limited by the credentials and permissions you have configured).
- Protections: hashed password and cookies, one-time QR keys only from the Mac, device limit, SameSite=Strict HttpOnly cookie, the `x-pocket-dev` header and JSON content-type for every change, WebSocket `Origin` check, a Git repository allowlist, path checks after symlink resolution in Files, and sandboxed previews.
- The Admin page on 127.0.0.1:7778 has a Host allowlist, so it resists DNS rebinding. It has no password, so any local process can use it.
- Not protected: traffic sniffing on the LAN, forwarded ports, an unlocked logged-in phone, local processes on the Mac, or a malicious program on the Mac. Both the phone and Admin listeners check Host headers; `allowedHosts` can add a tunnel hostname.

## Limitations

- No internet access, no https, no passkeys yet.
- Terminals and port forwards do not survive a restart.
- Old uploads in `~/.pocket-dev/uploads` are never deleted.
- The Git view does not stage, commit, pull, or switch branches.
- The phone needs internet for xterm.js from cdn.jsdelivr.net.
- Pocket Dev cannot wake or power on the Mac.

## Tests

Run `npm test` on macOS. The suite starts disposable phone and Admin listeners, uses fixture folders and stubbed power commands, and exercises authentication, Host/Origin/CSRF checks, Unicode terminals, chat persistence, Files, blocked and pending devices, and lockdown. It makes no model calls and does not install a service or quit user apps.

## Roadmap

- A domain and Cloudflare Tunnel for access from anywhere.
- https through the tunnel.
- Passkeys and fingerprint login on the phone.
- An Android share target to send screenshots and files into Pocket Dev.
