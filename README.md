# Pocket Dev

Control your Mac from your phone's browser on the same Wi-Fi: terminals, Claude Code and Codex chats, Git and GitHub pull requests, files, open apps, and power.

Pocket Dev is one Node.js server that runs on the Mac as your user. The phone opens `http://<mac-lan-ip>:7777`, logs in with a password or a one-time QR code, and gets a mobile web app. Nothing is installed on the phone.

- A one-page summary of what Pocket Dev can access on the Mac: [ACCESS.md](ACCESS.md).

## Features

### Terminal

| Feature | What it does | Does not |
| --- | --- | --- |
| Real terminals | Each tab is a login shell (`$SHELL -l`, zsh) in a pty on the Mac. A separate terminal host keeps shells and recent output through server updates and reconnects the same tabs afterwards. If the host is unavailable, the restart confirmation identifies terminals that will end. On phones, type in the command field and swipe the output to scroll. | Survive a Mac restart. Run as root. |
| Folder picker | **+** lists Home, pinned folders, the last 5 folders, and every folder in `~/Desktop` and `~/Desktop/Projects` with `.git` or `package.json`. Type any other path. | Scan deeper than one level for the project list. |
| Tab names | Named after the folder (`app`, `app 2`). Resumed tabs are `claude · app` or `codex · app`. | |
| All terminals | **☰** next to **+** lists every terminal with its folder, running or exited, and when it last printed. Tap a row to jump to it, **✕** to close it. | |
| Input and key bar | **Send** types the input and then Enter 30 ms later. Empty **Send** sends Enter. One compact row has **Answer**, ↑ / ↓, **Enter**, and **More**. When Codex shows “⇧← to answer”, tap **Answer**, use ↑ / ↓ to choose, then **Enter**. **More** opens the remaining keys, shortcuts, and Copy; it closes after a choice. Terminal tabs hide while the phone keyboard is open and return when it closes. | |
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

Choose **Continue in terminal** or **Continue in chat**. Resume reads the history files; the selected engine writes its normal history when you continue. Codex Chat reuses the local daemon when available. If a conversation belongs to a different Codex server and reports an active writer, close the original session before retrying. Close Claude conversations on the laptop before resuming elsewhere.

### Chat

| Feature | What it does | Does not |
| --- | --- | --- |
| Engines | Claude through `@anthropic-ai/claude-agent-sdk` 0.2.139, which runs your installed `claude`. Codex connects to its running local daemon so terminal conversations can continue in Chat. Without a daemon, it starts one shared `codex app-server` process. Both use your existing logins. | Store any Claude or Codex credentials. |
| Chat screens | Chat list, new chat (engine, folder, model, mode), and a conversation view with markdown, tool folds, and diffs. | |
| Queue | Type while the agent is working and the button says **Queue**. Waiting messages stay in a compact tray above the composer, with a shortened one-line preview, **Edit**, and **Remove**. Edit loads the full text into the bottom message box; **Save** keeps its place and attachments, and **Cancel** restores your separate draft. If the agent already picked it up, **Keep draft** preserves the edit without sending another message. The tray stays at the bottom while replies stream; a large queue scrolls inside the tray. When the agent takes a message, it leaves the tray and appears in full in the conversation. Messages go out one per turn, in order. There is one **Stop** in the status line. Up to 20 messages can wait. After a failed turn the rest appear as **Not sent** instead of running. Waiting messages are held in memory, so a server restart marks them **Not sent**. | Survive a restart. |
| Attached images | A picture you attach with 📎 shows as a small preview in your own message, not just a file name. Tap it for the original. Other files stay as `📎 name`. The preview is a 480 px JPEG made once with `sips` and kept in the chat's `.images` folder. The route serves only a file listed on that message and only if it is an image, never an arbitrary path. | Preview files that are gone (they fall back to the name). |
| Tool images | A picture a tool returns (for example `Read` on a PNG) shows in the tool's fold instead of `[image]`. Tap it for the full size. Files up to 8 MB are saved in `~/.pocket-dev/chats/<id>.images/` (mode 0600), only their names go in the chat, and deleting the chat deletes them. | Show images over 8 MB or in other formats (those stay `[image]`). |
| Allow and Deny | Cards for commands, file edits, tools, and plans: **Allow once**, **Always allow in this chat**, **Always allow in this project** when Claude offers it, and **Deny** with an optional reason. The Permissions screen lists and removes remembered rules. | Time out a waiting card. |
| Questions | Answers `AskUserQuestion` (Claude) and `requestUserInput` (Codex), with **Other…**. | Multi-select on Codex. |
| Stop | Interrupts the turn. The server ends it after 5 s if the engine does not stop. | |
| Models and modes | Model lists come from each engine, with custom model names supported. Claude has Ask every time, Accept edits, Plan, Auto, Don’t ask, and Bypass. Codex has independent Approval (Ask first, On request, Never ask), Sandbox (Read only, Workspace, Full access), and Effort controls. Bypass and Full access need confirmation. Chips report whether a change applies now or next turn; replies show their model. | |
| Sessions | Pocket Dev keeps `~/.pocket-dev/chats/<id>.json`. Claude Code and Codex keep their own transcripts in `~/.claude` and `~/.codex`, shared with VS Code and the CLI. | Delete the engine's own transcripts. |
| Idle sleep | Stops an idle engine after `chatIdleMinutes` (default 10). The next message wakes and resumes it. | Sleep a chat with a running turn or a waiting card. |

