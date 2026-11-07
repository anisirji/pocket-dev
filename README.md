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

## Limits

- Forwarded ports have no password. Anyone on your Wi-Fi can reach them while they are open. Stop a forward with the ✕ on its chip.
- Pocket Dev uses plain HTTP. Use it only on a network you trust.
- Forwards bind the Mac's LAN IP at the time you open them. If the IP changes, open them again.
- The server keeps about 500 KB of output per terminal for replay.
- Pocket Dev does not delete old uploads. Clear `~/.pocket-dev/uploads` yourself.
- The phone loads xterm.js from cdn.jsdelivr.net, so the phone needs internet access.
