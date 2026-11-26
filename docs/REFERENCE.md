# Pocket Dev reference

The long reference material behind the [README](GUIDE.md): every feature in detail, the full command list, internet access, permissions and the login and security table. The README has the setup steps and a short tour.

Pocket Dev works on macOS, Windows 11 and Linux. Some details below name macOS tools (`launchd`, `pmset`, `caffeinate`, the Trash); on Windows and Linux the equivalent system tool is used, or the feature says "not available on this system".

## Terminal

| Feature | What it does | Does not |
| --- | --- | --- |
| Real terminals | Each tab is a login shell (`$SHELL -l`, zsh) in a pty on the Mac. A separate terminal host keeps shells and recent output through server updates and reconnects the same tabs afterwards. If the host is unavailable, the restart confirmation identifies terminals that will end. On phones, type in the command field and swipe the output to scroll. | Survive a Mac restart. Run as root. |
| Folder picker | **+** lists Home, pinned folders, the last 5 folders, and every folder in `~/Desktop` and `~/Desktop/Projects` with `.git` or `package.json`. **Browse folders** opens a directory browser with Home, Desktop, Documents, Downloads, external drives, breadcrumbs, Back, search and hidden folders. Select a folder without typing its path. | Scan deeper than one level for the project suggestions. |
| Tab names | Named after the folder (`app`, `app 2`). Resumed tabs are `claude · app` or `codex · app`. | |
| All terminals | **☰** next to **+** lists every terminal with its folder, running or exited, and when it last printed. Tap a row to jump to it, **✕** to close it. | |
| Input and key bar | **Send** types the input and then Enter 30 ms later. Empty **Send** sends Enter. One compact row has **Answer**, ↑ / ↓, **Enter**, and **More**. When Codex shows “⇧← to answer”, tap **Answer**, use ↑ / ↓ to choose, then **Enter**. **More** opens the remaining keys, shortcuts, and Copy; it closes after a choice. Terminal tabs hide while the phone keyboard is open and return when it closes. | |
| Scrolling | Touch scroll with fling, 5,000 lines on the phone. **↓ latest** jumps to the bottom. | |
| Reconnect | Terminals keep running when the phone sleeps. On reconnect, the server replays up to about 500 KB per terminal. Dead sockets are pinged out every 30 s. | |
| Shared terminals | Several pages can attach to one terminal. The page that types last sets the size. | Keep two different sizes at once. |
| Copy | **📋** shows the last 300 lines as selectable text with **Copy all**. Works on plain http. | |
| Upload | **📎** or paste an image. Saves to `~/.pocket-dev/uploads` (25 MB per file) and inserts the quoted path into the input. | Press Enter. Delete old uploads. |
| Shortcuts | **⚡** runs saved commands. Up to 30, each 1 to 200 characters, stored in `config.json`. | |

### Terminal API for scripts

A script or agent can drive a terminal with the same HTTP calls and WebSocket the phone uses. Every call goes to the phone address (`http://<Wi-Fi address>:7777`, or the internet link) and carries the login cookie.

1. Log in with `POST /api/login` and the JSON body `{ "password": "…", "name": "build-bot" }`. The `name` is optional, 1 to 40 characters on one line, and is what the approval list shows. The reply sets the `pd_token` cookie. A reply of `{ "ok": true, "pending": true }` means the login waits for approval; poll `GET /api/status` until `status` is `active`. The cookie works only on the address that issued it.
2. Create a terminal with `POST /api/sessions` and the body `{ "cwd": "/path/to/folder", "command": "npm test" }`. Both fields are optional. `cwd` defaults to the home folder and must be a folder. `command` is one line of 1 to 200 characters; the shell types it and presses Enter once its prompt is quiet. The reply is `201` with `{ id, title, cwd, exitCode, startedAt, activeAt, persistent }`.
3. Open the WebSocket `ws://<address>/ws/<id>` (`wss://` on the internet link) with the cookie. An `Origin` header, if sent, must match the address. A refused upgrade answers `401` (no login), `403` (wrong origin or a collaborator), `404` (no such terminal), or `503` (terminals are unavailable on this computer).
4. `GET /api/sessions` lists every terminal. `DELETE /api/sessions/<id>` closes one and answers `204`.

Every `POST`, `PUT`, `PATCH` and `DELETE` needs the header `x-pocket-dev: 1` and `content-type: application/json`.

Each WebSocket message is one JSON text frame.

| Direction | Frame | Meaning |
| --- | --- | --- |
| Server to client | `{ "t": "out", "d": "…" }` | Terminal output, with escape sequences as the shell printed them. The first frame after connecting replays up to about 500 KB of earlier output. |
| Server to client | `{ "t": "exit", "code": 0 }` | The shell ended. The socket stays open, and input is ignored. |
| Server to client | `{ "t": "pong" }` | The answer to a `ping` frame. |
| Server to client | `{ "t": "waiting", "kind": "…", "code": "1a2b" }` | A login is waiting for approval. Only owner devices hear this, and only with **Approve from a logged-in phone** on. Ignore it in a script. |
| Client to server | `{ "t": "in", "d": "ls\r" }` | Keystrokes. Send `\r` for Enter and `\u0003` for Ctrl-C. |
| Client to server | `{ "t": "resize", "cols": 120, "rows": 40 }` | The terminal size, each 10 to 500. The client that types last sets the size. |
| Client to server | `{ "t": "ping" }` | Asks for a `pong` frame. |