Switching Codex Approval to **Never ask** immediately declines pending and new permission requests, including during a running turn. It preserves sandbox restrictions and ordinary questions. The next turn also receives the updated Codex policy.

Terminal and Chat reconnect when the phone wakes or its network returns. Heartbeats detect a socket that still appears open after losing its connection. Chat waits for a fresh server snapshot before enabling Send or showing approval cards. Draft text stays editable while offline; reconnecting never submits it automatically.

Chat drafts (including uploaded attachments) and terminal command drafts are saved per conversation in the current browser tab and restored after a reload. Files still uploading cannot be restored after a reload. A delayed response cannot clear another chat's draft or text typed since sending. Chat sends time out after 20 seconds if the response never arrives; retrying the same draft uses its original message ID, with the last 256 accepted IDs saved per chat to prevent duplicate messages or queued entries. Server-side queues still have the restart limits described above.

### Files

Browse `fileRoots` (by default your home folder), with every path checked again after symlinks resolve. Sort by name, date, or size, show hidden files, and pin folders. Upload several files in a queue with progress (2 GB each, never overwrites), download files (byte ranges), zip a selection or a folder (`/usr/bin/zip`, 4 GB before compression, 200,000 files), new folder, rename files and folders, move to the macOS Trash, name search (4 levels, 500 results, 2 s), copy path, and preview (images, video, audio, PDF, and the first 200 KB of text; HTML shows as text; previews are sandboxed).

Trash uses macOS’s native Trash operation. Restore items in Finder on the Mac. Files does not permanently delete, restore from its own interface, move or copy between folders, or search file contents.

### Messages

Messages is a chat between this Mac, your own devices, and the people you invite. Use it to move text, screenshots, videos, and files between them.

