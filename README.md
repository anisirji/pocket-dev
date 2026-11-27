# Pocket Dev

**Control your computer from your phone's browser: terminals, Claude Code and Codex chats, Git, files and open apps. Runs on your own machine, nothing to install on the phone, no cloud account.**

> **Install and start** (Node 22 or newer, on macOS, Windows or Linux):
>
> ```bash
> npm install -g @anisirji/pocket-dev
> pocket-dev start
> ```

<p align="center"><img src="https://raw.githubusercontent.com/anisirji/pocket-dev/main/docs/media/pocket-dev-demo.gif" width="760" alt="Short demo of Pocket Dev on a phone: a live terminal, a Claude Code chat and switching between computers (demo data)"></p>

[![npm](https://img.shields.io/npm/v/@anisirji/pocket-dev?color=4c8dff&label=npm)](https://www.npmjs.com/package/@anisirji/pocket-dev) ![Node 22+](https://img.shields.io/node/v/@anisirji/pocket-dev?color=4c8dff&label=node) ![macOS, Windows, Linux](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-4c8dff)

## Features

- **Terminals** on your computer that keep running when you close the page, with a compact key bar for phone keyboards and a strip that shows Claude Code's helper agents.
- **Chat with Claude Code and Codex** using your own logins, plus **Antigravity** and **GitHub Copilot** (experimental). Approval cards, permission modes and a message queue work from the phone.
- **Switch the provider and the model in the same chat.** The whole conversation goes with you.
- **One Chats list, newest first:** your Pocket Dev chats and the Claude Code, Codex, Antigravity and Copilot conversations on your computer, together.
- **Continue between computer and phone.** Open a computer conversation to read along live; send a message to continue it on the phone. **Continue on computer** takes it back.
- **Copy any chat message** with the icon under it, and see **when each message was sent**.
- **Files:** browse, upload (with **Take photo** on phones), download and zip. PDFs and text files open from Files and Messages.
- **Project workspace:** More → Workspace brings the file explorer, syntax-highlighted editor tabs, project terminals, Codex and Claude into one resizable layout. [Workspace guide](docs/GUIDE.md#project-workspace).
- **Git:** see changes, commit and push.
- **Messages** between your devices, with photos, videos and documents.
- **Open apps, health and power:** see open apps, battery, CPU and temperature, and sleep or shut down.
- **Device camera:** view your computer's camera from Settings, with camera selection, Start/Stop controls and downloadable snapshots. Uses a camera tab in the computer's browser on Windows, macOS and Linux, with no extra camera software. [Camera setup](docs/CAMERA.md).
- **Connected computers:** manage your personal computers and AI-only connections in one place, with explicit access permissions.
- **Shared Claude and Codex:** use an authorized computer’s existing AI sign-in while files, commands and approvals stay on your workspace computer. Choose its source in the existing provider selector. [Compatibility and setup](docs/UNIFIED_CONNECTIONS.md).
- **Internet access** through a Cloudflare Tunnel: optional, off by default.
- **Admin page** with a Dock, Start menu or app menu tile, and **self-update** (`pocket-dev update` or the Admin **Update** button).
- **Private by design:** runs on your own computer as your user, logs in with a password or a one-time QR code, needs no cloud account and nothing installed on the phone.
- **Set up with AI:** [copyable prompts](https://www.theani.me/work/pocket-dev/prompts) for your coding assistant, an [agent setup guide](docs/AI_SETUP.md) and a reusable agent skill.

## Coming in 3.0

Version 3.0.0 is in development and has not been published.

- **Compact Settings:** six categories, persistent desktop navigation and full-screen phone navigation.
- **Local and Remote QR:** the shared connection popup keeps Wi-Fi selected first and adds a Remote tab when Internet access is enabled, with scan, copy and open actions for either method.
- **Personal Codex browser tools:** optional browser automation with explicit consent and a separate browser profile.
- **Clear activity and notifications:** confirmed chat activity, optional completion sounds and supported opt-in browser push.
- **Screen and camera controls:** display/quality selection, snapshots, independently enabled audio and push to talk; local approval is required for Mac desktop input.
- **Guided setup:** shared capability checks, actionable setup steps and contextual help.
- **Windows fixes:** Codex transport selection and ZIP downloads with Unicode filenames and empty directories.

See [3.0 release notes](docs/RELEASE_3.0.md) for validation and remaining hardware checks. The Workspace improvements below carry forward into 3.0.

## Earlier changes in 2.5

- **Persistent Workspace:** activity bar, file explorer, editor, right-side AI conversations and bottom terminals share one project directory. Panels collapse and resize independently.
- **Recover your work:** restore editor drafts, cursor positions, tabs, layout, chats and terminal sessions. Cache-first loading and incremental file notifications keep the workspace responsive; revision checks preserve conflicting edits.
- **One folder picker:** compact navigation, recent projects per computer, a spacious desktop dialog and a full-screen phone view.
- **Dark by default:** light and system themes remain available from Workspace settings.

Details, cache behavior and validation scope: [2.5 release notes](docs/RELEASE_2.5.md) · [Workspace guide](docs/GUIDE.md#project-workspace).

## Earlier changes in 2.4

- **Connected computers:** pair your own computers or make an AI-only connection from Settings. Computer access and each shared provider have separate permissions.
- **Shared Claude and Codex:** choose an authorized source in the existing Chat selector. The source uses its existing sign-in; workspace files and approvals stay on the selected workspace computer.
- **Simpler Settings:** connection, AI, security and device controls are grouped into categories. Old Room task boards and chat mirrors are retired; saved conversations and project copies remain on disk.
- **Windows Codex startup:** npm-installed Codex starts through its actual executable, avoiding the Windows batch-launch error.

Details and platform limits: [2.4 release notes](docs/RELEASE_2.4.md) · [Connection and sharing guide](docs/UNIFIED_CONNECTIONS.md).

## Earlier changes in 2.3

- **A project workspace:** open **More → Workspace → Open folder** for a file explorer, syntax-highlighted editor tabs and project terminals in one layout. Codex and Claude have dedicated terminal controls; Chats opens your existing conversations.
- **Edit and save:** create files and folders, upload files, search filenames, and save UTF-8 text up to 1 MB. Save keeps your draft if an agent or another app changed the file on the computer.
- **Desktop and mobile:** resize panels on desktop; switch between Files, Editor and Terminal & AI on phones. Open files and layout restore after reload.
- **Windows updater coverage:** native PowerShell tests verify external handoff, retries and exit codes. Standalone updates leave unrelated service runners alone.

Details: [2.3 release notes](docs/RELEASE_2.3.md) · [Workspace guide](docs/GUIDE.md#project-workspace).

## Earlier changes in 2.2

- **2.2.1 fixes camera startup and slow feeds:** continuous browser video replaces image polling, with an automatic pushed-image fallback for restrictive networks.
- **See your computer's camera from your phone.** Open **Settings → Device camera**, choose a camera and tap **Start camera**. **Snapshot** saves a JPEG to your viewing device.
- **Browser camera capture needs no helper install.** Prepare the camera once in Admin before leaving the computer. Afterward, Start camera on the phone opens or reuses the camera tab automatically with the existing browser permission. The original FFmpeg backend remains available as an optional fallback.
- Previews require login, follow room permissions, and stop when you close or leave the view. Nothing is recorded automatically.

Details: [2.2 release notes](docs/RELEASE_2.2.md) · [Camera setup](docs/CAMERA.md).

## Earlier changes in 2.1

- **New in 2.1.2:** a **copy icon** under every chat message, the **time** on every message, **documents** (PDF and text) that open from Messages and Files, and a tidier code layout.
- **One Chats list, newest first.** Your Pocket Dev chats and recent computer conversations are mixed by when each was last active, so the conversation you are having on your computer right now sits at the top. The list refreshes by itself while open.
- **Read along, then continue.** Opening a conversation that is still open on your computer no longer closes it there. You can read along live. Sending a message continues it on the phone and closes the computer's copy gently, so Claude Code exits cleanly instead of showing an error in VS Code. **Stop** takes over at once.
- **Windows hand-over:** Pocket Dev finds and safely closes the program holding a conversation on Windows too.
- **Take photo** in the paperclip and Upload menus opens the camera directly, and **Files** opens Android's document picker.
- **Set up with AI:** copyable prompts, an agent setup guide and a reusable agent skill.

2.0 added four chat engines, provider and model switching in one chat, self-update and the Admin tile. Details: [2.1 release notes](https://github.com/anisirji/pocket-dev/blob/main/docs/RELEASE_2.1.md) · [2.0 release notes](https://github.com/anisirji/pocket-dev/blob/main/docs/RELEASE_2.0.md).

**Follow Pocket Dev:** [YouTube](https://www.youtube.com/@afk_pocket_dev) · [Instagram](https://www.instagram.com/afk_pocket_dev) · [Ani on Instagram](https://www.instagram.com/hap.pyani) · [Rohit on LinkedIn](https://www.linkedin.com/in/rohit-kumar-das-583b28223)

> [!IMPORTANT]
> **Important before you start**
>
> - You need **Node.js 22 or newer** (`node -v`).
> - Your computer and phone must be on the **same Wi-Fi**.
> - Type the package name exactly: **`@anisirji/pocket-dev`**, with the `@` and with `-g`.
> - Your computer may ask about the **firewall**. Allow it on **Private networks**.
> - A different npm package called `pocket-dev` can take over the command. If you see `unknown command 'start'` or `EEXIST`, run `npm uninstall -g pocket-dev`, then install again.
> - The first `pocket-dev start` opens a short guided setup. It asks before every change. Run it again any time with `pocket-dev setup`.
> - **Camera capture uses the computer browser:** no extra camera software is installed by default. Prepare camera permission once from **Admin → This computer → Remote camera**. Later previews start remotely from the phone.
> - **The install also adds an Admin shortcut:** `npm install -g` adds a **Pocket Dev Admin** shortcut with the Pocket Dev logo: a Dock tile on macOS, Desktop and Start menu shortcuts on Windows, an applications menu entry on Linux. Undo it with `pocket-dev admin unpin`. Skip it with `POCKET_DEV_NO_PIN=1` or `npm install -g --ignore-scripts`. `npx` and CI never add it.
>
> Step by step for your system: [Windows](https://github.com/anisirji/pocket-dev/blob/main/docs/windows.md), [macOS](https://github.com/anisirji/pocket-dev/blob/main/docs/macos.md), [Linux](https://github.com/anisirji/pocket-dev/blob/main/docs/linux.md).

## Quick start

You need [Node.js 22 or newer](https://nodejs.org) (`node -v` to check) and a phone on the same Wi-Fi.

**Want your coding assistant to set it up? [Copy the AI setup prompt](https://www.theani.me/work/pocket-dev/prompts).** Paste it into an assistant that can run commands on your own computer. The same page has a prompt for continuing your current project from your phone. [Setup details for agents](docs/AI_SETUP.md) · [Reusable agent skill](skills/pocket-dev/SKILL.md).

```bash
npm install -g @anisirji/pocket-dev
pocket-dev start
```

1. The first time, `pocket-dev start` opens the guided setup. It shows each command before it runs it and asks first. Claude Code, Codex, GitHub Copilot and the GitHub CLI are installed or logged in only if you say yes. The **Always on** step shows one list of recommended changes (start at login, Keep awake) and asks once.
2. At the end it prints an address like `http://192.168.1.25:7777` and a one-time QR code. If Pocket Dev now runs in the background, do not run `pocket-dev start` again. If you do, it says it is already running and prints a fresh QR code.
3. On your phone, scan the QR code (or open the address and type the password).

**Updating.** The guided setup starts by checking for a newer version and asks `Update now? [Y/n]` (Enter means yes), so a new install is current from the first minute. Later, `pocket-dev update` does the same, and `pocket-dev update --check` only says whether one exists. When a newer version is on npm, the phone shows an update icon beside the Settings gear and a notice every time you open Pocket Dev, and the Admin page shows an **Update** button that installs it on the computer and restarts the background service. The computer also gets a desktop notification while an update is waiting (`pocket-dev config set updateNotify false` turns that off). Installing stays on the computer: the phone only tells you.

**Privacy.** Browser camera capture needs no camera-helper download. During camera access, browsers contact Cloudflare's public STUN service to discover a direct video route; STUN does not carry video. See [Camera setup](docs/CAMERA.md) for relay behavior and custom ICE servers. Pocket Dev also checks the newest version number with one plain request to the npm registry, at most every six hours, with nothing about you or your computer in it. Turn that check off with `pocket-dev config set updateCheck false` or `POCKET_DEV_NO_UPDATE_CHECK=1`.
4. If your computer asks, allow Pocket Dev through the firewall.

The Admin page is one click away from the Dock, Start menu or applications menu (see the note above). `pocket-dev admin pin --status` shows where it is. A new login code any time: `pocket-dev qr`. The guide again: `pocket-dev setup`. Scripts and CI never get a question: without a terminal, `pocket-dev start` prints the status and the command, then starts. `--no-setup` (or `POCKET_DEV_NO_SETUP=1`) skips the guide.

Just trying it? `npx -y @anisirji/pocket-dev start` runs it once and installs nothing.

## If something goes wrong

| You see | Do this |
| --- | --- |
| `unknown command 'start'. See 'main --help'` or `EEXIST ... pocket-dev.cmd` | A different npm package, `pocket-dev`, owns the command. Run `npm uninstall -g pocket-dev`, then `npm install -g @anisirji/pocket-dev` again. |
| Windows: `npm error code EBUSY` ... `rename` after **Update** | Before 2.1.4, Update ran npm while Pocket Dev still used its files. Stop Pocket Dev, then install: see [Update on Windows](docs/windows.md#7-update-and-uninstall). From 2.1.4 on, Update stops and restarts Pocket Dev by itself. |
| `pocket-dev` is not recognised after installing | Close the terminal and open a new one. |
| Install fails on `node-pty` | Run `pocket-dev doctor --fix`. On macOS run `xcode-select --install` first. |
| `Version X is available` (update icon on the phone, banner on the Admin page) | Tap **Update** on the Admin page on your computer, or run `pocket-dev update` in a terminal there. |
| The phone cannot open the address | Same Wi-Fi? Firewall allowed? Port busy? Run `pocket-dev doctor`. |

More fixes: [Troubleshooting](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md#troubleshooting).

## Docs

- [Set up with AI](https://www.theani.me/work/pocket-dev/prompts): copyable setup and project prompts, with an [agent setup guide](docs/AI_SETUP.md).
- Install, one page per system: [Windows](https://github.com/anisirji/pocket-dev/blob/main/docs/windows.md), [macOS](https://github.com/anisirji/pocket-dev/blob/main/docs/macos.md), [Linux](https://github.com/anisirji/pocket-dev/blob/main/docs/linux.md).
- [Beginner install guide](https://github.com/anisirji/pocket-dev/blob/main/docs/INSTALL_BEGINNERS.md): with pictures, for Windows, Mac and Linux.
- [Full guide](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md): commands, configuration, rooms, internet access, security, limitations.
- [Guided setup](https://github.com/anisirji/pocket-dev/blob/main/docs/SETUP.md) and [reference](https://github.com/anisirji/pocket-dev/blob/main/docs/REFERENCE.md).


## Community and support

- **Ask a question or share a tip:** [GitHub Discussions](https://github.com/anisirji/pocket-dev/discussions)
- **Report a bug:** [open an issue](https://github.com/anisirji/pocket-dev/issues/new/choose) and paste the output of `pocket-dev doctor`
- **Source code:** [github.com/anisirji/pocket-dev](https://github.com/anisirji/pocket-dev)

## Follow along

- **YouTube:** [@afk_pocket_dev](https://www.youtube.com/@afk_pocket_dev)
- **Instagram:** [@afk_pocket_dev](https://www.instagram.com/afk_pocket_dev)
- **Ani on Instagram:** [@hap.pyani](https://www.instagram.com/hap.pyani)
- **Rohit Kumar Das on LinkedIn:** [rohit-kumar-das](https://www.linkedin.com/in/rohit-kumar-das-583b28223), building Pocket Dev with Ani

## A little more freedom

I built Pocket Dev because I wanted us to spend less time tied to a desk and more time living, without losing touch with our work.

If it makes your day a little freer, share it with **three people you’d love to see escape the PC cage too.** If they find it useful, invite them to share it with three more.

No pressure. Just something useful, passed from one person to another. ❤️

[Let your AI help you set it up](https://www.theani.me/work/pocket-dev/prompts)

Made by [anisirji](https://theani.me). Licence: ISC. If you use or build on this code, keep the copyright notice in `LICENSE` and please credit and link [theani.me](https://theani.me).
