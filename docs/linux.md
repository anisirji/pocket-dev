# Install Pocket Dev on Linux

Written from the code and not yet run on a real Linux machine. If something here is wrong, please report the exact error text.

## 1. Prerequisites

- Node.js 22 or newer with npm. Distribution packages are often older, so check. With [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`. Or [NodeSource](https://github.com/nodesource/distributions), or the download at [nodejs.org](https://nodejs.org/en/download).
- Only if `node-pty` has to be built: a compiler and Python 3, for example `sudo apt install build-essential python3`.
- A phone on the same Wi-Fi as the computer.

```sh
node -v
npm -v
```

You should see `v22` or higher, then an npm version. Installing Node with nvm or fnm keeps npm's global folder in your home folder, so you never need `sudo` for npm.

## 2. Install

Keep the `@anisirji/` and the `-g`:

```sh
npm install -g @anisirji/pocket-dev
pocket-dev doctor
```

`pocket-dev doctor` checks Node, npm's global folder on PATH, the command, terminals, tools and port 7777, and prints the exact fix for each cross.

## 3. Start

```sh
pocket-dev start
```

You should see a QR code, then:

```
Pocket Dev running at http://192.168.1.20:7777
Password: Xk3p9QwR2tLm
```

The password is shown once, so copy it. Scan the QR code with the phone camera, or open the address and type the password. Missed the address? `hostname -I` prints the computer's addresses; use the Wi-Fi or LAN one. Add `--no-open` if you do not want the Admin page to open a browser (a server with no desktop).

## 4. Firewall

If a firewall is on, allow TCP port 7777 from your local network only.

```sh
# ufw (Ubuntu, Debian)
sudo ufw allow from 192.168.1.0/24 to any port 7777 proto tcp

# firewalld (Fedora, RHEL)
sudo firewall-cmd --add-port=7777/tcp --permanent && sudo firewall-cmd --reload
```

Change `192.168.1.0/24` to your own network. The firewalld command opens the port to all sources; use a rich rule if you want to limit it.

## 5. Optional tools

Chats need at least one of Claude Code or Codex. `pocket-dev setup --check` lists what is missing. `pocket-dev setup` shows each command first and prints (never runs) any command that needs `sudo`.

| Tool | Install | Log in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Git | `sudo apt install git`, `sudo dnf install git`, `sudo pacman -S git` or `sudo zypper install git` | none |
| GitHub CLI (`gh`) | `sudo apt install gh`, `sudo dnf install gh`, `sudo pacman -S github-cli`; or [install instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) | `gh auth login` |
| cloudflared (internet access only) | [download page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/); `sudo pacman -S cloudflared` on Arch | none for a Quick link |

> **Upcoming:** Google Antigravity CLI (`agy`) support, in the terminal and in Chat. It is not available yet. See the [roadmap](ROADMAP.md).

## 6. Keep it running, start at login

- Quick way: `nohup pocket-dev start --no-open > ~/pocket-dev.log 2>&1 &`
- Start at login with systemd: `pocket-dev setup --only autostart` writes the user unit `~/.config/systemd/user/dev.pocket.server.service` and enables it. The Admin page (`pocket-dev admin`, **Service**) does the same. To start before you log in, run `loginctl enable-linger $USER` once.

Coming soon: `pocket-dev service` on Linux. Today it is macOS only.

## 7. Update and uninstall

```sh
npm install -g @anisirji/pocket-dev@latest
npm uninstall -g @anisirji/pocket-dev
```

Restart Pocket Dev after updating. Settings stay in `~/.pocket-dev` until you delete that folder.

## Errors and fixes

| You see | Cause and fix |
| --- | --- |
| `unknown command 'start'. See 'main --help'`, or `EEXIST` on install | A different npm package named `pocket-dev` owns the command. `npm uninstall -g pocket-dev`, then `npm install -g @anisirji/pocket-dev`. |
| `command not found: pocket-dev` | You skipped `-g`, or the terminal predates the install. Open a new terminal. `npm config get prefix` shows npm's global folder; its `bin` must be on PATH. Or run `npx -y @anisirji/pocket-dev doctor`. |
| 404, or it installs from GitHub | Use the scoped name with the `@`: `@anisirji/pocket-dev`. |
| `EACCES` writing npm's global folder | Install Node with nvm or fnm, or run the `sudo npm install -g @anisirji/pocket-dev` you are shown. |
| `node-pty` fails to build | `sudo apt install build-essential python3`, then `pocket-dev doctor --fix`. |
| "Terminals are not available on this computer" | `pocket-dev doctor --fix`, then restart Pocket Dev. |
| The phone cannot open the address | Same Wi-Fi (not mobile data or an isolated guest network)? Port 7777 allowed in step 4? Use the numeric address from `hostname -I`, not `localhost`. Run `pocket-dev doctor`. |
| Port 7777 is in use | `pocket-dev start --port 7780`, or `pocket-dev config set port 7780`. |
| Start at login says there is no `systemctl` | Your system has no systemd. Use the `nohup` line or your init system's own service file. |
| Forgot the password | `pocket-dev setup --only password`, or `pocket-dev admin` (needs a browser on that computer). |

More: [full guide](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md), [reference](https://github.com/anisirji/pocket-dev/blob/main/docs/REFERENCE.md).