The server also sends a WebSocket ping every 30 seconds and closes a socket that does not answer. Most WebSocket libraries answer it on their own.

A minimal Node.js script with the `ws` package:

```js
import WebSocket from 'ws';
const base = 'http://192.168.1.20:7777';
const headers = { 'content-type': 'application/json', 'x-pocket-dev': '1' };
const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password: process.env.PD_PASSWORD, name: 'build-bot' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const session = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ cwd: '/Users/me/app' }) })).json();
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${session.id}`, { headers: { cookie } });
ws.on('open', () => ws.send(JSON.stringify({ t: 'in', d: 'npm test\r' })));
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'out') process.stdout.write(m.d); });
```


## Ports

Forward `localhost:<port>` on the Mac to `<mac-lan-ip>:<port>`, so the phone can open a dev server. It is a raw TCP pipe (127.0.0.1 first, then ::1), so HMR WebSockets work. When the Mac's LAN IP changes, every forward moves to the new IP within about 10 s.

It does not protect forwarded ports with a password on Wi-Fi, persist forwards across restarts, forward ports below 1024, or forward Pocket Dev's own ports (the phone port and the Admin port, which only this Mac may open).

### Ports from outside the home network

A phone on the internet address cannot reach the Wi-Fi link. There, tapping a port opens it through its own Quick link (`https://….trycloudflare.com`), behind the Pocket Dev login:

1. The phone asks `POST /api/forwards/<port>/remote`. Only a logged-in owner device can ask, only for a port that is forwarded, and only while internet access is on. Collaborators and room members cannot.
2. The first time, Pocket Dev starts a small gate on `127.0.0.1` and one `cloudflared` Quick link that points at the gate, never at the dev server. Each port gets its own address, so a dev server's root paths (`/assets/…`, `/@vite/client`) work.
3. The reply is a link with a one-time key that lasts 60 seconds. Opening it gives that browser a `pd_port` cookie (HttpOnly, Secure, SameSite=Lax, 12 hours) for that address only, and removes the key from the address bar. Lax lets an app's sign-in callback from another site still reach it.
4. The gate passes a request on to `localhost:<port>` only with that cookie, while the device that asked is still logged in and internet access is still on. Anyone else gets a 401 page and nothing reaches the dev server. WebSockets (hot reload) pass through the same check.
5. The dev server sees `Host: localhost:<port>`, so host checks such as Vite's pass. The tunnel's own headers and the gate cookie are removed; the app's own cookies pass.
6. Closing the forward, Lockdown, stopping Pocket Dev, or turning internet access off ends the Quick link. An open WebSocket is checked again every 5 seconds and closes once its device is logged out or blocked. If `cloudflared` for a port stops, the next tap starts a new Quick link.

Each opening is in the security log as `port-remote-opened`. It needs `cloudflared`, like a Quick link. A new Quick link can take a few seconds before its address answers.

## Git

| Feature | What it does | Does not |
| --- | --- | --- |
| Repo picker | Finds repositories up to two levels below `~/Desktop`, `~/Desktop/Projects`, and `~`, or below `repoRoots`. **Open folder…** opens any folder inside a repository with the folder picker. The server resolves symlinks, asks git for the top level, and saves that path in `gitRepos`. Git runs only in a scanned or saved top level, matched exactly. | Accept a subfolder, a `..` path or a symlink path in place of the saved top level. |
| Git graph button | On every Chat page (conversation header) and Terminal page (terminal tab bar). Opens the Graph for the chat's or terminal's starting folder, the same way as **Open folder…**. | Follow a later `cd` in the terminal. |
| Graph | Last 300 commits on all branches with lanes, **Load more**, branch and tag chips. | |
| Commit detail | Message, author, files with line counts, per-file diffs. Merge commits diff against the first parent. Diffs are cut at 3,000 lines. | |
| Changes | Branch, ahead and behind, staged, unstaged, and untracked files with diffs. **Commit** stages every change (`git add -A`), commits with your message, and can push (`git push`, or `git push -u origin <branch>` for a new branch). Pushing never forces. | Pull, or commit only some files. |
| Branches and stash | Switch to a local or remote branch, create a branch from a target, and stash, apply or drop stashes (stash includes untracked files). | |
| Pull requests | Up to 50 open PRs with review state and checks. Detail shows description, checks, files, diffs, reviews, and comments. | Show issues. |
| Review | Approve, request changes, or comment through `gh pr review`. | Approve your own PR (GitHub refuses). |
| Merge | Squash, merge commit, or rebase, with `--match-head-commit` so a newer push makes the merge fail. Optional **Delete branch** removes the branch on GitHub only. | Delete the local branch or a fork's branch. |
| Close and reopen | `gh pr close` and `gh pr reopen`. | Delete the branch. |
| Create PR | Head, base (default branch first), title, description, draft. Pushes first with `git push -u origin <branch>` when the branch is not on GitHub or has unpushed commits. | |

