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

The server prints the URL and the password:

```
Pocket Dev running at http://192.168.1.17:7777
Password: xxxxxxxxxxxx
```

Open that URL in Chrome on your phone and log in.

- On first start, the server writes `config.json` with a random password and port 7777. It writes the file with mode 0600.
- To change the password, edit `config.json` or set `POCKET_DEV_PASSWORD`.
- To use a different port, set `PORT`.
- A server restart logs every device out. The terminals do not survive a restart.

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

- Each restart closes all terminals and logs every device out.
- The log contains the password, because the server prints it at start.
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
