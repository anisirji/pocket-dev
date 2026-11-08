# Pocket Dev

Control your Mac from your phone's browser on the same Wi-Fi, or optionally from anywhere: terminals, Claude Code and Codex chats, Git and GitHub pull requests, files, open apps, and power.

Pocket Dev is one Node.js server that runs on the Mac as your user. The phone opens `http://<mac-lan-ip>:7777`, logs in with a password or a one-time QR code, and gets a mobile web app. Nothing is installed on the phone. [Internet access](#connect-over-the-internet-optional) is optional and off by default.

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

It does not protect forwarded ports with a password, persist forwards across restarts, forward ports below 1024, or forward Pocket Dev's own ports (the phone port and the Admin port, which only this Mac may open).

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

Lists the 30 most recent Claude Code and Codex conversations from `~/.claude/projects` and `~/.codex`, filtered by **All**, **Claude**, or **Codex**. Shows the latest 20 messages. **Continue in terminal** opens a terminal in the conversation's folder and types `claude --resume <id>` or `codex resume <id>`. Resume reads the history files. The selected engine writes its normal history when you continue. Codex Chat reuses the local daemon when available.

#### Take over a conversation that is open somewhere else

A conversation has one writer at a time, because every copy appends to the same history file. Two writers corrupt it. A conversation is open when one of these has it:

- A Claude Code or Codex program on the Mac whose command line names it (`claude --resume <id>`, `claude -r <id>`, `--resume=<id>` from the VS Code extension, `codex resume <id>`).
- A Claude Code session whose `~/.claude/sessions/<pid>.json` names it. This finds a plain `claude` or a new VS Code tab.
- A Pocket Dev terminal running one of those programs, or a Pocket Dev chat whose engine is awake.

Only `claude`, `codex`, or `node` running their CLI script count, owned by your user. `grep`, `tail`, editors, and shells that mention the id never count. Pocket Dev itself and the programs it runs under never count either.

The list marks such a conversation **open on Mac** or **open in Pocket Dev**. When only its file changed in the last 2 minutes, the mark is **open on Mac?**. Its detail shows **Open on your Mac** with the program, and the buttons become **Take over and continue in terminal** and **Take over and continue in chat**.

Take over asks first. If the file changed in the last 10 seconds, or Claude reports the session busy, it asks again: "Claude is still working on the Mac. Taking over stops that reply." It then closes the other copy and continues:

- A program on the Mac gets SIGINT, then SIGTERM after 5 seconds, then 5 more seconds to exit. Pocket Dev rechecks each process before it signals it, so a reused pid is never signalled.
- A Pocket Dev terminal ends its shell and keeps the tab, which shows why it ended. A Pocket Dev chat stops its engine, holds any waiting messages, and shows why.
- The phone continues only after every copy has exited. The toast names what closed.

If a program ignores both signals, the sheet says so and offers **Force quit and continue**, which sends SIGKILL after a warning. If the conversation is live but no program can be found, the sheet says "Couldn't find the program that has this conversation open. Close it on the Mac, then try again." It also offers **Continue anyway**, with a warning. Every take over, and every failed one, goes in the security log with the tool, the conversation id, the pids, and the device. The route is `POST /api/history/<tool>/<id>/takeover` with `{ force?, confirmBusy? }`. It answers `{ stopped, busy }`, or 409 with a `code` of `busy`, `not-found`, or `still-running`. Collaborators can't use it.

Codex conversations open in the VS Code Codex extension can't be identified, because its `codex app-server` command line has no conversation id. Close those on the Mac first.

#### Move a phone conversation to the Mac

Run `pocket-dev takeover <id>` in a Mac terminal, or `pocket-dev takeover --last` for the conversation most recently active in Pocket Dev. The command asks the running server to close Pocket Dev's copy. The phone's terminal or chat then shows "Continued on your Mac". Next, the command checks that no other program has the conversation open. Last, it runs `claude --resume <id>` or `codex resume <id>` in the conversation's folder. The Admin page's **Open in Pocket Dev** list shows each conversation open in a Pocket Dev terminal or chat, with the exact command.

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
| QR sharing and login | The Admin page's **Share & login** section has **Show share QR** (a reusable address, password and approval still required) and **Show login QR** (one-time login, 10 minutes, skips approval), with copyable links. Codes use the Wi-Fi address, or the internet link when one is up. Login keys are kept in memory and are also printed at start or by `npm run qr`. Only the Mac can mint keys (loopback, no proxy headers, secret from `~/.pocket-dev/local-secret`). |
| Devices | Each login is a device in `~/.pocket-dev/devices.json` (sha256 of each cookie, never the cookie). A device holds one cookie per address it has used, up to eight, and counts once. Rename, log out, online now (open terminal or a request in the last 60 s). |
| Device limit | `maxDevices`, default 2, 1 to 20. Password logins stop at the limit. A QR login evicts the least recently used device. |
| Rate limit | 10 wrong passwords per IP in 15 minutes locks that IP for 15 minutes. The Admin page warns at 5 failures in an hour. |
| Cookie | `pd_token`, HttpOnly, SameSite=Strict, 1 year. `Secure` on the internet link; not on Wi-Fi, where the transport is http. Each cookie works only on the address it was issued for: a Wi-Fi cookie is no login on the internet address, and the other way round. |
| CSRF | Every POST, PUT, PATCH, and DELETE needs `x-pocket-dev: 1`. JSON bodies need `content-type: application/json`. WebSocket upgrades check `Origin`. |
| Approve, block, lockdown, security log | `requireApproval` makes password logins wait up to 10 minutes for approval on the Mac, with a 4-character code to compare. `approveFromDevices` (default off; only the Mac turns it on, a phone can turn it off) also lets a logged-in owner phone see who is waiting under Settings → Devices and approve or deny with the same code check, and pushes "Someone is waiting to log in" to the owner's open pages. A logged-in owner phone already has full shell access, so letting it approve logins adds no power it did not have; if that phone is lost, log it out from the Mac or run lockdown. With role-based sharing on, only Admin devices approve, and collaborator invitations can already be sent from a logged-in owner phone. Blocked devices are refused on every route, across restarts. Lockdown logs out every non-blocked device, stops forwards, voids QR keys, disconnects phone access, and optionally closes terminals or sets a new password. Only the Mac can reconnect phone access. Events go to `~/.pocket-dev/security.log` (JSONL, mode 0600, rotated at 1 MB to `security.log.1`). |
| Admin page | `http://localhost:7778` (`adminPort`, default phone port + 1), bound to 127.0.0.1 and ::1, with a Host allowlist, Origin and proxy-header refusal, and an `x-pocket-admin: 1` header on writes. It has no password, because only a process on the Mac can reach it. Sections: Connection, Internet access (Off, Quick link, My own domain, Wi-Fi access), Share & login (share QR, one-time login QR, copy links), Waiting, Devices (rename, log out, block, unblock), Security log (latest 200, filters), Password (no old password needed), Settings (device limit, approval, approve from a logged-in phone, addresses), Live (close terminals, stop forwards and active chats, read-only Power and Open apps status), Service (install, Start automatically, stop), Lockdown. |
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
| `pocket-dev takeover <id>\|--last` | Close Pocket Dev's copy of a conversation, then continue it in this terminal with `claude --resume` or `codex resume`. `--last` picks the conversation most recently active in Pocket Dev. |
| `pocket-dev internet status\|off\|quick` | Show internet access and the link's status, turn it off, or allow a Quick link. |
| `pocket-dev internet domain --hostname <host> --token-stdin` | Use your own domain through a Cloudflare tunnel. The token comes from stdin, or from a file with `--token-file <path>`, never as an argument. See [Connect over the internet](#connect-over-the-internet-optional). |
| `pocket-dev qr`, `admin`, `connect`, `disconnect`, `awake` | The same as the `npm run` commands below. |
| `pocket-dev message [text] [--to NAME] [--file PATH]` | Send to Messages as the Mac. Text comes from the argument or piped stdin. |

`config set` accepts `port`, `adminPort`, `awake`, `requireApproval`, `approveFromDevices`, `maxDevices`, `chatIdleMinutes`, `batteryAlertPercent`, `temperatureAlertC`, `screenView`, and `allowedHosts` (comma separated), and `messagesReserveGB`. Run `pocket-dev help` for the ranges. `port` and `adminPort` apply after a restart (`pocket-dev service restart`); the rest apply right away. Change the password on the Admin page (`pocket-dev admin`).

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

## Connect over the internet (optional)

Pocket Dev works on your Wi-Fi with none of this. Internet access adds a second address through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) that `cloudflared` on the Mac opens outward, so the router needs no port forwarding and the phone gets https. Only the Mac can turn it on, from the Admin page's **Internet access** section or `pocket-dev internet`; a phone can only turn it off. Both addresses work at the same time, and a phone on the same Wi-Fi can switch between them.

Install the connector once: `brew install cloudflared`. Then choose one of three:

| Choice | Needs | What you get |
| --- | --- | --- |
| **Off** (default) | nothing | Wi-Fi only, exactly as before. |
| **Quick link** | `cloudflared` | **Turn on** gives a random `https://….trycloudflare.com` address that lasts until you turn it off or Pocket Dev restarts. No account. A restart never publishes it on its own. |
| **My own domain** | `cloudflared`, a free Cloudflare account, a domain on Cloudflare DNS | A fixed `https://pocket.example.com` that comes up with phone access and stays. |

Setting up your own domain:

1. In the Cloudflare dashboard open Zero Trust → Networks → Tunnels → **Create a tunnel** → **Cloudflared**, and name it.
2. From the install command it shows, copy only the token (the long code after `--token`). Do not run that command; Pocket Dev runs `cloudflared` for you.
3. Add a public hostname, such as `pocket.example.com`, pointing to **HTTP** `localhost:7777` (your phone port). The domain must use Cloudflare DNS.
4. Turn on **Always Use HTTPS** for the domain (SSL/TLS → Edge Certificates), so a phone that types the address without `https://` is sent there by Cloudflare before anything reaches the Mac.
5. On the Admin page choose **My own domain**, paste the hostname and the token, and press **Save and connect**. The page shows connecting, connected with an **Open** link, or `cloudflared`'s error. From the terminal: `pbpaste | pocket-dev internet domain --hostname pocket.example.com --token-stdin`.

Each address has its own login cookie, so a phone that first opens the internet address meets the password page, and with **Approve new devices** on it would wait for approval on the Mac, which is no use when you are away. Link the phone while it is at home instead: on Wi-Fi, the phone shows "Link this phone to pocket.example.com so you won't need to log in when you're away", and **Settings → Connection** has the same **Link this phone** button. Linking gives the same device a cookie for the internet address, then returns to Wi-Fi. A Quick link is a new address on every **Turn on**, so each phone links again each time; your own domain keeps one address, so the link is needed once per device. The other way round also works: scan the QR code on the internet address once (the codes point there when the link is up), then use **Switch to local** on Wi-Fi.

Afterwards **Settings → Connection** shows both addresses with **Switch to local** and **Switch to remote**. When the phone is on the internet address but on the Mac's own network, a small prompt offers the local route; **Not now** is remembered for that network. When the Wi-Fi address stops answering for about five seconds, the phone offers the internet link. Nothing switches by itself. The open terminal or chat follows the switch. **Turn off internet access** in the same section works from either address; from the internet address the phone switches itself to Wi-Fi first, with its login, because its internet cookie opens nothing there.

**Wi-Fi access** can be turned off on the Admin page once internet access is on. Pocket Dev then listens on the Mac itself only, so the phone reaches it through the tunnel alone, and port forwards are refused, since they would listen on the Wi-Fi address. It applies after a restart and is refused while internet access is off, because nothing could reach Pocket Dev.

Security notes:

- The tunnel token is a secret. It is kept in `~/.pocket-dev/tunnel-token` (mode 0600), given to `cloudflared` through the `TUNNEL_TOKEN` environment variable rather than on its command line, and never appears in a response or a log. The Admin page and the CLI report only whether one is saved. Turning internet access off keeps the file for next time; delete it to forget the token.
- The internet address is a login page like any other: the password, approval and the device limit apply. Anyone who knows a Quick link can reach that page, so turn it off when done.
- Through the tunnel the browser talks https to Cloudflare, and Cloudflare's connector on the Mac talks to Pocket Dev over loopback. Cloudflare can read that traffic. Terminals and files are only as private as that path.
- The internet hostname is served over https only. A request that names it without coming through the connector on https, such as a plain-http visit relayed by Cloudflare or a LAN client choosing that Host header, gets a redirect to `https://` and nothing else: no page, no login, no cookie. Responses through the link carry `Strict-Transport-Security` for a year, so a browser that has visited once never tries plain http again.
- The cookie set on the internet address is `Secure`. Each cookie works only on the address it was issued for, so a Wi-Fi cookie read off the network opens nothing on the internet address; a phone gets its internet cookie by linking from Wi-Fi or by logging in there. A device switching between addresses stays one device, so revoking, blocking or lockdown ends all of its cookies at once. Phones that logged in over the internet before this rule must log in there, or link from Wi-Fi, once more.
- Switching to local and linking both use a handoff token minted when you tap: random, kept as a hash, 60 seconds, one use, bound to one direction and one host. A Switch to local token is accepted only on the Mac's Wi-Fi address or `.local` name; a Link token only through the tunnel on the hostname it was minted for. A token used on the wrong side, or for a Quick link address that has since changed, is refused and spent. A handoff never waits for approval, never counts as a new device and never evicts one: it gives the device it was minted for one more cookie with its existing status and role. A browser that redeems one while holding another device's cookie for that address is one phone with two entries, from a password login there; the duplicate is logged out and folded into the switching device, and the security log records `device-merged` with both ids. A blocked duplicate still refuses the switch. A password login from a device that is new still follows **Approve new devices**.
- The same-network hint comes from the server comparing the phone's public address with the Mac's (IPv6 by /64, IPv4 against the Mac's public address from `https://1.1.1.1/cdn-cgi/trace`). It only offers the switch, and unknown is never reported as a match. No lookup happens while internet access is off.

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
| `approveFromDevices` | `false` | A logged-in owner phone may approve or deny waiting logins. Only the Mac turns it on. |
| `fileRoots` | home folder | Folders Files may show. |
| `fileUploadMax` | 2 GiB | Files upload limit in bytes. |
| `fileZipMax` | 4 GiB | Zip limit in bytes, before compression. |
| `adminPort` | phone port + 1 (`7778`) | Admin page port. `POCKET_DEV_ADMIN_PORT` overrides it. |
| `access` | `{"connected": true, "keepOpen": true}` | Phone access and Keep connection open. |
| `network` | `{"wifi": true, "internet": {"kind": "off"}}` | Wi-Fi access and the kind of [internet access](#connect-over-the-internet-optional): `off`, `quick`, or `domain` with a `hostname`. A missing or unusable value means Wi-Fi only with internet off. `wifi: false` applies after a restart and is refused while internet is off. |

Environment variables: `PORT`, `POCKET_DEV_CONFIG`, `POCKET_DEV_PASSWORD` (overrides the stored password and is printed at start), `POCKET_DEV_REPO_ROOTS`, `POCKET_DEV_STATE_DIR` (instead of `~/.pocket-dev` for authentication, security logs, Admin metadata, the tunnel token, and chats), `POCKET_DEV_CHAT_DIR` (an explicit chat-storage override), `POCKET_DEV_ADMIN_PORT`, `POCKET_DEV_NO_OPEN` (do not open the Admin page at start), and `POCKET_DEV_CLOUDFLARED` (the `cloudflared` executable; otherwise `/opt/homebrew/bin/cloudflared`, then `/usr/local/bin/cloudflared`).

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

- On Wi-Fi, plain http. Anyone who can read the Wi-Fi traffic can see the cookie and terminal contents. Use a trusted network. Through the optional internet link the phone talks https to Cloudflare, which can read the traffic it relays.
- Port 7777 listens on all interfaces (`0.0.0.0`), or on the Mac itself only with Wi-Fi access off. Forwarded ports listen on the LAN IP and have no password.
- A logged-in device has the full rights of your user: shell, files, and your Claude, Codex, and GitHub logins (limited by the credentials and permissions you have configured).
- Protections: hashed password and cookies, one-time QR keys only from the Mac, device limit, SameSite=Strict HttpOnly cookie, the `x-pocket-dev` header and JSON content-type for every change, WebSocket `Origin` check, a Git repository allowlist, path checks after symlink resolution in Files, and sandboxed previews. Messages attachments are typed by their first bytes, not their name: only PNG, JPEG, GIF, WebP, MP4, WebM, MOV, MP3, M4A, Ogg and WAV display in the page, and everything else, SVG and HTML included, downloads. Every attachment response has `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, and a file is reachable only by someone who can see its message.
- The Admin page on 127.0.0.1:7778 has a Host allowlist, so it resists DNS rebinding. It has no password, so any local process can use it.
- Not protected: traffic sniffing on the LAN, forwarded ports, an unlocked logged-in phone, local processes on the Mac, or a malicious program on the Mac. Both the phone and Admin listeners check Host headers; the tunnel's hostname is accepted on https, and `allowedHosts` can add others.

## Limitations

- No passkeys yet. Internet access needs `cloudflared` and, for a fixed address, a Cloudflare account and a domain on Cloudflare DNS.
- Terminals and port forwards do not survive a restart.
- Old uploads in `~/.pocket-dev/uploads` are never deleted.
- The Git view does not stage, commit, pull, or switch branches.
- Agent services such as Claude and Codex still need internet access on the Mac.
- Pocket Dev cannot wake or power on the Mac.

## Tests

Run `npm test` on macOS. The suite starts disposable phone and Admin listeners, uses fixture folders, stubbed power commands and a stand-in for `cloudflared`, and exercises authentication, Host/Origin/CSRF checks, Unicode terminals, chat persistence, Files, blocked and pending devices, lockdown, the tunnel kinds, the handoff and the connection hint. It makes no model calls, opens no real tunnel, and does not install a service or quit user apps.

## Roadmap

- Passkeys and fingerprint login on the phone.
- An Android share target to send screenshots and files into Pocket Dev.