## Resume and continue

The **Chats** page is one list, newest first: Pocket Dev chats and recent Claude Code, Codex, Antigravity and Copilot conversations from the computer, ordered by their last activity. A computer conversation carries an **on computer** tag (**open on computer** or **in a terminal** while a program has it open). While more computer conversations are still unloaded, the list stops at the oldest loaded one, so nothing newer hides behind **Show more**; a chat that is running or waiting for you is always shown. There is no separate Resume menu entry. Tapping a computer row opens the same conversation in chat. A program on the computer that still has it open keeps running until you send a message from the chat or press **Stop**. Existing Pocket Dev sessions appear once, including sleeping chats and sessions from earlier provider switches. Search matches titles, projects, folders and providers. **Show more** loads 30 more computer conversations; the list reloads when it opens, when you return to the tab, when you press Refresh, and every 8 seconds while it is open, so a conversation you start on the computer appears on its own. The 8-second reload covers the first page only and pauses once you have loaded more; the 3-second active-chat status check still does not rescan computer history.

Only the owner's devices can read computer conversations. `GET /api/history/chats?limit=30&offset=0&q=...` returns `{ chats, computer, hasMore }`. `POST /api/history/<tool>/<id>/open-chat` with `{ force? }` returns `{ chat }`. When a program on the computer has the conversation open, idle or replying, opening signals nothing. The chat opens with `held` set to that program's name and `heldActivity` set to the step it is on, and shows what the program writes. A message you send waits in the queue. Pocket Dev then takes the conversation over as soon as the program is not replying, and sends the message. **Stop** takes over at once. If the program closes by itself, the hold ends and nothing is signalled. There is no confirmation step. Readable Claude, Codex and Copilot messages are imported into Pocket Dev's persisted conversation, including context for later provider switching. Continuing on the computer releases Pocket Dev's writer; opening that row again checks ownership and imports new native messages without replacing Pocket Dev history.

History comes from `~/.claude/projects`, `~/.codex`, `~/.gemini/antigravity-cli` and `~/.copilot/session-state`. Antigravity keeps each conversation in a protobuf SQLite format that is not read here. Its list comes from `conversation_summaries.db`: title, folder, step count and time. Chat shows a note when earlier text is unavailable. Pocket Dev reads a temporary copy of that database and never opens agy's own files for writing. Helper sub-conversations are excluded. `POCKET_DEV_AGY_DIR` selects a different folder. Reading that database requires Node.js 22.13 or newer. The selected engine writes its normal native history when you continue.

### Open a conversation that is open somewhere else

A conversation has one writer at a time, because every copy appends to the same history file. Two writers corrupt it. A conversation is open when one of these has it:

- A Claude Code or Codex program on the Mac whose command line names it (`claude --resume <id>`, `claude -r <id>`, `--resume=<id>` from the VS Code extension, `codex resume <id>`).
- A Claude Code session whose `~/.claude/sessions/<pid>.json` names it. This finds a plain `claude` or a new VS Code tab.
- A Pocket Dev terminal running one of those programs, or a Pocket Dev chat whose engine is awake.

Only `claude`, `codex`, or `node` running their CLI script count, owned by your user. `grep`, `tail`, editors, and shells that mention the id never count. Pocket Dev itself and the programs it runs under never count either.

The list marks such a conversation **open on Mac** or **open in Pocket Dev**. When only its file changed in the last 2 minutes, the mark is **open on Mac?**. Tap its row in **Chats**. The chat opens with no extra screen.

- A program on the Mac is left open, and the chat reads along. The status line says, for example, "Open in Claude Code in VS Code on your computer. You can read along here. Sending a message continues it here and closes it there." While the program replies, the status line shows its current step and **Stop**.
- Send a message to continue in the chat. Pocket Dev waits for any reply on the Mac to finish, closes the program, and sends your message. The chat then says that the program's window may show that the session ended. That is normal, and nothing is lost.
- A Pocket Dev terminal or chat that has the conversation is closed at once, unless it is replying. Then the chat reads along in the same way.

The take over route asks only when the other copy is in the middle of a reply (the file changed in the last 10 seconds, or Claude reports the session busy): "Claude is still replying on the Mac. Continuing stops that reply." Closing a copy works like this:

- An idle program on the Mac gets SIGINT, then SIGTERM after 2 seconds, then SIGKILL after 2 more seconds. SIGINT comes first because idle Claude Code exits cleanly on it (exit code 0). The VS Code extension shows SIGTERM's exit code 143 as an error.
- A program in the middle of a reply gets SIGINT, then SIGTERM after 5 seconds, then 5 more seconds to exit. Pocket Dev rechecks each process before it signals it, so a reused pid is never signalled.
- A Pocket Dev terminal ends its shell and keeps the tab, which shows why it ended. A Pocket Dev chat stops its engine, holds any waiting messages, and shows why.
- The phone continues only after every copy has exited. The toast names what closed.

