# Pocket Dev: access and permissions at a glance

Pocket Dev is a small Node server on your Mac. You open it in your phone's browser and get your Mac's terminals, Claude/Codex chats, Git, apps and power controls.

## How it works

```
Phone browser ──Wi-Fi──► Mac :7777  Pocket Dev (node server.js, runs as user "ani")
                                    ├─ Terminals: real zsh shells (node-pty)
                                    ├─ Chat: Claude Agent SDK / codex app-server
                                    ├─ Git: git + gh commands in your repos
                                    ├─ Resume: reads ~/.claude and ~/.codex history
                                    ├─ Apps / Power: osascript, pmset, caffeinate
                                    └─ Ports: forwards localhost:3000 → <Mac IP>:3000
```

- Same Wi-Fi only for now. Internet access comes later through Cloudflare Tunnel.
- Traffic between the phone and the Mac is plain `http` on your Wi-Fi.

## What access Pocket Dev has

It runs as **your user account**, not as admin. Anything you can do in Terminal, a logged-in device can do:

| Access | Why |
|---|---|
| Full shell as `ani`: read, write and delete your files, run any command | Terminals |
| Your Claude Code and Codex logins | Chat, and `claude` / `codex` in terminals |
| Your GitHub CLI login (`anisirji`, scopes `repo`, `workflow`, `delete_repo`, `gist`, `read:org`) | Git tab: PRs, review, merge, push |
| Read `~/.claude/projects` and `~/.codex/sessions` | Resume list |
| Keep the Mac awake (`caffeinate`, no admin) | Stay-awake modes |
| Sleep (`pmset sleepnow`) and normal shutdown (System Events) | Power buttons |
| Quit and force-quit your apps (System Events, `kill`) | Open apps |

**Admin (`sudo`) is never stored or automated.** The lid-closed switch and force shutdown open a terminal, and **you type your Mac password** each time.

## What was changed on this Mac

| Change | Where | Undo |
|---|---|---|
| Login service that starts Pocket Dev and restarts it after a crash | `~/Library/LaunchAgents/dev.pocket.server.plist` | `npm run service:uninstall` |
| Settings, password hash, device limit, shortcuts, folders | `pocket-dev/config.json` | delete the file (a new password is generated) |
| Logged-in devices (hashed), local secret, uploads, chat logs | `~/.pocket-dev/` | `rm -rf ~/.pocket-dev` (logs every device out) |
| Log | `~/Library/Logs/pocket-dev.log` | delete the file |
| **VS Code tunnel** (installed at the start, not used by Pocket Dev, still running) | VS Code tunnel service, signed in with GitHub | `code tunnel service uninstall` |

No system settings were changed by Claude.

## Settings you turn on yourself (optional)

| Setting | Where | Needed for |
|---|---|---|
| Wake for network access | System Settings → Battery → Options | Reaching the Mac when the display is off |
| Optimized Battery Charging | System Settings → Battery | Protects the battery when always plugged in |
| Allow node → System Events | Popup on first use, or Privacy & Security → Automation | Normal shutdown, Quit app |
| Allow node | Privacy & Security → Accessibility | Window and file names in Open apps |
| Allow incoming connections for node | Firewall popup on first run | Phone can connect |
| Lid closed stays awake | `npm run lid -- on` (asks your password) | Using the Mac with the lid closed |
| Automatic login | Users & Groups (not available with FileVault on) | Pocket Dev starting after a reboot without you |

## Who can get in

- **Login:** your password, or the QR code (one use, expires in 10 minutes).
- **Device limit:** 2 by default. See devices and log them out in Settings.
- **Not protected:** forwarded ports like `:3000`. Anyone on the same Wi-Fi can open them while they are forwarded.

## Daily workflow

1. On the Mac, run `npm run qr` (or look at the startup output) and scan the code with your phone.
2. Work from the phone: Terminal, Chat, Git, Resume a laptop conversation, open ports to preview your app.
3. Leaving with the lid closed: with the lid **open**, turn on Lid closed (password), plug in, then close the lid.
4. Back at the Mac: open the lid and turn Lid closed off.
5. Done for the day: use **Sleep** or **Shut down** from Settings → Power.

## Turn everything off

```sh
npm run service:uninstall        # stop Pocket Dev and remove the login service
sudo pmset -a disablesleep 0     # if you turned Lid closed on
code tunnel service uninstall    # remove the VS Code tunnel
rm -rf ~/.pocket-dev             # remove devices, uploads and chat logs
```

Then remove `node` from Privacy & Security → Automation and Accessibility if you granted them.
