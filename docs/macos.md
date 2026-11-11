# Install Pocket Dev on macOS

Run the commands in Terminal (Cmd+Space, type Terminal, Enter).

## 1. Prerequisites

- Node.js 22 or newer. With [Homebrew](https://brew.sh): `brew install node`. Or the LTS installer from [nodejs.org](https://nodejs.org/en/download).
- A phone on the same Wi-Fi as the Mac.

```sh
node -v
npm -v
```

You should see `v22` or higher, then an npm version.

## 2. Install

Keep the `@anisirji/` and the `-g`:

```sh
npm install -g @anisirji/pocket-dev
pocket-dev doctor
```

If the install fails while building `node-pty`, run `xcode-select --install` once, then repeat. `pocket-dev doctor` checks Node, npm's global folder on PATH, the command, terminals, tools and port 7777, and prints the exact fix for each cross.

## 3. Start

```sh
pocket-dev start
```

You should see a QR code, then:

```
Pocket Dev running at http://192.168.1.20:7777
Password: Xk3p9QwR2tLm
```

The password is shown once, so copy it. The Admin page opens in the Mac's browser (add `--no-open` to stop that). On your phone, scan the QR code with the camera, or open the address and type the password. Missed the address? `ipconfig getifaddr en0` prints it (try `en1` if `en0` prints nothing).

## 4. Firewall and permissions

- If macOS asks whether `node` may accept incoming connections, choose **Allow**. If you chose Deny, open System Settings, Network, Firewall, Options, and allow `node`.
- Screen view needs Screen Recording permission for the program that runs Pocket Dev (Terminal, VS Code, or `node` for the background service). `pocket-dev admin`, Permissions panel, opens the right page. Without it the screen view shows only the wallpaper.

## 5. Optional tools

Chats need at least one of Claude Code or Codex. `pocket-dev setup --check` lists what is missing; `pocket-dev setup` shows each command before running it.

| Tool | Install | Log in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Git | `brew install git`, or `xcode-select --install` | none |
| GitHub CLI (`gh`) | `brew install gh` | `gh auth login` |
| cloudflared (internet access only) | `brew install cloudflared` | none for a Quick link |

> **Upcoming:** Google Antigravity CLI (`agy`) support, in the terminal and in Chat. It is not available yet. See the [roadmap](ROADMAP.md).

## 6. Keep it running, start at login

```sh
pocket-dev service install
pocket-dev service status
```

This installs a launchd agent (`~/Library/LaunchAgents/dev.pocket.server.plist`) that starts at login. Other commands: `service restart`, `service logs`, `service uninstall`, `service autostart on|off|status`.

## 7. Update and uninstall

```sh
npm install -g @anisirji/pocket-dev@latest
pocket-dev service restart
```

```sh
pocket-dev service uninstall
npm uninstall -g @anisirji/pocket-dev
```

Settings stay in `~/.pocket-dev` until you delete that folder.

## Errors and fixes

| You see | Cause and fix |
| --- | --- |
| `unknown command 'start'. See 'main --help'`, or `EEXIST` on install | A different npm package named `pocket-dev` owns the command. `npm uninstall -g pocket-dev`, then `npm install -g @anisirji/pocket-dev`. |
| `command not found: pocket-dev` | You skipped `-g`, or the terminal predates the install. Open a new terminal. `npm config get prefix` shows npm's global folder; its `bin` must be on PATH. Or run `npx -y @anisirji/pocket-dev doctor`. |
| 404, or it installs from GitHub | Use the scoped name with the `@`: `@anisirji/pocket-dev`. |
| `EACCES` writing npm's global folder | Do not use `sudo`. Install Node with Homebrew, nvm or fnm so npm writes to your home folder. |
| `node-pty` fails to build | `xcode-select --install`, then `pocket-dev doctor --fix`. |
| "Terminals are not available on this computer" | `pocket-dev doctor --fix`, then restart Pocket Dev. |
| The phone cannot open the address | Same Wi-Fi (not mobile data or an isolated guest network)? `node` allowed in the firewall? Use the numeric address, not `localhost`. Run `pocket-dev doctor`. |
| Port 7777 is in use | `pocket-dev start --port 7780`, or `pocket-dev config set port 7780`. A stray copy: `pocket-dev service install --force` takes the port over. |
| Forgot the password | `pocket-dev admin`, then **Password**. |
| Screen view shows only the wallpaper | Allow Screen Recording, see step 4. |

More: [full guide](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md), [reference](https://github.com/anisirji/pocket-dev/blob/main/docs/REFERENCE.md).
