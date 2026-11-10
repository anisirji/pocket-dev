# Pocket Dev

<p align="center"><img src="https://unpkg.com/@anisirji/pocket-dev@1.1.1/docs/screenshots/hero.png" width="760" alt="Pocket Dev on a phone: terminal, Git, Files and Chat controlling a computer"></p>

**Control your computer from your phone's browser: terminals, Claude Code and Codex chats, Git, files and open apps. Runs on your own machine, nothing to install on the phone, no cloud account.**

[![npm](https://img.shields.io/npm/v/@anisirji/pocket-dev?color=4c8dff&label=npm)](https://www.npmjs.com/package/@anisirji/pocket-dev) ![Node 22+](https://img.shields.io/node/v/@anisirji/pocket-dev?color=4c8dff&label=node) ![macOS, Windows, Linux](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-4c8dff)

> [!IMPORTANT]
> **Important before you start**
>
> - You need **Node.js 22 or newer** (`node -v`).
> - Your computer and phone must be on the **same Wi-Fi**.
> - Type the package name exactly: **`@anisirji/pocket-dev`**, with the `@` and with `-g`.
> - Your computer may ask about the **firewall**. Allow it on **Private networks**.
> - A different npm package called `pocket-dev` can take over the command. If you see `unknown command 'start'` or `EEXIST`, run `npm uninstall -g pocket-dev`, then install again.
> - `pocket-dev setup` is optional. It adds Claude Code, Codex, Git and the rest.
>
> Step by step for your system: [Windows](https://github.com/anisirji/pocket-dev/blob/main/docs/windows.md), [macOS](https://github.com/anisirji/pocket-dev/blob/main/docs/macos.md), [Linux](https://github.com/anisirji/pocket-dev/blob/main/docs/linux.md).

## Quick start

You need [Node.js 22 or newer](https://nodejs.org) (`node -v` to check) and a phone on the same Wi-Fi.

```
npm install -g @anisirji/pocket-dev
pocket-dev start
```

1. `pocket-dev start` prints an address like `http://192.168.1.25:7777`, a one-time password and a QR code.
2. On your phone, scan the QR code (or open the address and type the password).
3. If your computer asks, allow Pocket Dev through the firewall.

Just trying it? `npx -y @anisirji/pocket-dev start` runs it once and installs nothing.

**Optional:** `pocket-dev setup` installs and checks Claude Code, Codex, Git and `cloudflared` (it shows each command first), then helps you set a password and start at login.

## If something goes wrong

| You see | Do this |
| --- | --- |
| `unknown command 'start'. See 'main --help'` or `EEXIST ... pocket-dev.cmd` | A different npm package, `pocket-dev`, owns the command. Run `npm uninstall -g pocket-dev`, then `npm install -g @anisirji/pocket-dev` again. |
| `pocket-dev` is not recognised after installing | Close the terminal and open a new one. |
| Install fails on `node-pty` | Run `pocket-dev doctor --fix`. On macOS run `xcode-select --install` first. |
| The phone cannot open the address | Same Wi-Fi? Firewall allowed? Port busy? Run `pocket-dev doctor`. |

More fixes: [Troubleshooting](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md#troubleshooting).

## What you get

- **Terminals** that keep running when you close the page.
- **Chat** with your own Claude Code and Codex logins.
- **Git** and **Files** on the computer where your work is.
- **Open apps, health and power** controls.
- **Several computers, one phone**, with per-device permissions.
- **Internet access** is optional and off by default.

## Docs

- Install, one page per system: [Windows](https://github.com/anisirji/pocket-dev/blob/main/docs/windows.md), [macOS](https://github.com/anisirji/pocket-dev/blob/main/docs/macos.md), [Linux](https://github.com/anisirji/pocket-dev/blob/main/docs/linux.md).
- [Beginner install guide](https://github.com/anisirji/pocket-dev/blob/main/docs/INSTALL_BEGINNERS.md): with pictures, for Windows, Mac and Linux.
- [Full guide](https://github.com/anisirji/pocket-dev/blob/main/docs/GUIDE.md): commands, configuration, rooms, internet access, security, limitations.
- [Guided setup](https://github.com/anisirji/pocket-dev/blob/main/docs/SETUP.md) and [reference](https://github.com/anisirji/pocket-dev/blob/main/docs/REFERENCE.md).


## Community and support

- **Ask a question or share a tip:** [GitHub Discussions](https://github.com/anisirji/pocket-dev/discussions)
- **Report a bug:** [open an issue](https://github.com/anisirji/pocket-dev/issues/new/choose) and paste the output of `pocket-dev doctor`
- **Source code:** [github.com/anisirji/pocket-dev](https://github.com/anisirji/pocket-dev)

Licence: ISC.