If a program ignores both signals, opening the chat reports the failure and offers a retry. If its history is live but no program can be identified, close it on the computer first, then try again. The Chats list never force-quits a writer or bypasses this check automatically. Every release, and every failed one, goes in the security log with the tool, the conversation id, the pids, and the device. The route is `POST /api/history/<tool>/<id>/takeover` with `{ force?, confirmBusy? }`. It answers `{ stopped, busy }`, or 409 with a `code` of `busy`, `not-found`, or `still-running`. Collaborators can't use it.

Codex conversations open in the VS Code Codex extension can't be identified, because its `codex app-server` command line has no conversation id. Close those on the Mac first.

### Continue on the Mac

In a chat, open chat settings and tap **Continue on computer**. For a terminal, open **More** and tap **Continue on Mac**. Pocket Dev closes its own copy of that conversation, and the phone's terminal or chat shows "Continued on your Mac". A card then shows the exact command to run in a terminal on the Mac, `cd <folder>` and `claude --resume <id>` or `codex resume <id>`. Touch the command to select it. Pocket Dev never uses the clipboard. It leaves a copy open in VS Code or a Mac terminal alone. The route is `POST /api/history/mac` with `{ terminalId }` or `{ tool, id }`, and `{ confirmBusy? }`. It answers `{ stopped, tool, id, cwd, command }`, or 409 with `code: 'busy'`. A chat that is asleep has nothing to close, and the command is still shown.

On the Mac itself, the Admin page's **Open in Pocket Dev** list shows each conversation open in a Pocket Dev terminal or chat, with the command. Its **Continue on Mac** button does the same release.

## Chat

| Feature | What it does | Does not |
| --- | --- | --- |
| Engines | Claude through `@anthropic-ai/claude-agent-sdk` 0.2.139, which runs your installed `claude`. Codex connects to its running local daemon so terminal conversations can continue in Chat. Without a daemon, it starts one shared `codex app-server` process. Both use your existing logins. | Store any Claude or Codex credentials. |
| Chat screens | Chat list, new chat (engine, folder, model, mode), and a conversation view with markdown, tool folds, and diffs. **Browse folders** selects the working folder on the Mac without typing a path. | |
| Queue | Type while the agent is working and the button says **Queue**. Waiting messages stay in a compact tray above the composer, with a shortened one-line preview, **Edit**, and **Remove**. Edit loads the full text into the bottom message box; **Save** keeps its place and attachments, and **Cancel** restores your separate draft. If the agent already picked it up, **Keep draft** preserves the edit without sending another message. The tray stays at the bottom while replies stream; a large queue scrolls inside the tray. When the agent takes a message, it leaves the tray and appears in full in the conversation. Messages go out one per turn, in order. There is one **Stop** in the status line. Up to 20 messages can wait. After a failed turn the rest appear as **Not sent** instead of running. Waiting messages are held in memory, so a server restart marks them **Not sent**. | Survive a restart. |
| Attached images | A picture you attach with 📎 shows as a small preview in your own message, not just a file name. Tap it for the original. Other files stay as `📎 name`. The preview is a 480 px JPEG made once with `sips` and kept in the chat's `.images` folder. The route serves only a file listed on that message and only if it is an image, never an arbitrary path. | Preview files that are gone (they fall back to the name). |
| Tool images | A picture a tool returns (for example `Read` on a PNG) shows in the tool's fold instead of `[image]`. Tap it for the full size. Files up to 8 MB are saved in `~/.pocket-dev/chats/<id>.images/` (mode 0600), only their names go in the chat, and deleting the chat deletes them. | Show images over 8 MB or in other formats (those stay `[image]`). |
| Allow and Deny | Cards for commands, file edits, tools, and plans. A Claude card has up to four buttons: **Allow once**, **Always allow in this chat** (**Allow all edits in this chat** for a file edit), **Always allow in this project** when Claude offers a rule it can save, and **Deny** with an optional reason. A Codex card has three: **Approve**, **Approve for this chat**, and **Deny**. A plan card has **Start working** and **Keep planning**. The Permissions screen lists and removes remembered rules. | Time out a waiting card. |
| Questions | Answers `AskUserQuestion` (Claude) and `requestUserInput` (Codex), with **Other…**. | Multi-select on Codex. |
| Stop | Interrupts the turn. The server ends it after 5 s if the engine does not stop. | |
| Models and modes | Model lists come from each engine, with custom model names supported. Claude has Ask every time, Accept edits, Plan, Auto, Don’t ask, and Bypass. Codex has independent Approval (Ask first, On request, Never ask), Sandbox (Read only, Workspace, Full access), and Effort controls. Bypass and Full access need confirmation. Chips report whether a change applies now or next turn; replies show their model. | |
| Sessions | Pocket Dev keeps `~/.pocket-dev/chats/<id>.json`. Claude Code, Codex, Antigravity and Copilot keep their own transcripts in `~/.claude`, `~/.codex`, `~/.gemini/antigravity-cli` and `~/.copilot/session-state`, shared with VS Code and the CLI. | Delete the engine's own transcripts. |
| Idle sleep | Stops an idle engine after `chatIdleMinutes` (default 10). The next message wakes and resumes it. | Sleep a chat with a running turn or a waiting card. |