- **Who takes part.** The Mac (the Messages panel on the Admin page), every logged-in owner device, and every collaborator and guest session, in all roles. A Viewer can read and send in Messages even though its Files access is read-only.
- **Chats.** **Everyone** is the group chat. Each person also has a direct chat that only the two of you can see. Collaborators and guests see group messages from the moment their grant was created, never other people's direct chats, and only display names (no device codes or addresses).
- **Messages.** Bubbles show the sender's name in the group, with a tag for collaborators and guests, and the time. Images show as thumbnails (a 480 px JPEG made with `sips`) and open full size when tapped. Videos and audio play in the page. Other files show as a card with a download button.
- **Actions.** Long-press a message, right-click it, or use its **⋯** button for **Copy**, **Download**, **Delete for everyone**, or **Hide for me**. The sender and owner devices or the Mac can delete a message for everyone, which also deletes its files. Anyone else can hide it for themselves.
- **New messages.** A toast appears in any other view, and the Messages button shows the unread count. A phone that was offline gets what it missed when it reconnects. Notifications while the phone is locked need https and a service worker, so they wait for the domain.
- **No clipboard access.** Pocket Dev never reads or writes the system clipboard. **Copy** runs only when you tap it, on your own device.

| Route | Largest file | Why |
| --- | --- | --- |
| Same Wi-Fi | No limit | Uploads stream to disk, so file size does not use memory. |
| Internet (Cloudflare Tunnel) | 100 MB | Cloudflare's free plan rejects larger uploads. The page checks the size before it uploads. |
| Either, while the Mac has less than `messagesReserveGB` free (default 5 GB) | 50 MB | Large files wait until there is space. Text and smaller files still work, down to 500 MB free. |

Messages are saved in `~/.pocket-dev/messages/` (`messages.jsonl`, and attachments in `files/`), with files mode 0600 and folders 0700. They stay until someone deletes them. The Admin page shows the storage used, with **Clear** for each chat and **Clear all**.

From the Mac's terminal, `pocket-dev message` sends as the Mac:

```sh
pocket-dev message "build finished"
pocket-dev message "logs for you" --to Pixel --file ~/Desktop/server.log
pbpaste | pocket-dev message
```

`--to` takes a name or a device code. Text comes from the argument or from piped stdin. To send the clipboard with one key, make a macOS Shortcuts shortcut with a **Run Shell Script** action that runs `pbpaste | pocket-dev message`, and give it a keyboard shortcut.

### Open apps

Lists regular apps (the same set as the Force Quit window) with memory and CPU summed over each app's process tree, frontmost first, refreshed every 10 s. Shows each app's windows and document paths. **Quit** sends a normal quit and waits 8 s. **Force quit** sends SIGTERM, then SIGKILL after 3 s.

It does not quit protected apps (Finder, Dock, SystemUIServer, loginwindow, WindowServer, ControlCenter, NotificationCenter, Spotlight, and the app Pocket Dev runs inside), list windows on other Spaces, open apps, or move windows.

### Mac health

**Settings → Mac health**, or a tap on the strip at the top of any screen, opens one panel with a verdict (**Healthy**, **Worth a look**, **Needs attention**) and the readings behind it, refreshed every 10 s while open:

- **Battery:** charge, time left or to full, condition (full-charge capacity as a percent of the original, from `AppleRawMaxCapacity` over `DesignCapacity`), and charge cycles against the rated life.
- **Temperature:** battery temperature and macOS thermal state, with your alert limits.
- **Performance:** processor use (from `top`, sampled twice because the first sample averages since boot), memory free (from `memory_pressure`, because used memory alone misleads while macOS caches), memory used, and free disk space.
- **Staying awake:** the Keep awake mode, whether the Mac is staying awake now, and the lid.
- **This Mac and Pocket Dev:** name, uptime, network address, version, Node.

The verdict reuses the battery and heat alert rules and adds: battery worn below 80% of its original capacity, processor at 90% or more, memory under 10% free (red under 5%), and disk under 10 GB (red under 3 GB). A reading the Mac cannot give shows **No reading** and never counts as healthy or as a problem. `GET /api/health` needs a login and is on the phone listener only.

### Battery, temperature, and alerts

A strip at the top of every phone screen shows the Mac's battery (with ⚡ when plugged in) and temperature, refreshed every 30 s. The temperature is the battery's, in °C, plus macOS's thermal pressure (warm, hot, very hot) when it is above normal. A Mac cannot report its chip temperature to a normal user without `sudo` (`powermetrics`) or a third-party tool, so Pocket Dev does not show one.

