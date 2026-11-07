# Pocket Dev

Real terminals on your Mac, from your phone's browser on the same Wi-Fi.

## Install

```sh
npm install
```

The `postinstall` script marks node-pty's `spawn-helper` as executable. node-pty 1.1.0 ships it without the execute bit.

## Start

```sh
npm start
```

The server prints a QR code, the URL, and a password line:

```
<QR code>
Pocket Dev running at http://192.168.1.17:7777
Also at http://your-mac.local:7777 (same Wi-Fi only; some Android phones cannot open .local names)
Password: (set; change it in Settings)
Scan the QR code to log in without the password. It works once and expires in 10 minutes. New code: npm run qr
Admin (this Mac only): http://localhost:7778
```

Scan the QR code with your phone's camera and open the link in Chrome. You are logged in. You can also open the URL and type the password.

- On first start, the server writes `config.json` with port 7777 and prints a random password. Only the first start prints it.
- `config.json` stores a scrypt hash of the password (`passwordHash`), never the password. If it still has a plaintext `password`, the server converts it at start.
- To change the password, use **Settings** or the admin page. A new password needs at least 6 characters. `POCKET_DEV_PASSWORD` overrides the stored password, and the server then prints it at start.
- To use a different port, set `PORT`.
- Logged-in devices stay logged in across restarts. The terminals do not survive a restart.

## Log in with a QR code

- `npm run qr` prints a new QR code and URL from the running server. Run it on the Mac.
- On a phone that is already logged in, tap **⚙** and then **Show login QR**. Scan that code with the other phone.
- Each code works once and expires after 10 minutes. A used or expired code opens the login page with a message.
- `npm run qr` and `npm run awake` read the server's port and a secret from `~/.pocket-dev/local-secret`, which the server writes at each start with mode 0600. The server accepts these script requests only from 127.0.0.1, with this secret and no proxy headers, so a tunnel on the Mac cannot make them.

## Devices

Each login is a device. Tap **⚙** to see them.

- The list shows each device's name, how it logged in, its IP address, and whether it is online now. A device is online when it has a terminal open or made a request in the last minute.
- **Rename** changes the name. **Log out** removes the device and disconnects its terminals at once.
- The server stores devices in `~/.pocket-dev/devices.json` with mode 0600. The file holds a hash of each login cookie, not the cookie.

### Device limit

`maxDevices` in `config.json` sets the limit. The default is 2, and you can set 1 to 20 in **Settings**.

- A password login fails when the limit is reached. Log out a device first, or scan a QR code.
- A QR login always works. When the limit is reached, it logs out the device used least recently.
- Lowering the limit logs nobody out. It only blocks new password logins.

## Admin page (this Mac only)

`npm run admin` opens `http://localhost:7778` in the default browser. The page shows who is logged in and lets you control phone access.

The page has no password. Only this Mac can reach it, and anyone using this Mac account can open it. Lock the Mac when you step away.

- It listens on 127.0.0.1 and ::1 only. The port is `adminPort` in `config.json`, or `POCKET_DEV_ADMIN_PORT`. The default is the main port plus 1.
- It refuses requests with a foreign `Host` or `Origin` header, requests with proxy headers, and changes without the `x-pocket-admin: 1` header and a JSON body. Other web pages and tunnels on the Mac cannot use it.

### Connect and disconnect

The top card opens or closes phone access. **Disconnect** closes the phone port: every phone disconnects and port forwards stop. Terminals keep running on the Mac. **Connect** opens the port again and reopens the forwards.

- **Keep connection open** on (the default): the state survives closing the page and restarting.
- **Keep connection open** off: phone access closes about 30 seconds after the admin page closes, and Pocket Dev starts disconnected. `npm start` then opens the admin page so that **Connect** is one click away.
- `npm run connect` and `npm run disconnect` do the same from a terminal on the Mac.
- A phone can disconnect from **Settings**, but only the Mac can connect again.
- If another program holds the phone port, Pocket Dev stays up, the admin page names that program, and **Connect** tries again.

### Devices, approval, and blocking