Switching Codex Approval to **Never ask** immediately declines pending and new permission requests, including during a running turn. It preserves sandbox restrictions and ordinary questions. The next turn also receives the updated Codex policy.

Terminal and Chat reconnect when the phone wakes or its network returns. Heartbeats detect a socket that still appears open after losing its connection. Chat waits for a fresh server snapshot before enabling Send or showing approval cards. Draft text stays editable while offline; reconnecting never submits it automatically.

Chat drafts (including uploaded attachments) and terminal command drafts are saved per conversation in the current browser tab and restored after a reload. Files still uploading cannot be restored after a reload. A delayed response cannot clear another chat's draft or text typed since sending. Chat sends time out after 20 seconds if the response never arrives; retrying the same draft uses its original message ID, with the last 256 accepted IDs saved per chat to prevent duplicate messages or queued entries. Server-side queues still have the restart limits described above.

## Files

Browse `fileRoots` (by default your home folder), with every path checked again after symlinks resolve. Sort by name, date, or size, show hidden files, and pin folders. Upload several files in a queue with progress, four at a time (no size limit on the Wi-Fi, `fileUploadMax` (2 GB) each over the internet; never overwrites), download files (byte ranges), zip a selection or a folder (`/usr/bin/zip`, 4 GB before compression, 200,000 files), new folder, rename files and folders, move to the macOS Trash, name search (4 levels, 500 results, 2 s), copy path, and preview (images, video, audio, PDF, and the first 200 KB of text; HTML shows as text; previews are sandboxed).

Trash uses macOS’s native Trash operation. Restore items in Finder on the Mac. Files does not permanently delete, restore from its own interface, move or copy between folders, or search file contents.

## Messages

Messages is a chat between this Mac, your own devices, and the people you invite. Use it to move text, screenshots, videos, and files between them.

- **Who takes part.** The Mac (the Messages panel on the Admin page and `pocket-dev message`, shown under the computer's name), every logged-in owner device, and every collaborator and guest session, in all roles. A Viewer can read and send in Messages even though its Files access is read-only.
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

## Open apps

Lists regular apps (the same set as the Force Quit window) with memory and CPU summed over each app's process tree, frontmost first, refreshed every 10 s. Shows each app's windows and document paths. **Quit** sends a normal quit and waits 8 s. **Force quit** sends SIGTERM, then SIGKILL after 3 s.

It does not quit protected apps (Finder, Dock, SystemUIServer, loginwindow, WindowServer, ControlCenter, NotificationCenter, Spotlight, and the app Pocket Dev runs inside), list windows on other Spaces, open apps, or move windows.

## Health, status and alerts

**Settings → Mac health**, or a tap on the strip at the top of any screen, opens one panel with a verdict (**Healthy**, **Worth a look**, **Needs attention**, or **Some readings unavailable**) and the readings behind it, refreshed every 10 s while open:

- **Battery:** charge, time left or to full, condition (full-charge capacity as a percent of the original, from `AppleRawMaxCapacity` over `DesignCapacity`), and charge cycles against the rated life.
- **Temperature:** battery temperature and macOS thermal state, with your alert limits.
- **Performance:** processor use from CPU counter differences between readings, memory free from `memory_pressure`, memory used from `top`, available space on the Mac’s home disk, and Pocket Dev’s event-loop delay. `top` supplies a fallback CPU sample while the counter sampler warms up.
- **Staying awake:** the Keep awake mode, whether the Mac is staying awake now, and the lid.
- **This Mac and Pocket Dev:** name, uptime, network address, version, Node.

The verdict reuses the battery and heat alert rules and adds: battery worn below 80% of its original capacity, processor at 90% or more, memory under 10% free (red under 5%), and disk under 10 GB (red under 3 GB). A reading the Mac cannot give shows **No reading** and never counts as healthy or as a problem. `GET /api/health` needs a login and is on the phone listener only.

### Live Mac status and alerts

A strip at the top of every phone screen shows **CPU usage**, **free storage**, battery and temperature. Performance checks run about every five seconds while the page is visible; battery and temperature refresh every 30 seconds. Memory pressure is sampled every 20 seconds. Connected pages share cached performance readings rather than launching separate `top` processes.

The strip reports **Normal**, **Busy**, **Memory tight**, **Storage low**, **Slow response**, or **Partial readings**. CPU at 90% shows Busy; sustained load for 15 seconds also raises a banner. Memory and storage use the health-panel limits above. Alerts for CPU, memory or slow response offer **Open apps** so you can inspect what is running. They never quit apps automatically.

An eight-second request deadline marks **Mac not responding**, retaining the last CPU/storage numbers visibly as old with their age. **Phone offline** is separate. The banner explains that the Mac may be busy, asleep or disconnected; it cannot prove a frozen Mac or desktop. A server error shows **Readings unavailable**, and an older server without monitoring shows **Monitoring needs update**. Checking pauses in the background and resumes immediately when the page returns or the phone reconnects.

The battery and temperature remain visible alongside performance. The temperature is the battery's, in °C, plus macOS's thermal pressure (warm, hot, very hot) when it is above normal. A Mac cannot report its chip temperature to a normal user without `sudo` (`powermetrics`) or a third-party tool, so Pocket Dev does not show one.

An amber or red banner appears under the strip, and the phone vibrates once, when:

- the battery is at or below `batteryAlertPercent` (default 20) and not charging; red at 10% or less. The text says you could lose open work.
- the battery temperature reaches `temperatureAlertC` (default 40 °C; red 5 °C above), or macOS thermal pressure is serious or critical. **Open apps** on that banner helps close heavy apps.

**Dismiss** hides a banner for 15 minutes, or until it gets worse. The page title gets a ⚠ while a condition lasts. Alerts show only while the Pocket Dev page is open on the phone: a closed page cannot be reached without https and push notifications, which are on the roadmap.

## Screen view

Settings → **Mac screen** shows a picture of the Mac's main display: **Refresh** takes a new one, **Auto** refreshes every 3 s, **Zoom** enlarges it to scroll around. It is read-only (no clicks or typing reach the Mac) and needs a logged-in phone. Each picture is a JPEG at most 1,600 px on its longest side, sent and then deleted; nothing is kept on disk. On a Mac it is taken with `screencapture` and shrunk with `sips`. On Windows, PowerShell takes it with .NET (System.Drawing, at the display's real resolution) and shrinks it the same way; Windows allows this only from the signed-in, unlocked desktop. On Linux it uses grim, scrot, maim, gnome-screenshot or ImageMagick, and ImageMagick to shrink. Turn it off with `pocket-dev config set screenView false`.