An amber or red banner appears under the strip, and the phone vibrates once, when:

- the battery is at or below `batteryAlertPercent` (default 20) and not charging; red at 10% or less. The text says you could lose open work.
- the battery temperature reaches `temperatureAlertC` (default 40 °C; red 5 °C above), or macOS thermal pressure is serious or critical. **Open apps** on that banner helps close heavy apps.

**Dismiss** hides a banner for 15 minutes, or until it gets worse. The page title gets a ⚠ while a condition lasts. Alerts show only while the Pocket Dev page is open on the phone: a closed page cannot be reached without https and push notifications, which are on the roadmap.

### Mac screen

Settings → **Mac screen** shows a picture of the Mac's main display: **Refresh** takes a new one, **Auto** refreshes every 3 s, **Zoom** enlarges it to scroll around. It is read-only (no clicks or typing reach the Mac) and needs a logged-in phone. Each picture is a JPEG at most 1,600 px on its longest side, taken with `screencapture`, shrunk with `sips`, sent, and deleted; nothing is kept on disk. Turn it off with `pocket-dev config set screenView false`.

It needs **Screen Recording** for the program that runs Pocket Dev. Without it the picture shows only the wallpaper. The Admin page's Permissions panel shows whether it is allowed and opens the right System Settings page. The check looks for titled windows from other apps, because macOS hides those titles until Screen Recording is allowed; with no other window open it reports Unknown.

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

**Collaborators:** Admin and phone Settings include a Collaborators section for one-repository access, optional related folders, 1-hour/1-day/7-day expiry, QR invitations, native sharing, WhatsApp sharing, editing access and revocation. First enable sharing from Mac Admin, explicitly selecting your own trusted devices as Admin. Other devices need review, subsequent password logins require Mac approval, and Admin pairing stays on the Mac. Invitations work once within 10 minutes; opening a link preview never accepts one, and admission never evicts an Admin.

Viewer can preview and download scoped files. Developer can change a separate project copy and explicitly writable copies of related folders; the owner's live checkout stays unchanged. Common credentials, Git metadata, dependencies and symlinks are excluded from copies. Review shared contents for project-specific secrets. Guest sessions cannot access owner chats, terminals, settings, apps, screen, power or other repositories. **Collaborator AI is currently unavailable** until an isolated execution runner and authentication are implemented and validated. The current file-sharing foundation does not complete the scoped-AI feature. See [implementation status and remaining plan](docs/ROLE_ACCESS_PLAN.md).

