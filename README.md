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
| Print the plist without installing it | `scripts/install-service.sh --print` |
| Follow the log (`~/Library/Logs/pocket-dev.log`) | `npm run service:logs` |
| Restart, for example after `git pull` | `npm run service:install` |
| Stop and remove the service | `npm run service:uninstall` |

- Each restart closes all terminals and logs every device out.
- The log contains the password, because the server prints it at start.
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

Change the mode in **Settings → Keep Mac awake** on your phone, or from a terminal on the Mac, including a Pocket Dev terminal:

```sh
npm run awake -- status    # mode, power source, battery, lid state
npm run awake -- plugged   # When plugged in
npm run awake -- on        # Always
npm run awake -- off       # Off
```

`npm run awake` talks to the running server. If the server runs on a port other than the one in `config.json`, set `PORT`.

### Lid closed

Closing the lid puts a MacBook to sleep, whatever the mode, unless an external display and power are connected. To keep a closed MacBook awake:

```sh
npm run lid -- on       # runs sudo pmset -a disablesleep 1
npm run lid -- off      # runs sudo pmset -a disablesleep 0
npm run lid -- status
```

`on` and `off` ask for your Mac password. You can type it in a Pocket Dev terminal. While lid sleep is off, the Mac never sleeps, even in a bag. Keep it on a desk and plugged in. Amphetamine's Closed-Display Mode is another way to do this.

### macOS settings you set yourself

Pocket Dev does not change these settings. Set them in System Settings:

1. **Battery → Options → Wake for network access**: on. The phone can then reach the Mac after the display sleeps.
2. **Battery → Options → Prevent automatic sleeping on power adapter when the display is off**: optional. The When plugged in mode does the same thing while Pocket Dev runs.
3. **Battery → Optimized Battery Charging**: on. This protects the battery when the Mac stays plugged in all the time.
4. **Users & Groups → Automatically log in as**: your user. The service starts only after someone logs in. This option is not available when FileVault is on.
5. **Network → Firewall**: if macOS asks whether `node` can accept incoming connections, allow it.
6. **Lid closed**: `npm run lid -- on`, or Amphetamine's Closed-Display Mode.

## Use

- Tap **+** to open a terminal. Each terminal is a login shell (`$SHELL -l`) in your home directory.
- Type in the bottom input and tap **Send**. Send with an empty input sends Enter.
- The key bar sends Ctrl+C, Enter, Esc, Tab, the arrow keys, and Ctrl+D.
- You can also tap the terminal and type into it directly.
- Terminals keep running when the phone locks or disconnects. When the phone reconnects, the page replays the recent output.

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
- The phone loads xterm.js from cdn.jsdelivr.net, so the phone needs internet access.
