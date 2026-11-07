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
Password: (set; change it in Settings)
Scan the QR code to log in without the password. It works once and expires in 10 minutes. New code: npm run qr
```

Scan the QR code with your phone's camera and open the link in Chrome. You are logged in. You can also open the URL and type the password.

- On first start, the server writes `config.json` with port 7777 and prints a random password. Only the first start prints it.
- `config.json` stores a scrypt hash of the password (`passwordHash`), never the password. If it still has a plaintext `password`, the server converts it at start.
- To change the password, use **Settings**. `POCKET_DEV_PASSWORD` overrides the stored password, and the server then prints it at start.
- To use a different port, set `PORT`.
- Logged-in devices stay logged in across restarts. The terminals do not survive a restart.

## Log in with a QR code

- `npm run qr` prints a new QR code and URL from the running server. Run it on the Mac.
- On a phone that is already logged in, tap **⚙** and then **Show login QR**. Scan that code with the other phone.
- Each code works once and expires after 10 minutes. A used or expired code opens the login page with a message.
- `npm run qr` reads a secret from `~/.pocket-dev/local-secret`, which the server writes at each start with mode 0600. The server creates codes only for requests from 127.0.0.1 that carry this secret and no proxy headers, so a tunnel on the Mac cannot create them.

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
| Follow the log (`~/Library/Logs/pocket-dev.log`) | `npm run service:logs` |
| Restart, for example after `git pull` | `npm run service:install` |
| Stop and remove the service | `npm run service:uninstall` |

- Each restart closes all terminals. Devices stay logged in.
- The log contains a login QR code and URL from each start. Each works once and expires after 10 minutes. The log contains the password only when the server generated it or it comes from `POCKET_DEV_PASSWORD`.
- The service is a per-user agent. After a reboot it starts when you log in, not before.
- Each terminal is a login zsh (`/bin/zsh -l`), so `~/.zprofile` and `~/.zshrc` apply. The service PATH also includes `/usr/local/bin`, `/opt/homebrew/bin`, and `~/.local/bin`, so `claude`, `codex`, `gh`, `git`, and `brew` work.

### Sleep

The service runs the server under `caffeinate -i -s`, so the Mac does not idle-sleep while the server runs. The display can still turn off.

- `-s` prevents system sleep only on AC power. On battery, only idle sleep is prevented.
- Closing the lid still puts the Mac to sleep, unless an external display and power are connected.
- To keep a closed MacBook awake, you can run `sudo pmset -a disablesleep 1`. The Mac then never sleeps, including in a bag, so it can get hot and drain the battery. Undo it with `sudo pmset -a disablesleep 0`.

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

## Open a port

1. Start your dev server on the Mac, for example `npm run dev` on port 3000.
2. Tap **Ports**, enter `3000`, and tap **Open**.
3. Tap the `:3000` chip. It opens `http://<mac-ip>:3000` in a new tab.

The forward is a raw TCP pipe from `<mac-ip>:3000` to `localhost:3000`. It tries 127.0.0.1 first and then ::1. HMR websockets work without changes.

If the dev server already listens on all interfaces (0.0.0.0), you can open `http://<mac-ip>:3000` directly. You do not need a forward.

## Git

Tap **Git** in the top bar. The terminals keep running while the Git view is open.

- Pick a repository from the list at the top. Pocket Dev finds repositories up to two levels below `~/Desktop`, `~/Desktop/Projects`, and `~`. To scan other folders, add `"repoRoots": ["~/code", "~/work"]` to `config.json`, or set `POCKET_DEV_REPO_ROOTS` to a colon-separated list.
- **Graph** shows the last 300 commits on all branches. Tap a commit to see its files, and tap a file to see its diff. A merge commit shows its changes against its first parent, which is what the merge brought in.
- **Changes** shows staged, changed, and untracked files. Tap a file to see its diff.
- **Pull requests** lists the open pull requests on GitHub. You can review, merge, close, reopen, and create pull requests. This uses the GitHub CLI (`gh`), so run `gh auth login` on the Mac first.
- **Delete branch** after a merge deletes the branch on GitHub only. Your local branch and working tree do not change.
- To create a pull request from a branch that is not on GitHub yet, Pocket Dev runs `git push -u origin <branch>` first.
- GitHub does not let you approve your own pull request. The error from GitHub shows in red.

## Limits

- Forwarded ports have no password. Anyone on your Wi-Fi can reach them while they are open. Stop a forward with the ✕ on its chip.
- Pocket Dev uses plain HTTP. Use it only on a network you trust.
- Forwards bind the Mac's LAN IP at the time you open them. If the IP changes, open them again.
- The server keeps about 500 KB of output per terminal for replay.
- Pocket Dev does not delete old uploads. Clear `~/.pocket-dev/uploads` yourself.
- The phone loads xterm.js from cdn.jsdelivr.net, so the phone needs internet access.