| Feature | What it does |
| --- | --- |
| Password | scrypt hash (N=16384, r=8, p=1) in `config.json` as `passwordHash`. A random 12-character password is printed on the first start only. A plaintext `password` key is converted at start. Wrong passwords wait 1 s. New passwords need 6 to 200 characters. |
| QR sharing and login | The Admin page's **Share & login** section has **Show share QR** (a reusable address, password and approval still required) and **Show login QR** (one-time login, 10 minutes, skips approval), with copyable links. Phones must be on the same Wi-Fi. Login keys are kept in memory and are also printed at start or by `npm run qr`. Only the Mac can mint keys (loopback, no proxy headers, secret from `~/.pocket-dev/local-secret`). |
| Devices | Each login is a device in `~/.pocket-dev/devices.json` (sha256 of the cookie, never the cookie). Rename, log out, online now (open terminal or a request in the last 60 s). |
| Device limit | `maxDevices`, default 2, 1 to 20. Password logins stop at the limit. A QR login evicts the least recently used device. |
| Rate limit | 10 wrong passwords per IP in 15 minutes locks that IP for 15 minutes. The Admin page warns at 5 failures in an hour. |
| Cookie | `pd_token`, HttpOnly, SameSite=Strict, 1 year. No `Secure` flag, because the transport is http. |
| CSRF | Every POST, PUT, PATCH, and DELETE needs `x-pocket-dev: 1`. JSON bodies need `content-type: application/json`. WebSocket upgrades check `Origin`. |
| Approve, block, lockdown, security log | `requireApproval` makes password logins wait up to 10 minutes for approval on the Mac, with a 4-character code to compare. Blocked devices are refused on every route, across restarts. Lockdown logs out every non-blocked device, stops forwards, voids QR keys, disconnects phone access, and optionally closes terminals or sets a new password. Only the Mac can reconnect phone access. Events go to `~/.pocket-dev/security.log` (JSONL, mode 0600, rotated at 1 MB to `security.log.1`). |
| Admin page | `http://localhost:7778` (`adminPort`, default phone port + 1), bound to 127.0.0.1 and ::1, with a Host allowlist, Origin and proxy-header refusal, and an `x-pocket-admin: 1` header on writes. It has no password, because only a process on the Mac can reach it. Sections: Connection, Share & login (share QR, one-time login QR, copy links), Waiting, Devices (rename, log out, block, unblock), Security log (latest 200, filters), Password (no old password needed), Settings (device limit, approval, addresses), Live (close terminals, stop forwards and active chats, read-only Power and Open apps status), Service (install, Start automatically, stop), Lockdown. |
| Connect and Disconnect | Disconnect closes port 7777 and all forwards. Terminals keep running and devices stay logged in. A phone can disconnect, only the Mac can connect. With **Keep connection open** off, access closes about 30 s after the last Admin page closes (10 s heartbeat) and a restart starts disconnected. Saved as `access` in `config.json`. |
| Start automatically | `launchctl enable` or `disable` for `dev.pocket.server`, from the Admin page, the phone, or `npm run autostart`. Does not stop the running server. |

## Requirements

- macOS. Tested on macOS 14.5.
- Node.js 22.
- Xcode Command Line Tools (`xcode-select --install`), to build `node-pty`.
- Optional: `claude` (Claude Code), `codex`, and `gh` (GitHub CLI, logged in with `gh auth login`). Features that need a missing tool show an error.
- Terminal scripts and styles are bundled locally; opening Pocket Dev does not require internet access on the phone.

## Install as a command

Build a tarball and install it globally. Nothing is published to the npm registry.

```sh
npm pack
npm install -g ./pocket-dev-1.0.0.tgz
pocket-dev start
```

Or run `npm link` in this folder to use your working copy as `pocket-dev`.

| Command | What it does |
| --- | --- |
| `pocket-dev start [--port N] [--admin-port N] [--no-open]` | Run the server in this terminal. The flags override `config.json` for this run. |
| `pocket-dev config list` | Show every setting and the file it is saved in. The password hash shows as `<set>`. |
| `pocket-dev config get <key>` | Show one setting. |
| `pocket-dev config set <key> <value>` | Change a setting. The value is checked first, and a bad value changes nothing. |
| `pocket-dev config unset <key>` | Go back to the default. |
| `pocket-dev config path` | Print the config file path. |
| `pocket-dev service install\|restart\|uninstall\|status\|logs` | Run it in the background (launchd), or manage that. |
| `pocket-dev service autostart on\|off\|status` | Start at login or not. |
| `pocket-dev qr`, `admin`, `connect`, `disconnect`, `awake` | The same as the `npm run` commands below. |
| `pocket-dev message [text] [--to NAME] [--file PATH]` | Send to Messages as the Mac. Text comes from the argument or piped stdin. |

`config set` accepts `port`, `adminPort`, `awake`, `requireApproval`, `maxDevices`, `chatIdleMinutes`, `batteryAlertPercent`, `temperatureAlertC`, `screenView`, `allowedHosts` (comma separated), and `messagesReserveGB`. Run `pocket-dev help` for the ranges. `port` and `adminPort` apply after a restart (`pocket-dev service restart`); the rest apply right away. Change the password on the Admin page (`pocket-dev admin`).