It needs **Screen Recording** for the program that runs Pocket Dev. Without it the picture shows only the wallpaper. The Admin page's Permissions panel shows whether it is allowed and opens the right System Settings page. The check looks for titled windows from other apps, because macOS hides those titles until Screen Recording is allowed; with no other window open it reports Unknown.

## Device camera

Settings → **Device camera** lists the computer's cameras. Choose one and tap **Start camera** for a video-only preview; **Snapshot** downloads the current image as a JPEG to your viewing device. **Stop**, **Close**, back, or hiding the page ends your preview. Prepare camera permission once in Admin → This computer → Remote camera before leaving the computer. Later Start camera requests automatically open or reuse the localhost camera tab. Continuous video uses WebRTC, with a pushed-image fallback when direct video is unavailable. No extra camera software is required. The optional legacy FFmpeg backend retains its helper installer. Preview images are kept in memory; snapshots are saved only when you download them. Camera sessions require login, belong to the device that starts them, and expire after 15 seconds without viewer keepalives. Room permission modes apply to starting capture; project collaborators cannot use it. Disable access with `pocket-dev config set cameraView false`. See [Camera setup](CAMERA.md) for platform details.

## Power

| Feature | What it does | Does not |
| --- | --- | --- |
| Keep Mac awake | `off`, `plugged` (default, `caffeinate -s`), or `always` (`caffeinate -i -s`). caffeinate runs with `-w <server pid>`, so it ends with the server. | Change system settings. Keep the display on. |
| Battery badge | `pmset -g batt` every 60 s. Red at 20% or less on battery. | |
| Lid closed | `sudo pmset -a disablesleep 1` or `0`, run by `npm run lid` in a new terminal where you type your password. Refused while the lid is closed. | Store or send your password anywhere. Turn itself off. |
| Sleep | `pmset sleepnow` after 2 s. With Lid closed on, `npm run sleep` turns lid sleep back on first (password). | Wake the Mac. |
| Shut down | Ends Pocket Dev terminals, then `osascript` tells System Events to shut down. After 45 s the phone shows a blocked screen with **Try shut down again**, **See open apps**, **Force shut down…** (`sudo shutdown -h now` in a terminal), and **Keep the Mac on**. | Force without your password. |
| Update guard | Refuses sleep and shutdown while a macOS update installs, or when the check fails. | Guard the lid switch. |

<a id="rooms-in-detail"></a>

## Connected computers in detail

Connections reuse the existing Room networking transport. Membership, target-owned permissions and the AI source are separate concepts. Personal computer access requires target approval; provider sharing requires both a provider-wide sharing toggle and a grant to the recipient. Device requests carry persistent signing identities. AI sessions use an end-to-end encrypted WebSocket channel, including through the network host.

The existing computer switcher excludes AI-only peers. Chat identifies a provider by its type and device ID, preserving conversation context when sources change. Files, commands and approval decisions execute on the selected workspace computer. Personal histories and local messages are not replicated to the network. The old tasks, mirrors, assigned controllers and room-wide permission modes are retired.

See [configuration, exact compatibility and validation status](UNIFIED_CONNECTIONS.md).

## Collaborators, login and security

**Legacy collaborators (compatibility during migration):** New connections use **Connected computers** and **AI Tools**. Existing grants and saved project copies can be reviewed and revoked from Admin. The following describes the legacy compatibility endpoints, rather than the new connection flow. **Browse folders** selects the repository and each related folder on the Mac, in both Admin and phone Settings. Paths remain editable as an optional shortcut. Admin and phone Settings include a Collaborators section for one-repository access, optional related folders, 1-hour/1-day/7-day expiry, QR invitations, native sharing, WhatsApp sharing, editing access and revocation. First enable sharing from Mac Admin, explicitly selecting your own trusted devices as Admin. Other devices need review, subsequent password logins require Mac approval, and Admin pairing stays on the Mac. Invitations work once within 10 minutes; opening a link preview never accepts one, and admission never evicts an Admin.