- **Log out** removes a device and closes its terminals at once.
- **Block** keeps the device listed and refuses everything it sends. Its phone shows "This device is blocked". **Unblock** restores it, and **Remove** deletes the record.
- A blocked browser that clears its cookies becomes a new device and can log in again with the password. To prevent that, turn on **Approve new devices**: a password login then waits on the phone ("Waiting for approval on the Mac…") until you press **Approve** on the admin page. The phone and the admin page show the same 4-character code. Requests expire after 10 minutes. QR logins skip approval, because scanning a code from the Mac proves you are there.
- After 10 wrong passwords in 15 minutes from one IP address, that address cannot log in for 15 minutes.

### Security log

Pocket Dev appends logins, failed logins, QR use, device changes, password and setting changes, connects, disconnects, and lockdowns to `~/.pocket-dev/security.log` (JSON lines, mode 0600). At 1 MB the file moves to `security.log.1`, which replaces the older copy. The admin page shows the latest 200 entries and warns when 5 or more logins failed in the last hour.

### Lockdown

**Lock down now** disconnects phone access, logs out every device (including ones waiting for approval), stops every port forward, and cancels every login QR code. Blocked devices stay blocked. Terminals keep running unless you tick **Also close all terminals**. You can set a new password in the same step.

## Run it always

Pocket Dev can run as a launchd agent. launchd starts it when you log in and restarts it within about 10 seconds if it crashes.

1. Stop a server that you started by hand: `pkill -f "node server.js"`. The service runs `node /full/path/server.js`, so this command does not match it.
2. Install and start the service:

   ```sh
   npm run service:install
   ```

   The script writes `~/Library/LaunchAgents/dev.pocket.server.plist` and loads it. It uses the `node` on your PATH at install time and the port from `config.json` (set `PORT` to override). If another process already listens on the port, the script stops and tells you how to stop that process. `--force` installs anyway, and the service starts when the port is free.

| Task | Command |
| --- | --- |
| Show state, URL, sleep assertions, and recent log | `npm run service:status` |
| Print the plist without installing it | `scripts/install-service.sh --print` |
| Follow the log (`~/Library/Logs/pocket-dev.log`) | `npm run service:logs` |
| Restart, for example after `git pull` | `npm run service:install` |
| Stop and remove the service | `npm run service:uninstall` |
| Turn starting at login on or off, or show it | `npm run autostart -- on`, `off`, or `status` |