The config file is `~/.pocket-dev/config.json` (mode 0600). A `config.json` left in the package folder by an older version moves there on the first run, and the old file stays as `config.json.migrated`.

## Install and run from the repository

```sh
npm install
npm start
```

`postinstall` marks node-pty's `spawn-helper` as executable, because node-pty 1.1.0 ships it without the execute bit.

The first start writes `~/.pocket-dev/config.json` (mode 0600) and prints the password once, a login QR code, and the URL.

| Command | What it does |
| --- | --- |
| `npm start` | Run the server in the foreground. |
| `npm run qr` | Print a fresh login QR code and URL from the running server. |
| `npm run admin` | Open the Mac-only Admin page. |
| `npm run connect`, `npm run disconnect` | Turn phone access on or off. |
| `npm run autostart -- on\|off\|status` | Turn the launchd agent's start at login on or off, or show it. |
| `npm run service:install` | Install or restart the launchd agent `dev.pocket.server` (`--force` if the port is busy). |
| `npm run service:uninstall` | Stop and remove the launchd agent. |
| Settings → Restart / Update (phone), Service → Update now (Admin) | Restart the background service so it loads the latest code. The button says **Update** when a source file on disk is newer than the running server. Works only for the launchd service; a copy started with `npm start` refuses. Back in about 15 s, devices stay logged in, terminals end. |
| `npm run service:status` | Show job state, URL, caffeinate assertions, and the last 20 log lines. |
| `npm run service:logs` | Follow `~/Library/Logs/pocket-dev.log`. |
| `npm run awake -- on\|plugged\|off\|status` | Set or show the Keep awake mode (`on` is `always`). |
| `npm run lid -- on\|off\|status` | Set or show lid-closed sleep with `sudo pmset -a disablesleep`. Refused while the lid is closed. |
| `npm run sleep` | Turn lid sleep back on (sudo) and sleep the Mac. |
| `npm run shutdown [-- --force]` | Shut down through System Events, or with `--force` through `sudo shutdown -h now`. |

The launchd agent writes `~/Library/LaunchAgents/dev.pocket.server.plist`, starts at login (not at boot), restarts within about 10 s after a crash, and logs to `~/Library/Logs/pocket-dev.log`. Terminals in the separate terminal host keep running across server restarts; terminals created by an older server or while the host is unavailable end on restart. Working chat turns are interrupted, and devices stay logged in. **Stop Pocket Dev** ends terminals as well as the server.

## Configuration

`config.json` lives in `~/.pocket-dev/` (or `POCKET_DEV_STATE_DIR`, or exactly at `POCKET_DEV_CONFIG`). Edit it by hand or with `pocket-dev config`. Pocket Dev rereads it at use, and app changes write back only the changed key, so you can edit it while the server runs.

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
| `batteryAlertPercent` | `20` | Alert when the Mac battery is at or below this percent and not charging, 5 to 90. |
| `temperatureAlertC` | `40` | Alert when the battery temperature reaches this many °C, 30 to 70. |
| `messagesReserveGB` | `5` | While the Mac has less free space than this, Messages files over 50 MB wait. 0 to 1000. |
| `screenView` | `true` | Whether a logged-in phone may see the Mac's screen. `false` refuses with 403. |
| `requireApproval` | `false` | New devices wait for approval on the Mac. |
| `fileRoots` | home folder | Folders Files may show. |
| `fileUploadMax` | 2 GiB | Files upload limit in bytes. |
| `fileZipMax` | 4 GiB | Zip limit in bytes, before compression. |
| `adminPort` | phone port + 1 (`7778`) | Admin page port. `POCKET_DEV_ADMIN_PORT` overrides it. |
| `access` | `{"connected": true, "keepOpen": true}` | Phone access and Keep connection open. |