Viewer can preview and download scoped files. Developer can change a separate project copy and explicitly writable copies of related folders; the owner's live checkout stays unchanged. Common credentials, Git metadata, dependencies and symlinks are excluded from copies. Review shared contents for project-specific secrets. Guest sessions cannot access owner chats, terminals, settings, apps, screen, power or other repositories. **Collaborator AI is currently unavailable** until an isolated execution runner and authentication are implemented and validated. The current file-sharing foundation does not complete the scoped-AI feature. See [implementation status and remaining plan](ROLE_ACCESS_PLAN.md).

| Feature | What it does |
| --- | --- |
| Password | scrypt hash (N=16384, r=8, p=1) in `config.json` as `passwordHash`. A random 12-character password is printed on the first start only. A plaintext `password` key is converted at start. Wrong passwords wait 1 s. New passwords need 6 to 200 characters. |
| QR sharing and login | The Admin page's **Share & login** section has **Show share QR** (a reusable address, password and approval still required) and **Show login QR** (one-time login, 10 minutes, skips approval), with copyable links. Codes use the Wi-Fi address, or the internet link when one is up. Login keys are kept in memory and are also printed at start or by `npm run qr`. Only the Mac can mint keys (loopback, no proxy headers, secret from `~/.pocket-dev/local-secret`). |
| Devices | Each login is a device in `~/.pocket-dev/devices.json` (sha256 of each cookie, never the cookie). A device holds one cookie per address it has used, up to eight, and counts once. Rename, log out, online now (open terminal or a request in the last 60 s). |
| Device limit | `maxDevices`, default 2, 1 to 20. Password logins stop at the limit. A QR login evicts the least recently used device. |
| Rate limit | 10 wrong passwords per IP in 15 minutes locks that IP for 15 minutes. The Admin page warns at 5 failures in an hour. |
| Cookie | `pd_token`, HttpOnly, SameSite=Strict, 1 year. `Secure` on the internet link; not on Wi-Fi, where the transport is http. Each cookie works only on the address it was issued for: a Wi-Fi cookie is no login on the internet address, and the other way round. |
| CSRF | Every POST, PUT, PATCH, and DELETE needs `x-pocket-dev: 1`. JSON bodies need `content-type: application/json`. WebSocket upgrades check `Origin`. |
| Approve, block, lockdown, security log | `requireApproval` makes password logins wait up to 10 minutes for approval on the Mac, with a 4-character code to compare. With collaborator sharing on, every new password login waits, whatever `requireApproval` says; the Admin page says so under **Approve new devices**. QR logins and recovery-code logins never wait. A login can send a device name (see [Terminal API for scripts](#terminal-api-for-scripts)); the approval list shows it beside the browser kind. `approveFromDevices` (default off; only the Mac turns it on, a phone can turn it off) also lets a logged-in owner phone see who is waiting under Settings → Devices and approve or deny with the same code check, and pushes "Someone is waiting to log in" to the owner's open pages. A logged-in owner phone already has full shell access, so letting it approve logins adds no power it did not have; if that phone is lost, log it out from the Mac or run lockdown. With role-based sharing on, only Admin devices approve, and collaborator invitations can already be sent from a logged-in owner phone. Blocked devices are refused on every route, across restarts. Lockdown logs out every non-blocked device, stops forwards, voids QR keys, disconnects phone access, and optionally closes terminals or sets a new password. Only the Mac can reconnect phone access. Events go to `~/.pocket-dev/security.log` (JSONL, mode 0600, rotated at 1 MB to `security.log.1`). |
| Admin page | `http://localhost:7778` (`adminPort`, default phone port + 1), bound to 127.0.0.1 and ::1, with a Host allowlist, Origin and proxy-header refusal, and an `x-pocket-admin: 1` header on writes. It has no password, because only a process on the Mac can reach it. Sections: Connection, Internet access (Off, Quick link, My own domain, Wi-Fi access), Share & login (share QR, one-time login QR, copy links), Waiting, Devices (rename, log out, block, unblock), Security log (latest 200, filters), Password (no old password needed), Settings (device limit, approval, approve from a logged-in phone, addresses), Live (close terminals, stop forwards and active chats, read-only Power and Open apps status), Service (install, Start automatically, stop), Lockdown. |
| Connect and Disconnect | Disconnect closes port 7777 and all forwards. Terminals keep running and devices stay logged in. A phone can disconnect, only the Mac can connect. With **Keep connection open** off, access closes about 30 s after the last Admin page closes (10 s heartbeat) and a restart starts disconnected. Saved as `access` in `config.json`. |
| Start automatically | `launchctl enable` or `disable` for `dev.pocket.server`, from the Admin page, the phone, or `npm run autostart`. Does not stop the running server. |

## Commands

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
| `pocket-dev update [--check] [--yes]` | Ask the npm registry for the newest version and install it with `npm install -g @anisirji/pocket-dev@latest`, then restart the background service. `--check` only reports. Does nothing for a git checkout, `npm link` or `npx` copy. A permission error points to the own-folder fix and never to `sudo`. |
| `pocket-dev internet status\|off\|quick` | Show internet access and the link's status, turn it off, or allow a Quick link. |
| `pocket-dev internet domain --hostname <host> --token-stdin` | Use your own domain through a Cloudflare tunnel. The token comes from stdin, or from a file with `--token-file <path>`, never as an argument. See [Connect over the internet](#internet-access-in-detail). |
| `pocket-dev qr`, `admin`, `connect`, `disconnect`, `awake` | The same as the `npm run` commands below. |
| `pocket-dev message [text] [--to NAME] [--file PATH]` | Send to Messages as the Mac. Text comes from the argument or piped stdin. |

`config set` accepts `port`, `adminPort`, `awake`, `requireApproval`, `approveFromDevices`, `maxDevices`, `chatIdleMinutes`, `batteryAlertPercent`, `temperatureAlertC`, `screenView`, `cameraView`, `cameraBackend`, and `allowedHosts` (comma separated), and `messagesReserveGB`. Run `pocket-dev help` for the ranges. `port`, `adminPort` and `cameraBackend` apply after a restart (`pocket-dev service restart`); the rest apply right away. Change the password on the Admin page (`pocket-dev admin`).

The config file is `~/.pocket-dev/config.json` (mode 0600). A `config.json` left in the package folder by an older version moves there on the first run, and the old file stays as `config.json.migrated`.

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

## Internet access in detail

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

Each address has its own login cookie, so a phone that first opens the internet address meets the password page, and with **Approve new devices** on it would wait for approval on the Mac, which is no use when you are away. Link the phone while it is at home instead: on Wi-Fi, the phone shows "Link this phone to pocket.example.com so you won't need to log in when you're away", and **Settings → Connection** has the same **Link this phone** button. Linking gives the same device a cookie for the internet address, then returns to Wi-Fi. A Quick link is a new address on every **Turn on**, so each phone links again each time; your own domain keeps one address, so the link is needed once per device. When the address changes, a phone on Wi-Fi says "The internet address is new" and offers **Link**. A phone still open on the old address says it cannot reach the device, that a restarted Quick link has a new address, and to scan a new QR code or open Pocket Dev on Wi-Fi. The other way round also works: scan the QR code on the internet address once (the codes point there when the link is up), then use **Switch to local** on Wi-Fi.

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

## Environment variables

Environment variables: `PORT`, `POCKET_DEV_CONFIG`, `POCKET_DEV_PASSWORD` (overrides the stored password and is printed at start), `POCKET_DEV_REPO_ROOTS`, `POCKET_DEV_STATE_DIR` (instead of `~/.pocket-dev` for authentication, security logs, Admin metadata, the tunnel token, and chats), `POCKET_DEV_CHAT_DIR` (an explicit chat-storage override), `POCKET_DEV_ADMIN_PORT`, `POCKET_DEV_NO_OPEN` (do not open the Admin page at start), `POCKET_DEV_CLOUDFLARED` (the `cloudflared` executable; otherwise `/opt/homebrew/bin/cloudflared`, then `/usr/local/bin/cloudflared`), and `POCKET_DEV_UPDATE_URL`, `POCKET_DEV_NPM`, `POCKET_DEV_INSTALL_KIND`, `POCKET_DEV_NOTIFY_RECORD` and `POCKET_DEV_NO_DESKTOP_NOTIFY` (tests only: another version look-up address, another npm program, `global` to treat the copy as an npm install, a file that receives the desktop notification text instead of the screen, and a switch that shows nothing), and `POCKET_DEV_NO_UPDATE_CHECK` (set to `1` to stop the npm look-up for a newer version, the update icon, the notices and the Admin Update button, and the setup step; the same as `pocket-dev config set updateCheck false`).

Codex Chat uses the daemon socket at `$CODEX_HOME/app-server-control/app-server-control.sock` (`CODEX_HOME` defaults to `~/.codex`). `POCKET_DEV_CODEX_SOCKET` selects a different local socket. `POCKET_DEV_CODEX` selects a binary and uses a private stdio server unless a socket override is also supplied.

Copilot Chat starts the `copilot` program that `POCKET_DEV_COPILOT` names, or the first `copilot` on the PATH and in the usual install folders, as `copilot --acp --stdio --no-auto-update` (plus `--reasoning-effort <level>` when Effort is set). It reads only `<copilot home>/session-state/<id>/workspace.yaml` and `events.jsonl` for the Chats list, where the copilot home is `COPILOT_HOME` or `~/.copilot` and `POCKET_DEV_COPILOT_DIR` names the `session-state` folder directly. It never opens Copilot's settings or credential files. Settings: `model` (Auto, or any name Copilot accepts; sent with `session/set_model`), `mode` (`agent` or `plan`; sent with `session/set_mode`) and `effort` (`default`, `low`, `medium`, `high`, `xhigh`; a command-line argument, so it applies from the next message in a fresh process that loads the same session).