- Each restart closes all terminals. Devices stay logged in.
- `npm run autostart -- off`, or the switch in **Settings** or on the admin page, keeps the service from starting at the next login. It does not stop the running server. **Stop Pocket Dev now** on the admin page stops it, including when it runs as the service.
- The log contains a login QR code and URL from each start. Each works once and expires after 10 minutes. The log contains the password only when the server generated it or it comes from `POCKET_DEV_PASSWORD`.
- The service is a per-user agent. After a reboot it starts when you log in, not before.
- The service runs `node server.js` directly. The server itself keeps the Mac awake, as the mode in [Power](#power) says.
- Each terminal is a login zsh (`/bin/zsh -l`), so `~/.zprofile` and `~/.zshrc` apply. The service PATH also includes `/usr/local/bin`, `/opt/homebrew/bin`, and `~/.local/bin`, so `claude`, `codex`, `gh`, `git`, and `brew` work.

## Power

Pocket Dev decides whether your Mac stays awake. It does not change your system settings. It runs `/usr/bin/caffeinate` as a child process. The child exits when the server stops, so it never keeps the Mac awake after Pocket Dev quits.

| Mode | What it does |
| --- | --- |
| Off | The Mac sleeps on its normal schedule. |
| When plugged in (default) | The Mac does not sleep while on the charger. On battery, it sleeps as usual. Runs `caffeinate -s`. |
| Always | The Mac does not idle-sleep, on battery too. Runs `caffeinate -i -s`. This drains the battery. |

The server saves the mode in `config.json` as `awake` and applies it at every start. The display can still turn off in every mode.

The **⚙** button shows the Mac's battery percentage, in red at 20% or less on battery. **Settings** shows the battery and power source at the top.

Change the mode in **Settings → Power → Keep Mac awake** on your phone, or from a terminal on the Mac, including a Pocket Dev terminal:

```sh
npm run awake -- status    # mode, power source, battery, lid state
npm run awake -- plugged   # When plugged in
npm run awake -- on        # Always
npm run awake -- off       # Off
```

`npm run awake` talks to the server that started last, on the port it wrote to `~/.pocket-dev/local-secret`.

### Lid closed

Closing the lid puts a MacBook to sleep, whatever the mode, unless an external display and power are connected. To keep a closed MacBook awake:

```sh
npm run lid -- on       # runs sudo pmset -a disablesleep 1
npm run lid -- off      # runs sudo pmset -a disablesleep 0
npm run lid -- status
```

`on` and `off` ask for your Mac password. You can type it in a Pocket Dev terminal. While lid sleep is off, the Mac never sleeps, even in a bag. Keep it on a desk and plugged in. Amphetamine's Closed-Display Mode is another way to do this.

On the phone, the **Lid closed** switch in Settings opens a new terminal and runs the same command, so you type your password there. Pocket Dev never receives or stores your password.

`on` and `off` refuse while the lid is closed. Turning lid sleep back on with the lid shut would put the Mac to sleep at once and disconnect you. Open the lid first.

### Sleep and shut down

Settings has **Put Mac to sleep** and **Shut down Mac**. From a terminal on the Mac:

```sh
npm run sleep                  # turns lid sleep back on (sudo), then sleeps
npm run shutdown               # asks macOS to shut down, like the Apple menu
npm run shutdown -- --force    # sudo shutdown -h now: unsaved work in every app is lost
```

- Sleep pauses `caffeinate` first, so the mode cannot block it. The mode comes back the next time the phone talks to Pocket Dev after the Mac wakes. If lid sleep is off, the phone opens a terminal for `npm run sleep`, because turning lid sleep back on needs your password.
- Shut down closes every Pocket Dev terminal and asks macOS to shut down. An app with unsaved changes can stop it. If the Mac is still on 45 seconds later, the phone shows which apps are open. You can open **See open apps** to quit them, try again, or force the shutdown. A forced shutdown asks for your password in a new terminal.
- Sleep and both kinds of shutdown refuse while a macOS update is being prepared or installed. `scripts/update-check.sh` looks for an update process that holds a sleep assertion, or a running `softwareupdate --install`. If the check itself fails, they also refuse.

### macOS settings you set yourself

Pocket Dev does not change these settings. Set them in System Settings:

1. **Battery → Options → Wake for network access**: on. The phone can then reach the Mac after the display sleeps.
2. **Battery → Options → Prevent automatic sleeping on power adapter when the display is off**: optional. The When plugged in mode does the same thing while Pocket Dev runs.
3. **Battery → Optimized Battery Charging**: on. This protects the battery when the Mac stays plugged in all the time.
4. **Users & Groups → Automatically log in as**: your user. The service starts only after someone logs in. This option is not available when FileVault is on.
5. **Network → Firewall**: if macOS asks whether `node` can accept incoming connections, allow it.
6. **Privacy & Security → Automation**: allow `node` to control **System Events**. Shut down from the phone needs it. macOS asks once, on the Mac, the first time you shut down from the phone. If you denied it, the phone says so.
7. **Lid closed**: `npm run lid -- on`, or Amphetamine's Closed-Display Mode.

## Use

- Tap **+** and pick a folder to open a terminal there. Each terminal is a login shell (`$SHELL -l`). The tab is named after the folder.
- Type in the bottom input and tap **Send**. Send with an empty input sends Enter.
- The key bar sends Ctrl+C, Enter, Esc, Tab, the arrow keys, and Ctrl+D.
- You can also tap the terminal and type into it directly.
- Terminals keep running when the phone locks or disconnects. When the phone reconnects, the page replays the recent output.

## Folders, shortcuts, copy and upload

- **Folders.** The **+** sheet lists Home, your pinned folders, the last five folders you opened, and every folder in `~/Desktop` and `~/Desktop/Projects` that has `.git` or `package.json`. Tap ☆ to pin a folder. To open any other folder, type its path, for example `~/code/app`.
- **Shortcuts.** Tap **⚡** in the key bar and tap a saved command to run it in the current terminal. Tap **Edit** to add, delete, or reorder commands.
- **Copy.** Tap **📋** to see the last 300 lines of the terminal as plain text. Tap **Copy all**, or long-press to select part of it.
- **Upload.** Tap **📎** to pick screenshots or files, or paste an image into the input. Pocket Dev saves each file in `~/.pocket-dev/uploads` and adds its path to the input. It does not send the command. Files can be up to 25 MB.

Pinned folders, recent folders, and shortcuts are saved in `config.json` as `folders`, `recentFolders`, and `shortcuts`. Set `POCKET_DEV_CONFIG` to use a config file somewhere else.

You can edit `config.json` while the server runs. Pocket Dev reads it again for each request and writes back only the setting you change in the app, so your other edits stay. If a list is malformed, Pocket Dev ignores the part it cannot use, logs a warning, and leaves the file as it is. While the file is not valid JSON, changes from the app fail with a message until you fix it.

## Resume a laptop conversation

Tap the clock icon (**Resume**) to list your recent Claude Code and Codex conversations from `~/.claude` and `~/.codex` on the Mac. Tap one to read its last messages, then tap **Continue on phone**. Pocket Dev opens a terminal in the conversation's folder, runs `claude --resume <id>` or `codex resume <id>`, and names the tab `claude · <folder>`. A second terminal for the same folder gets a number, as folder tabs do.

- A conversation marked **open on laptop?** may still be running on the Mac. Close it there first, or both will write to it.
- Android's back gesture closes the topmost sheet only: Settings, then the conversation, then the list.

## Chat

Chat runs Claude Code and Codex as phone chat screens instead of terminals. Open it from the Chat view, or add `#chat` to the URL.

1. Tap **New chat**, pick Claude or Codex, a folder, and the engine settings.
2. Type a prompt and tap **Send**. Enter adds a new line.
3. When the engine wants to edit a file or run a command, a card appears above the composer. Pick **Allow once**, **Always allow in this chat**, **Always allow in this project** (Claude only), or **Deny** with an optional reason. For a Claude file edit the card offers **Allow all edits in this chat** instead, which switches the chat to Accept edits, as Claude Code does.

- Claude chats use the Claude Agent SDK with the `claude` CLI on your PATH, so they use your Claude Code login. No API key is needed. Sessions are the usual `~/.claude/projects` files, so they also appear in VS Code and in the Resume sheet.
- Codex chats use `codex app-server` with your Codex login. All Codex chats share one app-server process.
- The chips under the chat title change the model, the permission mode (Claude) or approval policy and sandbox (Codex), and the reasoning effort. A toast says whether the change applied now or applies from the next turn.
- **Always allow in this project** writes the rule that Claude Code suggests, such as `Bash(npm test:*)`, to `<folder>/.claude/settings.local.json`. The Permissions screen in chat settings lists and removes these rules and the chat's own rules.
- A run keeps going when the phone locks or disconnects. A card waits until you answer it. The chat list shows **waiting for you**.
- After 10 idle minutes the engine process stops and the chat shows **sleeping**. The next message resumes the same session. Set `chatIdleMinutes` in `config.json` to change the delay. An engine never stops while a turn runs or a card waits.
- Chat logs are in `~/.pocket-dev/chats/` with mode 0600. Deleting a chat removes its log, not the engine's session files.
- New chats start with the tool, folder, and settings you used last (`chatDefaults` in `config.json`). A bypass or full-access setting is never remembered.

## Open a port

1. Start your dev server on the Mac, for example `npm run dev` on port 3000.
2. Tap the globe icon (**Ports**), enter `3000`, and tap **Open**. The icon shows how many ports are open.
3. Tap the `:3000` chip. It opens `http://<mac-ip>:3000` in a new tab.

The forward is a raw TCP pipe from `<mac-ip>:3000` to `localhost:3000`. It tries 127.0.0.1 first and then ::1. HMR websockets work without changes.

If the dev server already listens on all interfaces (0.0.0.0), you can open `http://<mac-ip>:3000` directly. You do not need a forward.

## Git

Tap the branch icon (**Git**) at the top left. The terminal icon next to it switches back. The terminals keep running while the Git view is open.

- Pick a repository from the list at the top. Pocket Dev finds repositories up to two levels below `~/Desktop`, `~/Desktop/Projects`, and `~`. To scan other folders, add `"repoRoots": ["~/code", "~/work"]` to `config.json`, or set `POCKET_DEV_REPO_ROOTS` to a colon-separated list.
- **Graph** shows the last 300 commits on all branches. Tap a commit to see its files, and tap a file to see its diff. A merge commit shows its changes against its first parent, which is what the merge brought in.
- **Changes** shows staged, changed, and untracked files. Tap a file to see its diff.
- **Pull requests** lists the open pull requests on GitHub. You can review, merge, close, reopen, and create pull requests. This uses the GitHub CLI (`gh`), so run `gh auth login` on the Mac first.
- **Delete branch** after a merge deletes the branch on GitHub only. Your local branch and working tree do not change.
- To create a pull request from a branch that is not on GitHub yet, Pocket Dev runs `git push -u origin <branch>` first.
- GitHub does not let you approve your own pull request. The error from GitHub shows in red.

## Open apps

Tap **⚙** and then **Open apps** to see the apps that are open on the Mac. The row shows how many are running. The list shows the same apps as the Mac's Force Quit window, with the memory and CPU of each app's whole process tree. The app in front comes first. The list refreshes every 10 seconds while it is open.

Tap an app to see its windows and, for document apps, the file each window shows. Then:

- **Quit** asks the app to quit, like Cmd+Q. If the app is still running after about 8 seconds, it is probably waiting at a "Save changes?" prompt on the Mac, or it refused.
- **Force quit** sends SIGTERM, then SIGKILL after 3 seconds. Unsaved work in the app is lost.

Pocket Dev never quits these apps:

- Finder, Dock, SystemUIServer, loginwindow, WindowServer, ControlCenter, NotificationCenter, and Spotlight.
- The app that Pocket Dev runs inside. If you started the server from Terminal or VS Code, quitting that app would stop the server. The launchd service runs inside no app, so this rule protects nothing extra there. The server itself is never in the list.

### Permissions

The app list and Quit need no permissions. The window list needs two one-time grants on the Mac. The page shows which one is missing.

| Permission | Where to turn it on |
| --- | --- |
| Automation for System Events | System Settings → Privacy & Security → Automation → the app that runs Pocket Dev → System Events |
| Accessibility | System Settings → Privacy & Security → Accessibility → the app that runs Pocket Dev |

The app that runs Pocket Dev is `node` for the launchd service. For a server that you started by hand, it is your terminal app, for example Terminal or VS Code. The two need separate grants. If `node` is not in the Accessibility list, click **+** and add the `node` binary that `which node` prints.

Windows on another Space may not appear in the list.

## Limits

- Forwarded ports have no password. Anyone on your Wi-Fi can reach them while they are open. Stop a forward with the ✕ on its chip.
- A forwarded dev server shares the Mac's IP with Pocket Dev, so the browser sends it the Pocket Dev cookie too. To keep its pages from changing anything, Pocket Dev accepts a POST, PUT, PATCH or DELETE only with the header `x-pocket-dev: 1`, and JSON bodies only as `application/json`. Scripts that call the API must send both.
- Pocket Dev uses plain HTTP. Use it only on a network you trust.
- Pocket Dev answers only requests addressed to the Mac: its LAN IP or `.local` name with the port, or `localhost`, `127.0.0.1` and `[::1]` with the port. Any other `Host` gets `421 Misdirected Request`, so a web page that points its own domain at the Mac (DNS rebinding) cannot reach Pocket Dev. To reach Pocket Dev through a tunnel or proxy domain, add the domain to `config.json`, for example `"allowedHosts": ["dev.example.com"]`. Port forwards are not checked.
- Forwards listen on the Mac's LAN IP. When the IP changes, Pocket Dev moves every forward to the new IP within about 10 seconds and logs the change. Without a network, a chip shows **no network** and the forward reopens when the Mac gets an IP. If the forward cannot listen on the new IP, the chip shows **failed**. Tap it to see why.
- The QR codes and **Settings** always use the current IP. **Settings** also shows the `.local` address, which keeps working when the IP changes but only on the same Wi-Fi, and not on every Android phone.
- The server keeps about 500 KB of output per terminal for replay.
- Pocket Dev does not delete old uploads. Clear `~/.pocket-dev/uploads` yourself.
- The phone loads xterm.js from cdn.jsdelivr.net, so the phone needs internet access.