Environment variables: `PORT`, `POCKET_DEV_CONFIG`, `POCKET_DEV_PASSWORD` (overrides the stored password and is printed at start), `POCKET_DEV_REPO_ROOTS`, `POCKET_DEV_STATE_DIR` (instead of `~/.pocket-dev` for authentication, security logs, Admin metadata, and chats), `POCKET_DEV_CHAT_DIR` (an explicit chat-storage override), `POCKET_DEV_ADMIN_PORT`, and `POCKET_DEV_NO_OPEN` (do not open the Admin page at start).

Codex Chat uses the daemon socket at `$CODEX_HOME/app-server-control/app-server-control.sock` (`CODEX_HOME` defaults to `~/.codex`). `POCKET_DEV_CODEX_SOCKET` selects a different local socket. `POCKET_DEV_CODEX` selects a binary and uses a private stdio server unless a socket override is also supplied.

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

The Admin page has a **Permissions** panel that shows each of these as Allowed, Not allowed, Waiting for you, or Not needed, plus whether `claude`, `codex`, and `gh` are ready. The first time you open the Admin page, a setup walks through the missing ones one at a time and every step can be skipped. **Run setup** repeats it, and **Check again** re-checks (it also re-checks when you return to the tab from System Settings). Control System Events is the only one macOS can prompt for; for the others the button opens the right System Settings page. Checking Control System Events can make macOS show its pop-up on the Mac. The panel is on the Admin page only, never on the phone listener.

macOS grants TCC permissions to the app that started `node`: Terminal or VS Code for `npm start`, `node` for the launchd agent.

## Security model

- Same Wi-Fi only, plain http. Anyone who can read the Wi-Fi traffic can see the cookie and terminal contents. Use a trusted network.
- Port 7777 listens on all interfaces (`0.0.0.0`). Forwarded ports listen on the LAN IP and have no password.
- A logged-in device has the full rights of your user: shell, files, and your Claude, Codex, and GitHub logins (limited by the credentials and permissions you have configured).
- Protections: hashed password and cookies, one-time QR keys only from the Mac, device limit, SameSite=Strict HttpOnly cookie, the `x-pocket-dev` header and JSON content-type for every change, WebSocket `Origin` check, a Git repository allowlist, path checks after symlink resolution in Files, and sandboxed previews. Messages attachments are typed by their first bytes, not their name: only PNG, JPEG, GIF, WebP, MP4, WebM, MOV, MP3, M4A, Ogg and WAV display in the page, and everything else, SVG and HTML included, downloads. Every attachment response has `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, and a file is reachable only by someone who can see its message.
- The Admin page on 127.0.0.1:7778 has a Host allowlist, so it resists DNS rebinding. It has no password, so any local process can use it.
- Not protected: traffic sniffing on the LAN, forwarded ports, an unlocked logged-in phone, local processes on the Mac, or a malicious program on the Mac. Both the phone and Admin listeners check Host headers; `allowedHosts` can add a tunnel hostname.

## Limitations

- No internet access, no https, no passkeys yet.
- Terminals and port forwards do not survive a restart.
- Old uploads in `~/.pocket-dev/uploads` are never deleted.
- The Git view does not stage, commit, pull, or switch branches.
- Agent services such as Claude and Codex still need internet access on the Mac.
- Pocket Dev cannot wake or power on the Mac.

## Tests

Run `npm test` on macOS. The suite starts disposable phone and Admin listeners, uses fixture folders and stubbed power commands, and exercises authentication, Host/Origin/CSRF checks, Unicode terminals, chat persistence, Files, blocked and pending devices, and lockdown. It makes no model calls and does not install a service or quit user apps.

## Roadmap

- A domain and Cloudflare Tunnel for access from anywhere.
- https through the tunnel.
- Passkeys and fingerprint login on the phone.
- An Android share target to send screenshots and files into Pocket Dev.
