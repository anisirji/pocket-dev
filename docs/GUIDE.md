# The Pocket Dev guide

This guide explains everything Pocket Dev does on your Mac. It covers each feature, every permission, every file it writes, the network, and the limits. It is written for you, the owner of the Mac.

This guide describes the merged program. For release validation and limits, see [VALIDATION.md](VALIDATION.md). Internet access, HTTPS, passkeys, and Android Share integration remain planned.

## Contents

- [1. What Pocket Dev is](#1-what-pocket-dev-is)
  - [1.1 The big picture](#11-the-big-picture)
  - [1.2 What runs where](#12-what-runs-where)
  - [1.3 What "same Wi-Fi" means](#13-what-same-wi-fi-means)
  - [1.4 Why the address changes](#14-why-the-address-changes)
- [2. Getting started](#2-getting-started)
  - [2.1 What you need](#21-what-you-need)
  - [2.2 Install once](#22-install-once)
  - [2.3 Start it](#23-start-it)
  - [2.4 Log in on the phone](#24-log-in-on-the-phone)
- [3. The daily routine](#3-the-daily-routine)
  - [3.1 Start the day](#31-start-the-day)
  - [3.2 Work from the phone](#32-work-from-the-phone)
  - [3.3 Leave the Mac with the lid closed](#33-leave-the-mac-with-the-lid-closed)
  - [3.4 Come back to the Mac](#34-come-back-to-the-mac)
  - [3.5 End the day](#35-end-the-day)
  - [3.6 Turn it all off](#36-turn-it-all-off)
- [4. The features](#4-the-features)
  - [4.1 Terminal](#41-terminal)
  - [4.2 Ports](#42-ports)
  - [4.3 Git](#43-git)
  - [4.4 Resume](#44-resume)
  - [4.5 Chat](#45-chat)
  - [4.6 Files](#46-files)
  - [4.7 Open apps](#47-open-apps)
  - [4.8 Power](#48-power)
  - [4.9 Login and security](#49-login-and-security)
  - [4.10 The background service](#410-the-background-service)
  - [4.11 The settings in config.json](#411-the-settings-in-configjson)
- [5. Access and permissions](#5-access-and-permissions)
  - [5.1 Who Pocket Dev runs as](#51-who-pocket-dev-runs-as)
  - [5.2 Everything Pocket Dev can do](#52-everything-pocket-dev-can-do)
  - [5.3 macOS permissions](#53-macos-permissions)
  - [5.4 What changed on the Mac](#54-what-changed-on-the-mac)
  - [5.5 Settings you set yourself](#55-settings-you-set-yourself)
  - [5.6 The leftover VS Code tunnel](#56-the-leftover-vs-code-tunnel)
  - [5.7 Undo everything](#57-undo-everything)
- [6. Network and security in plain words](#6-network-and-security-in-plain-words)
  - [6.1 Plain http on the Wi-Fi](#61-plain-http-on-the-wi-fi)
  - [6.2 Ports and addresses](#62-ports-and-addresses)
  - [6.3 What someone on the same Wi-Fi can and cannot do](#63-what-someone-on-the-same-wi-fi-can-and-cannot-do)
  - [6.4 What the protections stop](#64-what-the-protections-stop)
  - [6.5 What the protections do not stop](#65-what-the-protections-do-not-stop)
- [7. Memory, CPU, and battery](#7-memory-cpu-and-battery)
- [8. Troubleshooting](#8-troubleshooting)
  - [8.1 The phone cannot connect](#81-the-phone-cannot-connect)
  - [8.2 The QR code says it expired](#82-the-qr-code-says-it-expired)
  - [8.3 Device limit reached](#83-device-limit-reached)
  - [8.4 This device is blocked](#84-this-device-is-blocked-being-finished)
  - [8.5 The terminal output looks scrambled](#85-the-terminal-output-looks-scrambled)
  - [8.6 File names show as `???`](#86-file-names-show-as-)
  - [8.7 Permission errors](#87-permission-errors)
  - [8.8 Shutdown was blocked](#88-shutdown-was-blocked)
  - [8.9 The Lid closed switch is locked](#89-the-lid-closed-switch-is-locked)
  - [8.10 Forgot the password](#810-forgot-the-password)
  - [8.11 Resume says "open on laptop?"](#811-resume-says-open-on-laptop)
  - [8.12 Commands for status and logs](#812-commands-for-status-and-logs)
- [9. What Pocket Dev does not do](#9-what-pocket-dev-does-not-do)
- [10. Glossary](#10-glossary)
- [11. Planned next](#11-planned-next)

## 1. What Pocket Dev is

Pocket Dev is a small program that runs on your Mac. It lets you use the Mac from your phone's web browser. From the phone you can:

- Open real terminals on the Mac and run any command.
- Talk to Claude Code and Codex.
- See your Git history and work with GitHub pull requests.
- Browse, upload, and download your files.
- See your open apps and quit them.
- Keep the Mac awake, put it to sleep, or shut it down.

You do not install an app on the phone. The phone only needs a web browser, for example Chrome.

### 1.1 The big picture

```
  Your phone (Android, Chrome)                Your Mac (MacBook Air, user "ani")
  +-------------------------+                 +----------------------------------------+
  | Web page from the Mac   |                 | Pocket Dev server (Node.js)            |
  |                         |   JioFiber      |   listens on port 7777                 |
  | Terminal, Git, Chat,    | <-- Wi-Fi --->  |                                        |
  | Files, Apps, Power,     |   plain http    |   +-- Terminals: real zsh shells       |
  | Settings                |                 |   +-- Chat: Claude and Codex engines   |
  +-------------------------+                 |   +-- Git: git and gh commands         |
                                              |   +-- Resume: reads ~/.claude, ~/.codex|
                                              |   +-- Files: your home folder          |
                                              |   +-- Apps and Power: macOS commands   |
                                              |   +-- Ports: forwards localhost:3000   |
                                              |   +-- Admin page: localhost:7778,      |
                                              |       only on the Mac                  |
                                              +----------------------------------------+
```

### 1.2 What runs where

Almost everything runs on the Mac.

- **On the Mac.** The Pocket Dev server is one Node.js program (`node server.js`). It runs as your normal user `ani`. It starts the shells, runs `git` and `gh`, talks to Claude and Codex, and reads and writes your files. Everything the phone asks for happens on the Mac.
- **On the phone.** The phone shows a web page that the Mac sends. The page draws the terminal, the buttons, and the lists. It stores almost nothing. It keeps a login cookie and a few small display choices, for example the last tab you used.

A terminal keeps running on the Mac when you lock the phone, close the browser, or lose Wi-Fi. When the phone comes back, the page connects again and shows the recent output.

The phone page loads one outside file, the terminal display library xterm.js, from `cdn.jsdelivr.net`. So the phone needs normal internet access, not only the home Wi-Fi.

### 1.3 What "same Wi-Fi" means

Today Pocket Dev works only when the phone and the Mac are on the same network. At home, that means both are connected to your JioFiber Wi-Fi.

Your Wi-Fi router gives each device a private address on the home network, for example `192.168.29.17`. This is called the **LAN IP** (LAN means local area network). The phone reaches the Mac at `http://<LAN IP>:7777`. These private addresses only work inside the home network. From mobile data, or from another Wi-Fi, the phone cannot reach the Mac.

Internet access from anywhere is planned but not built. See [11. Planned next](#11-planned-next).

### 1.4 Why the address changes

The router chooses the LAN IP. It can give the Mac a different address after a router restart, after the Mac was away for a while, or when the Mac joins another network. Then the old link on the phone stops working.

Pocket Dev checks the Mac's address every 10 seconds. When it changes, Pocket Dev writes a line to its log, for example `LAN address changed from 192.168.29.17 to 192.168.29.23. Pocket Dev is now at http://192.168.29.23:7777`. It also moves your port forwards to the new address.

To find the new address:

- On the Mac, run `npm run qr`. It prints a new QR code with the current address.
- On the Mac, run `npm run service:status`. It prints the phone URL.
- A logged-in phone shows the current address in **Settings**.

Pocket Dev also prints a second address that ends in `.local`, for example `http://anikets-macbook-air.local:7777`. This name keeps working when the IP changes, but only on the same Wi-Fi. Some Android phones cannot open `.local` names.

If your router supports DHCP reservations, you can reserve an address for the Mac in its settings. This is called a DHCP reservation. Pocket Dev does not do this for you.

## 2. Getting started

### 2.1 What you need

| Thing | Why |
| --- | --- |
| macOS (your Mac has macOS 14.5) | Pocket Dev uses macOS commands such as `pmset`, `caffeinate`, and `osascript`. |
| Node.js 22 (`node -v` shows `v22.17.1` on your Mac) | Runs the server. |
| Xcode Command Line Tools | Needed to build `node-pty`, the part that creates real terminals. |
| `claude`, `codex`, `gh` (optional) | Claude Code, Codex, and the GitHub CLI. Each feature that needs one shows an error when it is missing. |

### 2.2 Install once

In the `pocket-dev` folder on the Mac, run:

```sh
npm install
```

This downloads the parts Pocket Dev needs into `node_modules`. A small extra step marks one file of `node-pty` (`spawn-helper`) as a program that can run. Version 1.1.0 of `node-pty` ships it without that mark.

### 2.3 Start it

There are two ways to start Pocket Dev.

**By hand.** Run `npm start`. The server runs while that Terminal window stays open. To stop it, press Ctrl+C in that window.

**As a service (recommended).** Run `npm run service:install`. macOS then starts Pocket Dev every time you log in to the Mac, and starts it again if it crashes. You do not need a Terminal window. See [4.10 The background service](#410-the-background-service).

When the server starts, it prints:

```
<QR code>
Pocket Dev running at http://192.168.29.17:7777
Also at http://anikets-macbook-air.local:7777 (same Wi-Fi only; some Android phones cannot open .local names)
Password: (set; change it in Settings)
Scan the QR code to log in without the password. It works once and expires in 10 minutes. New code: npm run qr
```

If phone access is off (see [Connect and Disconnect](#connect-and-disconnect-being-finished)), the server prints `Phone access is off. Press Connect on the admin page to let your phone in.` instead of the QR code and address. It always prints `Admin (this Mac only): http://localhost:7778`.

On the very first start there is no password yet. Pocket Dev makes a random password and prints it once, on the `Password:` line. Write it down. Pocket Dev never prints it again, because it stores only a scrambled form of it (a hash). You can change it later in **Settings**.

### 2.4 Log in on the phone

1. On the Mac, run `npm run qr`. A QR code appears in the Terminal.
2. Open the phone camera and point it at the QR code.
3. Tap the link. It opens Pocket Dev in Chrome, and you are logged in.

The QR code works once and expires after 10 minutes. You can also open the address on the phone and type the password.

The phone stays logged in for one year, also after the Mac restarts. You log in again only when you log the phone out, clear the browser data, or change the password with **Log out all other devices**.

## 3. The daily routine

### 3.1 Start the day

1. Open the Mac lid and log in to the Mac. If the service is installed, Pocket Dev starts by itself.
2. On the phone, open the Pocket Dev page (a bookmark is easiest).
3. If the page does not load, the address may have changed. Run `npm run qr` on the Mac and scan the new code.

### 3.2 Work from the phone

- Tap **+** to open a terminal in a project folder.
- Run `claude` or `codex` in it, or use the Chat screen.
- Open the Git view to check commits and pull requests.
- Open a port to see your web app, for example on port 3000.

### 3.3 Leave the Mac with the lid closed

A closed MacBook lid normally puts the Mac to sleep. A sleeping Mac cannot answer the phone. To keep the Mac working with the lid closed:

1. Keep the lid **open**.
2. Plug in the charger.
3. On the phone, open **Settings** and tap **Lid closed** in the Power controls. Type your Mac password in the terminal that opens.
4. Close the lid.

The switch refuses to change while the lid is closed. See [4.8 Power](#48-power).

### 3.4 Come back to the Mac

1. Open the lid.
2. Turn **Lid closed** off, so the Mac sleeps normally again when you close it.

### 3.5 End the day

- **Sleep.** Tap **Put Mac to sleep** in the Power controls in **Settings**. The phone loses the connection until you wake the Mac.
- **Shut down.** Tap **Shut down Mac** in the same place. Pocket Dev stops with the Mac.

### 3.6 Turn it all off

To stop Pocket Dev and remove everything it added, see [5.7 Undo everything](#57-undo-everything).

## 4. The features

### 4.1 Terminal

**What it does.** A terminal in Pocket Dev is a real shell on the Mac. It is the same as a window in the Terminal app. You can run any command, for example `ls`, `git pull`, `npm run dev`, `claude`, or `codex`.

**How it works.** The server uses a part called `node-pty` to start a **pty** (a "pseudo-terminal", a fake keyboard and screen that programs think is a real terminal). In the pty it starts your login shell, `zsh -l`. A login shell reads `~/.zprofile` and `~/.zshrc`, so your usual setup applies. The server sends everything the shell prints to the phone over a **WebSocket** (a connection that stays open so both sides can send at any time). What you type goes back the same way.

#### Open a terminal and pick a folder

1. Tap **+** in the top bar. The **New terminal** sheet opens.
2. Tap a folder. A terminal opens in that folder.

The sheet lists folders in this order:

| Section | What it lists |
| --- | --- |
| Home | Always first. Your home folder, `/Users/ani`. |
| Pinned | Folders you pinned with the star (☆). Tap ★ to unpin. |
| Recent | The last 5 folders you opened. Home is never added here. |
| Projects | Every folder directly inside `~/Desktop` and `~/Desktop/Projects` that has a `.git` folder or a `package.json` file. Sorted by name. |

A folder shows only once, in the first section it belongs to. Folders that no longer exist are not shown.

To open any other folder, type its path in the **Other path** field, for example `~/code/app`, and tap **Open**. A path that is not a folder gives the error `Not a folder: <path>`.

Pinned and recent folders are saved in `config.json` as `folders` and `recentFolders`.

When you open the page and no terminal exists, the page opens one in your home folder.

#### Tab names

Each tab is named after its folder, for example `app`. Home is `~`. A second terminal in the same folder is `app 2`, a third is `app 3`. When you close `app 2`, the next new one is `app 2` again. A terminal from Resume is named `claude · app` or `codex · app`, with the same numbers.

When the shell ends (for example you typed `exit`), the tab shows `[process exited 0]` and turns grey.

#### Close a terminal

Tap ✕ on the tab. Pocket Dev asks `Close <name>? Anything running in it will be killed.` If you confirm, the server stops the shell and every program in it. If it was the last tab, Pocket Dev opens a new terminal in your home folder.

#### Type and send

The input field at the bottom says **Type a command**.

- Type a command and tap **Send**. Pocket Dev sends the text, then sends Enter 30 milliseconds later. The short wait helps programs like Claude Code see a real Enter, not a pasted line break.
- Tap **Send** with an empty field to send only Enter.
- After **Send**, the phone keyboard closes and the terminal jumps to the newest output.
- The field turns off autocorrect, auto-capital letters, and spell check, so commands stay exactly as you type them.

You can also tap the terminal itself and type into it directly. Then every key goes to the shell at once.

#### The key bar

Below the input there is a row of keys. Swipe it sideways to see all of them.

| Key | What it sends |
| --- | --- |
| ⚡ | Opens **Shortcuts**. |
| 📋 | Opens the copy view. |
| Ctrl+C | Stops the running program (interrupt). |
| Enter | Enter. This key also closes the phone keyboard. |
| Esc | Escape. Claude Code uses it to stop a reply. |
| Tab | Tab, for example to complete a file name. |
| ↑ ↓ ← → | Arrow keys. ↑ shows your previous command. |
| Ctrl+D | End of input. In an empty shell it closes the shell. |

The keys do not close the phone keyboard, except Enter. The arrow keys send the same code a real keyboard sends, also in full-screen programs such as `vim` or `less`.

#### Scroll and "↓ latest"

Drag up and down on the terminal to scroll. A quick swipe keeps scrolling for a moment. The phone keeps the last 5,000 lines of each terminal.

When you scroll up, a **↓ latest** button appears at the bottom right. Tap it to jump back to the newest output.

#### Reconnect

If the connection drops, a small badge shows **reconnecting…** (or **connecting…** for a new tab). The page tries again every 2 seconds. When it connects, it clears the screen and replays the recent output from the Mac.

The Mac keeps about 500 KB of recent output for each terminal for this replay. The server also checks every 30 seconds that each phone connection is still alive. It closes dead connections, for example from a phone that went to sleep.

#### Several pages on one terminal

You can open the same terminal from two places, for example the phone and a browser tab on the Mac. Both see the same output. A terminal has one size (columns and rows). The page that types last decides the size. When you type on the phone, the terminal changes to the phone's size. The other page may then show lines that wrap in odd places until it types again.

Pocket Dev does not send a size from the Git view or from a hidden browser tab, because those sizes are wrong.

#### Copy output

Phone terminals are hard to select text in. Tap **📋** to open a plain-text view of the last 300 lines.

- Tap **Copy all** to copy all 300 lines. The title changes to **Copied**.
- If copying fails, the title says **Long-press to select**. Then long-press the text and select part of it by hand.

Long lines that wrapped on screen are joined back into one line, so long commands and links copy in one piece.

On plain `http`, Chrome blocks the modern clipboard function. Pocket Dev then uses an older copy method that still works.

#### Upload files and screenshots

You can send a file from the phone to the Mac and put its path into the command.

1. Tap **📎** and pick one or more files or screenshots. Or paste an image into the input field.
2. Pocket Dev uploads each file. The bottom left shows `Uploading <name> 45%`.
3. When the upload ends, Pocket Dev adds the file's path to the input field, for example `/Users/ani/.pocket-dev/uploads/20261107-142301-Screenshot.png`.
4. Pocket Dev does not press Enter. You finish the command, for example `claude "look at this screenshot"` and the path, and tap **Send**.

Details:

- Files go to `~/.pocket-dev/uploads`. Only your user can read the folder and the files (folder mode `700`, file mode `600`).
- The file name starts with the date and time, for example `20261107-142301-`. Spaces become `-`. If two files arrive in the same second with the same name, the second gets `-2-`. Pocket Dev never overwrites a file.
- The limit is 25 MB for each file. A larger file shows `larger than 25 MB` or `File is larger than 25 MB`.
- Pocket Dev never deletes old uploads. Clear `~/.pocket-dev/uploads` yourself now and then.

#### Shortcuts ⚡

Shortcuts are saved commands that you run with one tap.

- Tap **⚡**, then tap a command. Pocket Dev runs it in the current terminal, the same as typing it and tapping **Send**.
- Tap **Edit** to change the list. Then you can add a command, move it up (↑) or down (↓), or delete it (✕). Tap **Done** when finished.
- The first list is `claude`, `codex`, `npm run dev`, `git status`, and `git pull`.
- You can save up to 30 shortcuts. Each one is one line of 1 to 200 characters.
- Shortcuts are saved in `config.json` as `shortcuts`.

#### What the terminal does not do

- Terminals do not survive a restart of Pocket Dev. A restart closes every shell and every program in it. Your logins stay.
- It is not `ssh`. Only the Pocket Dev page can use it.
- It does not run as administrator. A command that needs `sudo` asks for your Mac password in the terminal, and you type it there.

### 4.2 Ports

**What it does.** When you build a website, you run a dev server on the Mac, for example `npm run dev`. It usually listens on `localhost:3000`. **localhost** means "this same computer". So the phone cannot open it. Ports fixes this. It makes `http://<Mac LAN IP>:3000` on the Wi-Fi lead to `localhost:3000` on the Mac.

**How to use it.**

1. Start your dev server on the Mac, for example `npm run dev` in a terminal.
2. Tap the globe icon (**Ports**) in the top bar. A row opens.
3. Type `3000` and tap **Open**. The globe icon shows how many ports are open.
4. Tap the `:3000` chip. Your site opens in a new browser tab.
5. To stop it, tap ✕ on the chip.

**How it works.** Pocket Dev listens on the Mac's LAN IP at the same port number. Each connection that arrives there is passed through, byte by byte, to `localhost:3000`. It first tries `127.0.0.1` (the IPv4 localhost) and then `::1` (the IPv6 localhost), because dev tools differ. This is a raw pipe, so live reload (HMR, which uses WebSockets) works too.

**When the IP changes.** Pocket Dev checks the address every 10 seconds. When it changes, it moves every forward to the new address. The chip then links to the new address.

- With no network at all, a chip shows `:3000 no network`. The forward opens again when the Mac gets an address.
- If the forward cannot listen on the new address, the chip shows `:3000 failed` in red. Tap it to read why.

**Errors you may see.**

| Message | Meaning |
| --- | --- |
| `Port 3000 is already in use on <IP>. If your dev server listens on all interfaces (0.0.0.0), it is already reachable at http://<IP>:3000 without a forward.` | Your dev server already listens on the Wi-Fi. Open `http://<IP>:3000` directly. You do not need a forward. |
| `Not allowed to listen on port 80 (ports below 1024 need root).` | Ports under 1024 need administrator rights. Pocket Dev does not have them. |
| `Port must be a whole number from 1 to 65535.` | The number is not a valid port. |
| `Port 7777 is Pocket Dev itself.` | You cannot forward Pocket Dev's own port. |

**No password.** A forwarded port has no login. Anyone on the same Wi-Fi who knows or guesses the address can open your dev site while the forward is open. Close forwards you do not need.

**What it does not do.**

- Forwards are not saved. A restart of Pocket Dev closes all of them.
- It does not forward to other computers, only to `localhost` on the Mac.
- It does not add https.

**Why the dev site cannot change Pocket Dev.** The dev site and Pocket Dev share the Mac's address, only the port differs. The browser treats them as the same site, so it sends your Pocket Dev cookie with requests from the dev site too. To stop a page on a forwarded port from using that cookie, Pocket Dev accepts a change (any POST, PUT, PATCH, or DELETE request) only with a special header, `x-pocket-dev: 1`. A normal web page on another port cannot add that header without the browser first asking Pocket Dev for permission, and Pocket Dev never gives it. See [6.4 What the protections stop](#64-what-the-protections-stop).

### 4.3 Git

**What it does.** The Git view shows the commit history of your repositories as a graph, what changed in each commit, your uncommitted changes, and the pull requests on GitHub. You can review, merge, close, reopen, and create pull requests.

**How to open it.** Tap the branch icon at the top left. The terminal icon next to it brings you back. Your terminals keep running while the Git view is open.

**How it works.** Pocket Dev runs the `git` and `gh` commands on the Mac, in the repository folder, and shows the result. `gh` is the GitHub command-line tool. It uses the GitHub login on your Mac (`gh auth login`). Pocket Dev has no GitHub login of its own.

#### Pick a repository

The list at the top shows every Git repository that Pocket Dev finds. It looks in `~/Desktop`, `~/Desktop/Projects`, and your home folder `~`, and up to two folder levels below each. It skips hidden folders and `node_modules`. The phone remembers the last repository and tab you picked.

To look in other folders, add `repoRoots` to `config.json`:

```json
"repoRoots": ["~/code", "~/work"]
```

When `repoRoots` is set, Pocket Dev looks only in those folders. The environment variable `POCKET_DEV_REPO_ROOTS` (folders separated by `:`) overrides both.

For safety, the server accepts only a repository it found in this scan. It refuses any other folder with `Not a known repository`.

#### Graph

**Graph** shows the last 300 commits on all branches, newest first, with lines that show how branches split and join. Tap **Load more** for older commits. Branch and tag names appear as small labels.

Tap a commit to see its full message, author, and the list of changed files with the number of added and removed lines. Tap a file to see its diff (the lines that changed). A merge commit shows the changes it brought in compared with its first parent, with the note `Merge commit: files are the changes it brought into <commit>.` A diff longer than 3,000 lines is cut, with the note `Truncated: showing 3000 of <n> lines.`

#### Changes

**Changes** shows the current branch, how many commits it is ahead of or behind its upstream branch (usually the one on GitHub), and the staged, changed, and new (untracked) files. Tap a file to see its diff. An empty list says `Working tree clean.`

The Git view only shows changes. It cannot stage files, make commits, pull, or switch branches. Use a terminal for those.

#### Pull requests

**Pull requests** lists up to 50 open pull requests of the repository on GitHub. Each one shows its review state (for example **Approved** or **Changes requested**) and its checks (**Checks passed**, **Checks failed**, or **Checks running**).

Tap a pull request to see its description, the checks, the changed files with their diffs, and the reviews and comments. **Open on GitHub** opens the page in the browser.

**Review.** Choose **Approve**, **Request changes**, or **Comment**, write a message, and tap **Submit review**. A change request or a comment needs a message. An approval does not. GitHub does not let you approve your own pull request. If you try, GitHub refuses and the page shows GitHub's error in red.

**Merge.** Choose one of three methods:

| Method | What it does on GitHub |
| --- | --- |
| Squash and merge | Joins all commits of the pull request into one new commit on the base branch. |
| Create a merge commit | Keeps all commits and adds a merge commit. |
| Rebase and merge | Copies each commit onto the base branch, one by one, with no merge commit. |

Before the merge, Pocket Dev asks, for example, `Squash-merge #12 into main?` Pocket Dev also tells GitHub which commit it showed you. If someone pushed a new commit in the meantime, GitHub refuses the merge, so you never merge code you did not see. A draft pull request shows `This is a draft. Mark it ready for review on GitHub before merging.`

**Delete branch.** Tick `Delete <branch> on GitHub after merging` to delete the branch after the merge. Pocket Dev deletes it **only on GitHub**. Your local branch and your files on the Mac do not change. A branch from someone else's fork is never deleted.

**Close and reopen.** **Close pull request** asks `Close #12 without merging? The branch <branch> stays.` A closed pull request has **Reopen pull request**.

**Create a pull request.** Tap **New pull request**.

1. Choose the branch to merge from (**From branch**) and the base branch. The base starts as the repository's default branch, for example `main`.
2. Type a title. A description is optional. You can tick **Create as draft**.
3. Tap **Create pull request**.

The title starts as the last commit message of the branch.

Pocket Dev pushes the branch first when needed. It runs `git push -u origin <branch>`.

- If the branch is not on GitHub yet, the form says `<branch> isn't on GitHub yet. It will be pushed first.` The push always happens.
- If the branch is on GitHub but has commits that are not pushed, the box `Push 2 new commits first` is ticked. You can untick it.
- If everything is pushed, the box says `Push the branch first` and is not ticked.

While it pushes, the button says **Pushing and creating…**. A push may take up to 90 seconds. Other Git commands stop after 20 seconds.

**What Git does not do.** No commit, stage, pull, fetch, branch switch, rebase, or conflict fixing. No editing of pull request comments. No GitHub issues. The repository list shows only repositories inside the scanned folders.

### 4.4 Resume

**What it does.** Resume lists your recent Claude Code and Codex conversations from the Mac, including ones you started in VS Code or in the Terminal app. You can read the last messages and continue the conversation from the phone.

**How to use it.**

1. Tap the clock icon (**Resume a laptop conversation**) in the top bar.
2. Pick **All**, **Claude**, or **Codex** to filter. The list shows the 30 most recent conversations, with the folder, the time, and the number of messages.
3. Tap a conversation. You see its latest 20 messages. Tool steps show as short lines, for example `▶ ran Bash: npm test`.
4. Tap **Continue in terminal** or **Continue in chat**.

For **Continue in chat**, Pocket Dev opens the chat screen and resumes the selected engine session. For **Continue in terminal**, it opens a new terminal in the conversation's folder and types `claude --resume <id>` or `codex resume <id>` for you. It waits until the shell is ready (at most 5 seconds) before it types. The tab is named `claude · <folder>` or `codex · <folder>`. If the folder no longer exists, the terminal starts in your home folder and Pocket Dev tells you so.

**How it works.** Claude Code saves each conversation as a file under `~/.claude/projects`. Codex saves them under `~/.codex`. Pocket Dev only reads these files. It never changes them. It reads the newest files first and stops when it has enough, so very large old conversations are not read. The first scan runs when Pocket Dev starts, so the first list on the phone is quick.

**The "open on laptop?" warning.** A conversation may still be open on the Mac, for example in a VS Code tab. If you continue it on the phone at the same time, both programs write to the same conversation and it gets mixed up. Pocket Dev marks a conversation **open on laptop?** when one of these is true:

- A running program on the Mac has the conversation's id in its command line, for example `claude --resume <id>`.
- The conversation file changed in the last 2 minutes.

When you open such a conversation, you see `This conversation may still be open on your laptop. Close it there first, or both will write to it.` This is only a warning. Pocket Dev does not stop you. It cannot see every case, so close the conversation on the Mac first.

**What Resume does not do.**

- It does not lock a conversation that is still open elsewhere. Close it on the laptop before continuing on the phone.
- It does not delete or edit conversations.
- It shows only Claude Code and Codex conversations stored on this Mac.

### 4.5 Chat

**What it does.** Chat gives you a phone-friendly chat screen for Claude Code and for Codex. It is easier to read than a terminal. You see the replies as formatted text, each tool step as a small fold, and file edits as diffs. When Claude or Codex wants to run a command or change a file, you see a card with **Allow** and **Deny**.

**How to open it.** Tap **Chat** in the top bar.

**How to use it.**

1. Tap **New chat**.
2. Pick **Claude** or **Codex**.
3. Pick a folder (pinned, recent, projects, or Home), or type a path.
4. Pick a model and a mode (see the tables below).
5. Tap **Start**, type a message, and tap **Send**.

The chat list shows each chat with its engine, title, status, folder, and age. It refreshes every 3 seconds. The title comes from your first message (up to 80 characters). A new chat is called **New chat** until then.

**How it works.**

- **Claude.** Pocket Dev uses the Claude Agent SDK (version 0.2.139). The SDK starts your installed `claude` program, `/usr/local/bin/claude`, as a separate process. It uses the same Claude login as the `claude` command in your Terminal. Each active Claude chat has its own `claude` process.
- **Codex.** Pocket Dev starts `codex app-server`, found at `~/.local/bin/codex` on your Mac. It uses your Codex login in `~/.codex`. One Codex process serves all Codex chats.
- Pocket Dev has no login of its own for Claude or Codex. It uses yours.
- Pocket Dev saves each chat in `~/.pocket-dev/chats/<id>.json` (or the configured `POCKET_DEV_STATE_DIR` / `POCKET_DEV_CHAT_DIR`) (only your user can read it). It keeps the last 1,500 events of each chat.

**Shared with VS Code and the Terminal.** Claude Code itself also saves the conversation under `~/.claude/projects`, the same place VS Code and the `claude` command use. So a phone chat also appears in Resume and in Claude Code's own history on the Mac. Codex saves its threads under `~/.codex` in the same way.

**Allow and Deny.** When Claude or Codex wants to act, a card appears above the message box. The card says what it wants: **Run a command**, **Edit a file**, **Use a tool**, or **Approve the plan**. An edit shows the diff.

| Button | What happens |
| --- | --- |
| **Allow once** | It may do this one action. |
| **Always allow in this chat** | It may do this kind of action again in this chat without asking. For Codex, this means the exact same command, or all file changes. |
| **Always allow in this project** | When Claude offers a project rule, saves it in that project’s `.claude/settings.local.json`, shared with Claude Code. File-edit cards may offer switching to Accept edits instead. Codex keeps no project rules here. |
| **Deny** | The first tap opens a field **Reason (optional), then tap Deny**. The second tap sends. Claude or Codex gets your reason, or "The user denied this." |

In **Plan** mode, Claude shows its plan with **Start working** and **Keep planning**.

**Questions.** Sometimes Claude or Codex asks you a question with choices. Pick an answer, or tap **Other…** and type your own. Some questions allow several answers (**Pick any that apply**). Tap **Submit** when every question has an answer.

**Stop.** While Claude or Codex works, the **Send** button becomes **Stop**. Tap it to stop the current turn. If the engine does not stop within 5 seconds, Pocket Dev ends the turn anyway.

**Models.**

| Engine | Models |
| --- | --- |
| Claude | The list comes from Claude Code itself. If that fails: **Default** (Claude Code's own default), **Opus**, **Sonnet**, **Haiku**. |
| Codex | The list comes from Codex. **Default** means the model in `~/.codex/config.toml`. |

**Modes.** A mode decides how much the engine may do without asking you.

| Engine | Mode | What it means |
| --- | --- | --- |
| Claude | **Ask every time** (the default) | Asks before edits and commands. |
| Claude | **Accept edits** | Edits files without asking, asks before commands. |
| Claude | **Plan** | Reads and plans, changes nothing until you approve the plan. |
| Claude | **Auto** | Claude decides when an action needs approval, when supported by the installed CLI. |
| Claude | **Don’t ask** | Denies actions that are not already allowed. |
| Claude | **Bypass** | Runs everything without asking; needs confirmation. |
Codex has separate controls: **Approval** (Ask first, On request, Never ask), **Sandbox** (Read only, Workspace, Full access), and **Effort** (Default, Low, Medium, High, Extra high). Full access needs confirmation. Read-only and workspace sandboxes have network access disabled.

Tap the Model, Mode/Approval, Sandbox, or Effort chips to change a setting. The toast says whether the change applies immediately or from the next turn. Each reply shows its model. Safe choices become the defaults for new chats; Bypass and Full access are never silently remembered. The chat settings’ **Permissions** screen lists remembered chat and Claude project rules and lets you remove them.

**Phone disconnects.** If the phone locks or loses Wi-Fi, the turn keeps running on the Mac. A question or an Allow card waits for you without a time limit. When the phone comes back, it reconnects (after 1, 2, 4, 8, then every 10 seconds) and shows the whole chat again. If Pocket Dev itself restarts during a turn, that turn ends with `Pocket Dev restarted while this turn was running.`

**Idle sleep.** An engine process uses memory, about 150 to 300 MB while active. So Pocket Dev stops a chat's engine after 10 minutes without activity. The chat then shows **sleeping**. Your history stays. When you send the next message, Pocket Dev shows **Waking up…**, starts the engine again, and continues the same conversation. Pocket Dev never puts a chat to sleep while a turn runs or while a question or Allow card waits. To change the 10 minutes, set `chatIdleMinutes` in `config.json`.

**Limits.**

- One turn at a time. A second message while it works gives `<Claude> is still working. Stop it or wait.`
- A message can have up to 60,000 characters.
- Up to 10 attachments per message. Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) up to 5 MB are sent as images. Other files are sent as their path.
- Deleting a chat removes it from Pocket Dev only (`Its history is removed from Pocket Dev.`). Claude Code's and Codex's own copies on the Mac stay.

**Attachments and Resume.** The paperclip uploads through the same route as terminal attachments (25 MB per file). Resume offers **Continue in chat** as well as **Continue in terminal**.

### 4.6 Files

**What it does.** Files lets you browse the files in your home folder from the phone. You can download files and folders, upload files, make folders, rename files, move things to the Trash, search by name, and preview files.

**How to open it.** Tap **Files** in the top bar. Files opens in your home folder, or in the folder you used last. Android's back gesture goes back one folder at a time. The ✕ at the top right closes Files.

**Which folders.** By default, only your home folder `/Users/ani` and everything inside it. The setting `fileRoots` in `config.json` can change this list. Pocket Dev checks every path twice. First it checks the path as written. Then it checks the real path, after it follows every shortcut (symlink). A path outside the allowed folders gets `That path is outside the folders Files may show.` So a symlink inside your home that points outside it is listed as `Link outside the shared folders`, but you cannot open it.

#### Move around

- The top bar has an up arrow (**Up one folder**) and the folder path as buttons, for example `Home › Desktop › app`. Tap a part of the path to go there.
- At the top folder, chips show **Home**, **Desktop**, **Downloads**, **Documents**, and your pinned folders.
- Tap a folder to open it. Tap a file to preview it.
- Each row shows the size and the age, for example `2.4 MB · 3 h ago`.
- A folder with more than 2,000 items shows the first 2,000: `Showing N of M items. Search to find the rest.`

#### The ⋯ menu

| Item | What it does |
| --- | --- |
| **New folder** | Asks for a name (it starts as `New Folder`). |
| **Select** | Turns on select mode (see below). |
| **Show hidden files** | Shows names that start with `.`. The phone remembers the choice. The macOS "hidden" flag is not used, so `~/Library` always appears. |
| **Pin folder**, **Unpin folder** | Adds the current folder to the quick chips. Pins in Files and pinned folders in the terminal's **New terminal** sheet are the same list (`folders` in `config.json`). |

The sort button shows **Name**, **Modified**, or **Size**. Folders always come first. **Modified** shows the newest first, and **Size** the largest first. Names sort like Finder, so `file2` comes before `file10`. The phone remembers the sort.

#### Preview a file

Tap a file. A sheet shows a preview, the size, the date, the full path, and four buttons: **Download**, **Rename**, **Trash**, and **Copy path**.

| Kind of file | Preview |
| --- | --- |
| Images | Shown as a picture. Some formats, for example HEIC photos, may give `This browser cannot show this image.` |
| Video and audio | A player. You can jump forward and back. |
| PDF | Shown in the sheet, with **Open PDF in a new tab** (Android Chrome often cannot show a PDF inside a page). |
| Text and code | The first 200 KB as plain text: `Showing the first 200 KB of <size>.` |
| HTML | Plain text. Pocket Dev never shows it as a web page. |
| Archives and other files | `No preview for this kind of file.` |

Previews run in a locked-down mode, so a previewed file cannot run code inside Pocket Dev.

#### Select, Zip, and Trash

Long-press a row, or choose **Select** in the ⋯ menu. Tap rows to tick them. The bottom bar shows **N selected**. Tap that count to select all, or to clear.

- **Zip** downloads the selected items as one `.zip` file. This is the only way to download a folder. Pocket Dev first counts the files. Above 500 MB it asks `Zip <size>?`. Pocket Dev runs the Mac's own `zip` program and sends the zip while it is made. The limit is 4 GB before compression (setting `fileZipMax`) and 200,000 files. All items must be in one folder.
- **Trash** asks `Move N items to the Trash?` and then moves them (see below).

#### Upload

1. Tap **Upload** at the bottom.
2. Pick one or more files.

Pocket Dev uploads them one after another and shows each one's progress, for example `Uploading 2 of 5`. You can cancel a file with its ✕. The limit is 2 GB for each file (setting `fileUploadMax`). The files go into the folder you are in.

Pocket Dev never overwrites. If the name exists, the new file gets a number, for example `photo (1).jpg`, and the row says `Uploaded as photo (1).jpg`. While a file uploads, a hidden file `.pocket-dev-upload-<random>` sits in the folder. Pocket Dev removes it when the upload ends or fails.

#### New folder and rename

A name cannot be empty, `.` or `..`, or contain `/`. It can be at most 255 bytes. **Rename** is in the preview sheet for files. To rename a folder, long-press it and use the pencil with that one item selected. Rename keeps the item in the same folder.

#### Trash, not delete

Pocket Dev uses macOS’s native Trash operation (`NSFileManager`) for files, folders, and symlinks. It moves the selected entry itself, leaving a symlink’s target alone. Restore items from the Trash in Finder on the Mac. Pocket Dev has no restore or permanent-delete action.

#### Search

Type in the search box. Search starts when you stop typing. It finds names that contain your text, in the current folder and up to 4 levels below. It does not search inside files. It skips `node_modules`, `.git`, and hidden items (unless **Show hidden files** is on). It stops after 500 results or about 2 seconds: `Showing the first matches. Open a smaller folder to search it fully.`

#### Permission errors

macOS protects some folders, for example Desktop, Documents, Downloads, and Mail. If macOS blocks a folder, Files shows `macOS blocked access. To allow it, give node Full Disk Access in System Settings > Privacy & Security.` and a **Try again** button.

**What Files does not do.** No moving or copying between folders. No permanent delete or restore inside Pocket Dev. No search inside files.

### 4.7 Open apps

**What it does.** It shows the apps that are open on the Mac, their windows, and how much memory and CPU each one uses. You can quit an app or force it to quit.

**How to open it.** Tap **⚙ Settings**, then **Open apps**. The row shows how many apps are running.

**The list.**

- It shows the same apps as the Mac's own **Force Quit** window (⌥⌘Esc): normal apps that have a Dock icon. Menu-bar-only helpers and background programs are not listed. Pocket Dev itself is not listed.
- The app that is in front on the Mac comes first, with a **front** badge. The others follow, largest memory first. An app you hid with ⌘H has a **hidden** badge.
- Each app shows memory and CPU, for example `412 MB · 3% CPU`. This counts the app and all its helper processes. CPU can be above 100% on a Mac with several cores.
- The list refreshes every 10 seconds while it is open. **Refresh** reloads it at once.
- The icon is a colored circle with the app's first letter, not the real app icon.

**Windows.** Tap an app to see its windows. For document apps, each window also shows its file path. Windows on another Space (another desktop) or in full screen may be missing. Then you see `No windows found. Windows on another Space may not be listed.`

**Quit and Force quit.**

| Button | How it works | Your unsaved work |
| --- | --- | --- |
| **Quit** | Asks the app to quit, the same as ⌘Q. Pocket Dev waits up to 8 seconds. | Safe. The app can show "Save changes?" on the Mac screen and wait. |
| **Force quit** | Asks first: `Force quit <App>? Unsaved work in <App> is lost.` Then Pocket Dev ends the app's process (signal `SIGTERM`), and after 3 seconds forces it (`SIGKILL`, the same as `kill -9`). | Lost. |

If **Quit** does not work, you see `<App> didn't quit, it probably has unsaved changes. Use Force quit to close it anyway.` The "Save changes?" box is on the Mac screen. You cannot answer it from the phone.

**Protected apps.** Pocket Dev refuses to quit some apps, on the phone and on the server. They show a lock.

- Parts of macOS: Finder, Dock, SystemUIServer, loginwindow, WindowServer, ControlCenter, NotificationCenter, and Spotlight. The note says `<App> is part of macOS, so Pocket Dev won't quit it.`
- The app that Pocket Dev runs inside, for example Terminal or VS Code, when you started Pocket Dev by hand. Quitting it would stop Pocket Dev. The note says `Pocket Dev runs inside <App>, so quitting it would cut off this page.`

**Permissions.** The app list, **Quit**, and **Force quit** need no special permission. Window names need two macOS permissions. See [5.3 macOS permissions](#53-macos-permissions).

- **Automation** for **System Events**. Without it you see `Pocket Dev may not control System Events. On the Mac, open System Settings → Privacy & Security → Automation → <app> and turn on System Events.`
- **Accessibility**. Without it you see `Pocket Dev needs Accessibility to read window names. On the Mac, open System Settings → Privacy & Security → Accessibility and turn on <app>.`

`<app>` is the app that started Pocket Dev: Terminal, or **Code** for VS Code, or `node` for the background service.

**What it does not do.** It does not open apps, switch between them, or show their screens. It does not move windows. Force quit ends only the app's main process. The window list does not refresh by itself.

### 4.8 Power

The Power controls are in **⚙ Settings**, in the **Power** section. The battery percentage also appears on the Settings button.

#### Keep Mac awake

A Mac goes to sleep when nobody uses it for a while. A sleeping Mac cannot answer the phone. Pocket Dev can stop this with **caffeinate**, a program built into macOS that holds the Mac awake while it runs.

| Mode | What it does | Command Pocket Dev runs |
| --- | --- | --- |
| **Off** | `Your Mac sleeps on its normal schedule.` | none |
| **When plugged in** (the default) | `Awake on the charger, normal sleep on battery.` | `caffeinate -s` |
| **Always** | `Awake on battery too. Drains the battery.` | `caffeinate -i -s` |

What the flags mean:

- `-s` stops system sleep, but macOS honors it only on the charger.
- `-i` stops idle sleep, also on battery.

The display can still turn off in every mode. Pocket Dev does not change your system settings for these modes.

- The mode is saved in `config.json` as `awake` (`off`, `plugged`, or `always`). It stays after a restart.
- caffeinate is tied to the Pocket Dev server. When the server stops or crashes, caffeinate stops too, so it never keeps the Mac awake after Pocket Dev quits.
- If caffeinate stops by itself, Pocket Dev starts it again after 1 second.
- On the Mac you can also run `npm run awake -- on`, `npm run awake -- plugged`, `npm run awake -- off`, or `npm run awake` to see the status.

**A closed lid still sleeps the Mac in every mode**, unless an external display and power are connected. For that, see **Lid closed** below.

#### Battery badge

A small badge shows the Mac's battery, for example `🔌 82%` on the charger or `🔋 40%` on battery. It turns red at 20% or less on battery. It reads the battery from `pmset -g batt` once a minute and when you come back to the page. A Mac with no battery shows no badge.

#### Lid closed

**What it does.** With **Lid closed** on, the Mac does not sleep when you close the lid. It runs `sudo pmset -a disablesleep 1`. Off runs `sudo pmset -a disablesleep 0`.

**Why it needs your password.** `pmset -a` changes a system setting. That needs administrator rights (`sudo`). Pocket Dev has no administrator rights and never stores your password. So the switch opens a new terminal on the phone that runs `npm run lid -- on` (or `off`). `sudo` asks for your Mac password in that terminal, and you type it there. The text you type goes through Pocket Dev to the terminal like all terminal typing, but Pocket Dev does not save it. `sudo` may not ask again if you typed the password a few minutes before.

**How to turn it on.**

1. Open the lid.
2. Plug in the charger.
3. Tap **Lid closed**. A box asks `Keep the Mac awake with the lid closed?` and warns `Keep it on a desk and plugged in. Never put it in a bag while this is on.`
4. Tap **Open terminal**.
5. Type your Mac password in the new terminal. The phone waits up to 1 minute for the change.

To turn it off, tap **Lid closed** again. It opens the terminal at once, without the box.

**Only with the lid open.** The switch refuses to change while the lid is closed: `Open the laptop lid to change this. Turning it off while the lid is closed would put the Mac to sleep and disconnect you.` Pocket Dev reads the lid state from the Mac's hardware info (`ioreg`, the value `AppleClamshellState`).

**Danger.** With **Lid closed** on, the Mac never sleeps. Not on battery, not in a bag. It can get very hot and empty the battery. Pocket Dev does not turn it off for you, not even when Pocket Dev stops. It stays on until you run `npm run lid -- off` or `npm run sleep`. Persistence across a Mac reboot has not been tested; check `npm run lid -- status` after restarting.

To check it in a Mac terminal: `npm run lid -- status`, or `pmset -g` and look for `SleepDisabled 1`.

#### Sleep

**Put Mac to sleep** asks `Put the Mac to sleep? Pocket Dev disconnects until you open the lid or press a key on the Mac.`

- With normal lid sleep, Pocket Dev stops caffeinate, waits 2 seconds, closes the phone connections, and runs `pmset sleepnow`. This needs no password.
- With **Lid closed** on, Pocket Dev opens a terminal that runs `npm run sleep`. It first runs `sudo pmset -a disablesleep 0` (your password) and then sleeps the Mac. So after you wake the Mac, **Lid closed** is off. Turn it on again if you need it.

The phone then shows `Mac is going to sleep.` To wake the Mac, open the lid or press a key on the Mac. You cannot wake it from the phone.

#### Shut down

**Shut down Mac** asks `Shut down the Mac?` and lists the terminals and port forwards that will close.

1. Pocket Dev ends every Pocket Dev terminal and closes the phone connections.
2. It asks macOS to shut down normally, through **System Events** (`osascript -e 'tell application "System Events" to shut down'`). Apps can still ask to save.
3. The phone shows `Mac is shutting down.` and `Turn it on with the power button. Pocket Dev starts after someone logs in.`

**Shutdown blocked.** If the Mac is still running 45 seconds later, the phone shows `Shutdown was blocked.` Usually an app with unsaved changes stopped it and waits for an answer on the Mac. The screen lists the open apps and offers:

| Button | What it does |
| --- | --- |
| **Try shut down again** | Asks macOS again. |
| **See open apps** | Opens Open apps, so you can quit the app that blocks. |
| **Force shut down…** | Warns `Every app quits without saving. Unsaved work in all apps is lost. A terminal opens and asks for your Mac password.` Then runs `npm run shutdown -- --force`, which runs `sudo shutdown -h now`. |
| **Keep the Mac on** | Cancels and closes the screen. |

The list shows every open app, not only the one that blocked. A shutdown that is only slow (more than 45 seconds) also shows this screen.

**The first shutdown needs permission.** The first time, macOS asks on the Mac screen whether `node` (or the app that started Pocket Dev) may control **System Events**. Nobody can answer that from the phone. After 60 seconds the phone says `macOS may be asking on the Mac for permission.` If you clicked **Don't Allow**, the phone says `macOS needs permission: on the Mac, allow node to control System Events (System Settings → Privacy & Security → Automation).` This is error `-1743`.

**Note.** Pocket Dev ends your terminals before it asks macOS. If the shutdown then fails, the terminals are already closed.

#### The update guard

A shutdown or sleep during a macOS update can break the update. Before each sleep and shutdown, Pocket Dev checks whether an update is being installed. It looks for the update programs of macOS (for example `softwareupdated`) holding the Mac awake, and for a running `softwareupdate --install`. If it finds one, or if the check fails or takes more than 10 seconds, it refuses: `A macOS update is being installed. Shutting down now could interrupt it. Try again after it finishes.` The **Sleep** and **Shut down** buttons are then grey. The lid switch is not checked.

#### What Power does not do

- It cannot wake the Mac or turn it on.
- It never stores your password and never runs `sudo` by itself.
- It does not change the macOS Battery settings. See [5.5 Settings you set yourself](#55-settings-you-set-yourself).

### 4.9 Login and security

Tap **⚙** (Settings) on the phone to see your devices, the device limit, the password, the login QR code, and the **This Mac** section (Disconnect and Start automatically). The Admin page on the Mac has more controls (see below).

#### The password

- Pocket Dev makes a random 12-character password on the first start and prints it once.
- `config.json` stores only a hash of it, as `passwordHash`. A **hash** is a one-way scramble. Pocket Dev can check a password against it, but nobody can turn the hash back into the password. Pocket Dev uses the `scrypt` method with a random salt, which makes guessing slow.
- If `config.json` still has a plain `password` (older versions did this), Pocket Dev converts it to `passwordHash` at the next start and removes the plain text.
- A wrong password waits 1 second before the answer. This slows down guessing.
- If you set the environment variable `POCKET_DEV_PASSWORD` on the Mac, that password wins over the stored one, and Pocket Dev prints it at start.

**Change the password.** In **Settings**, under **Password**, type the current password and the new one twice, then tap **Change password**. The new password needs at least 6 characters. Tick **Log out all other devices** to log out every other phone at the same time.

**Forgot the password?** See [8.10 Forgot the password](#810-forgot-the-password).

#### The QR code

A QR code logs a phone in without the password.

- Each code works **once** and expires after **10 minutes**.
- The codes live only in the server's memory. A restart of Pocket Dev cancels all unused codes.
- A used or expired code opens the login page with `QR code expired, scan a new one (npm run qr) or enter the password`.

There are three ways to get a code:

1. The server prints one at each start (also into the log file).
2. `npm run qr` on the Mac prints a fresh one.
3. On a phone that is already logged in, tap **⚙**, then **Show login QR**. Show it to the other phone. **New code** makes another.

**Why only the Mac can make codes.** `npm run qr` proves it runs on the Mac with a secret. At each start, the server writes a random secret into `~/.pocket-dev/local-secret` (only your user can read it). `npm run qr` reads the secret and sends it to the server at `127.0.0.1`. The server makes a code only when the request comes from the Mac itself, carries the right secret, and has no sign of coming through a proxy or tunnel. A phone on the Wi-Fi cannot do this.

#### Devices

Each login is one **device**. Settings shows `<N> logged in · <M> online now` and a list. Each device shows:

- A name from the browser, for example `Android · Chrome`. Tap **Rename** to change it (1 to 40 characters).
- How it logged in: **Password** or **QR code**.
- Its IP address.
- **Online now**, or `Last active 5 min ago`. A device is online when it has a terminal open or made a request in the last minute.
- **This device** marks the phone you hold.

The list refreshes every 10 seconds.

**Log out a device.** Tap **Log out**. Pocket Dev asks `Log out <name>? Its open terminals disconnect now.` The device is removed at once and its connections close. To log out the phone you hold, tap **Log out this device** and confirm `Log out this device? You will need the password or a QR code to log back in.`

Devices stay logged in when Pocket Dev restarts. They are saved in `~/.pocket-dev/devices.json`.

**How a device stays logged in.** At login, Pocket Dev gives the browser a **cookie** named `pd_token`. It is a long random key (64 hex characters). The browser sends it with every request. The cookie lasts 1 year. It is `HttpOnly` (page scripts cannot read it) and `SameSite=Strict` (other websites cannot make the browser send it). `devices.json` stores only a hash of each cookie (`sha256`), never the cookie. So the file alone does not let anyone log in.

#### The device limit

`maxDevices` in `config.json` sets how many devices can be logged in. The default is **2**. You can set 1 to 20 in Settings, under **Device limit**, with **−** and **+**, then **Save**.

- A password login fails at the limit: `Device limit reached (2). Log out a device in Settings on a logged-in device, or scan the QR code from the Mac.`
- A QR login always works. At the limit, it logs out the device used least recently. It prefers a device with no open terminal.
- Lowering the limit logs nobody out. It only blocks new password logins.

#### Rate limit

After 10 wrong passwords from one IP address within 15 minutes, Pocket Dev locks that address for 15 minutes: `Too many wrong passwords from <IP>. Try again in <N> min.` During the lock it does not even check the password. A correct password clears the count. The count lives in memory, so a restart resets it. Only the login page is limited. The **Change password** form on the phone has only the 1-second wait.

#### The Admin page on the Mac

The Admin page is a control page that opens only on the Mac itself. Here you manage everything about who can reach the Mac.

**How to open it.** On the Mac, run `npm run admin`. It opens `http://localhost:7778` in the Mac's browser. Pocket Dev also opens it by itself at start when phone access is off or **Keep connection open** is off. The server prints `Admin (this Mac only): http://localhost:7778` at each start.

**Why only the Mac can open it.**

- It listens only on `127.0.0.1` and `::1`, the Mac's own addresses. A phone on the Wi-Fi cannot reach these addresses.
- It answers only when the browser asked for `localhost:7778`, `127.0.0.1:7778`, or `[::1]:7778`. This check of the `Host` header stops DNS rebinding.
- It refuses requests that came through a proxy or tunnel, requests from other web pages, and changes without the header `x-pocket-admin: 1`.
- It has no password. Being at the Mac is the proof. So every program and every user on this Mac can use it.

The port is `adminPort` in `config.json`. Without it, the port is the phone port plus 1, so `7778`. If the port is in use, Pocket Dev stops with `Admin port 7778 is in use. Set adminPort in config.json or POCKET_DEV_ADMIN_PORT to another port.`

The page refreshes every 5 seconds. If Pocket Dev stops, the page says `Can't reach Pocket Dev on this Mac.` and reconnects by itself when Pocket Dev runs again.

The page has these sections: **Connection**, **Waiting**, **Devices**, **Security log**, **Password**, **Settings**, **Live**, **Service**, and **Lockdown**. Each one is described below.

#### Connect and Disconnect

**Connection** shows **Connected** or **Disconnected**.

- **Disconnect** closes port 7777. It asks `Disconnect phones?` first. Every phone loses the connection at once, and port forwards stop. Terminals keep running on the Mac. Phones stay logged in, so they work again after **Connect**.
- **Connect** opens port 7777 again and reopens the port forwards from before.
- A phone can also disconnect everything. In the phone's **Settings**, the **This Mac** section has **Disconnect**: `Disconnect this phone and every other device? You can reconnect only from the Mac.` No phone can connect again. Only the Mac can.

While disconnected, nothing answers on port 7777. The phone page shows **reconnecting…**, and a reload shows the browser's own error. `npm run qr` also fails then, with `Pocket Dev is not running`, because it uses port 7777.

On the Mac you can also run `npm run connect` (`Phone access is on (port 7777).`) or `npm run disconnect` (`Phone access is off. Terminals keep running on the Mac.`).

**Keep connection open.** This checkbox is under **Connection**. It decides what happens when you close the Admin page.

| Setting | What happens |
| --- | --- |
| On (the default) | Phone access stays open after you close the Admin page, and after a restart. |
| Off | Phone access closes about 30 seconds after the last Admin page closes. After a restart, Pocket Dev starts disconnected. |

With **Off**, an open Admin page sends a signal every 10 seconds. When the signals stop for 30 seconds, Pocket Dev disconnects, and the security log says `Phone access closed: the admin page was closed`. Use **Off** when you want phone access only while you watch the Mac.

Note: with **Off**, `npm run connect` without an open Admin page opens access for only about 30 seconds.

Both choices are saved in `config.json` as `access`, for example `{"connected": true, "keepOpen": true}`. If you pressed **Disconnect** with **Keep connection open** on, Pocket Dev stays disconnected after a restart.

#### Waiting for approval

**Approve new devices** is a switch in **Settings** on the Admin page (`requireApproval` in `config.json`, off by default). When it is on, a correct password is not enough.

1. The new phone shows `Waiting for approval on the Mac…` and a short code, for example `Android · Chrome · code 3f9a`.
2. On the Mac, the **Waiting** section lists the phone with its code, IP, and how long until the request expires.
3. Check that the code on the phone is the same. Then tap **Approve**, **Deny**, or **Block**.

The phone continues by itself after **Approve**. A request expires after 10 minutes. Then the phone says `The Mac did not approve this device in time, or denied it. Log in again to ask again.`

A QR login skips approval, because the QR code comes from the Mac. Scanning a QR code from a waiting phone approves it.

#### Devices on the Admin page

**Devices** lists every device with its address, how it logged in, and its activity (**Online now**, `Last seen 5 min ago`, or for a blocked one `Tried 2 min ago`).

| Button | What it does |
| --- | --- |
| **Rename** | Changes the name (1 to 40 characters). |
| **Log out** | Removes the device. Its terminals disconnect now. It can log in again with the password or a QR code. |
| **Block** | Disconnects it now and refuses every request from it, also after restarts. |
| **Unblock** | Lets a blocked device in again, if the device limit allows. |

A blocked phone shows `This device is blocked` and `Ask the Mac owner to unblock it. Until then, Pocket Dev refuses every request from this browser.` Logging in again does not help, even with the right password.

One weak point. A blocked browser that clears its cookies looks like a new device, so it could log in again with the password. To stop that, turn on **Approve new devices** or change the password.

A blocked device has **Rename**, **Unblock**, and **Remove**. Removing its record also removes the saved block; use approval or change the password if it should not log in again.

The phone's own **Settings** shows only active devices, with **Rename** and **Log out**. Block and Approve are only on the Mac.

#### Password on the Admin page

On the Mac you can set a new password **without** the old one: `You're at the Mac, so the current password isn't needed.` Type the new password twice and tap **Change password**. **Log out all devices** is ticked by default. It also removes devices that wait for approval.

The new password needs at least **6** characters, on the Admin page and on the phone.

#### Settings on the Admin page

- **Device limit**, with **−**, **+**, and **Save**. The same as on the phone.
- **Approve new devices** (see above).
- **Show login QR**. Shows a QR code on the Mac screen to scan with the phone. It is greyed out while disconnected: `Phone access is off. Connect first, then show the code.`
- **Addresses**. The Wi-Fi address (`http://<IP>:7777`) and the name address (`http://<name>.local:7777`), each with **Copy**. Each address logs in separately, because the browser keeps a separate cookie for each.

The Admin page also warns you when someone may be guessing your password. At 5 or more wrong passwords in the last hour, it shows `Someone may be guessing your password: N failed attempts in the last hour from IP(s) ...`, with buttons **Turn on approval** and **Change password**.

#### Live

**Live** lists terminals with **Close**, forwarded ports and active chats with **Stop**, plus read-only Power and Open apps status. Use it to stop work a phone started.

#### Service and Start automatically

**Service** shows one of these:

- `Running as a launchd service (pid N), which is this copy.`
- `Installed, not running right now.`
- `Not installed. This copy runs only until it stops or the Mac restarts.`

When the service is installed, the switch **Start automatically when the Mac starts** turns automatic start on or off. It runs `launchctl enable` or `launchctl disable` for `dev.pocket.server`. Turning it off does not stop Pocket Dev now. It only stays off after the next restart. The service starts when you **log in**, not when the Mac starts, despite the label.

When the service is not installed, the button **Install service** runs the same install as `npm run service:install`. If this copy holds the port, the page offers **Install anyway**.

The phone's **Settings** has the same switch in **This Mac**. It is grey when the service is not installed.

On the Mac you can also run `npm run autostart -- on`, `npm run autostart -- off`, or `npm run autostart` (status). The status shows `Installed: yes|no`, `Start automatically: on|off`, and `Running: yes, pid N` or `Running: no`.

**Stop Pocket Dev now** stops the server after a confirm. Every phone disconnects and every terminal ends. Start it again with `npm start` or `npm run service:install`.

#### Security log

Pocket Dev writes every login, failed login, expired QR code, and change into `~/.pocket-dev/security.log`. Each line is one event with the time, the type, and details such as the device name and IP. Only your user can read the file. When the file reaches about 1 MB, Pocket Dev renames it to `security.log.1` and starts a new one. It keeps one old copy.

The **Security log** section on the Admin page shows the latest 200 events, newest first. The filter has **All**, **Failures**, and **Changes**. Each line is plain text, for example:

- `Android · Chrome logged in with a QR code`
- `Wrong password from Android · Chrome`
- `Password logins from 192.168.29.40 locked for 15 min after 10 wrong passwords`
- `Phone access closed from a phone`
- `Lockdown: 2 devices logged out`

#### Lockdown

Lockdown is the emergency button at the bottom of the Admin page. **Lock down now** asks `Lock down Pocket Dev?` and then:

- Logs out every device, also those waiting for approval. Blocked devices stay blocked.
- Stops every port forward.
- Cancels every login QR code.
- Disconnects phone access; only the Mac can reconnect it.
- Closes all terminals, but only if you tick **Also close all terminals**.

Lockdown disconnects phone access and can optionally set a new password. It leaves the password unchanged when you do not supply one. Only the Mac can reconnect. Change a leaked password before reconnecting.

#### Protections against other web pages

Two kinds of attack use your logged-in browser against you. Pocket Dev blocks both.

- **CSRF** (cross-site request forgery). Another web page, for example your dev site on a forwarded port, tries to send a request to Pocket Dev. The browser would attach your cookie. Pocket Dev blocks this three ways. The cookie is `SameSite=Strict`, so other sites do not get it. Every change must carry the header `x-pocket-dev: 1`, which other pages cannot add without the browser asking Pocket Dev first (and Pocket Dev never agrees). Data must be sent as `application/json`. A page that is older than the server gets `This page is older than the server. Reload Pocket Dev and try again.`
- **Terminal hijack.** A terminal connection (WebSocket) must come from a Pocket Dev page. Pocket Dev checks the `Origin` header and refuses others.

Both listeners check the `Host` header. The phone listener accepts loopback, the Mac’s current LAN addresses and `.local` name, plus extra names explicitly listed in `allowedHosts`. The Admin listener accepts only its loopback names and refuses proxy headers. These checks help resist DNS rebinding.

### 4.10 The background service

`npm run service:install` makes Pocket Dev a **launchd agent**. launchd is the macOS program that starts and watches other programs. An "agent" runs for one user, after that user logs in.

What the install does:

1. Checks that no other program uses port 7777. If one does, it stops and shows how to end that program. `--force` installs anyway, and the service starts when the port is free.
2. Runs `npm install` if `node_modules` is missing.
3. Writes `~/Library/LaunchAgents/dev.pocket.server.plist` and loads it.
4. Waits up to 15 seconds and prints `Pocket Dev is running as dev.pocket.server at http://<IP>:7777`.

How the service behaves:

- It starts when you log in to the Mac, not before. After a restart of the Mac, Pocket Dev waits for your login. **Automatic login** in Users & Groups avoids that, but macOS does not allow it while FileVault (disk encryption) is on.
- If Pocket Dev crashes, launchd starts it again within about 10 seconds.
- It uses the `node` that was on your PATH when you installed. Its PATH includes `/usr/local/bin`, `/opt/homebrew/bin`, and `~/.local/bin`, so `claude`, `codex`, `gh`, `git`, and `brew` work.
- It writes all output to `~/Library/Logs/pocket-dev.log`. The log has a login QR link from each start. Each link works once and expires after 10 minutes. It has the password only when the server made a new one or it came from `POCKET_DEV_PASSWORD`.
- Each restart closes all terminals. Devices stay logged in.

Older installs ran the server inside `caffeinate -i -s`, which kept the Mac awake all the time. Now the server runs `node server.js` directly, and the **Keep Mac awake** mode decides. If you installed the service before the Power feature, run `npm run service:install` again to get the new form.

| Task | Command |
| --- | --- |
| Install, or restart after `git pull` | `npm run service:install` |
| Show state, URL, sleep holds, and the last 20 log lines | `npm run service:status` |
| Follow the log live (Ctrl+C to stop) | `npm run service:logs` |
| Stop and remove the service | `npm run service:uninstall` |
| Print the plist without installing | `scripts/install-service.sh --print` |
| Turn automatic start at login on or off, or show it | `npm run autostart -- on`, `npm run autostart -- off`, `npm run autostart` |

Before you install the service, stop a server that you started by hand: `pkill -f "node server.js"`. The service runs `node /full/path/server.js`, so this command does not stop the service.

### 4.11 The settings in config.json

`config.json` is in the `pocket-dev` folder. Only your user can read it. You can change most settings in the app. You can also edit the file by hand while Pocket Dev runs. Pocket Dev reads the file again each time it needs a setting, and when the app saves a setting it writes back only that one key, so your hand edits stay. If a list in the file is broken, Pocket Dev ignores the part it cannot use, prints a warning, and leaves the file as it is. While the file is not valid JSON, changes from the app fail with `Not saved: ... Fix config.json on the Mac and try again.`

| Key | What it is | Default |
| --- | --- | --- |
| `port` | The port for the phone. The environment variable `PORT` wins over it. | `7777` |
| `passwordHash` | The hash of your password. | Made on the first start |
| `password` | Only for setting a new password by hand. Pocket Dev turns it into `passwordHash` at the next start and removes it. | none |
| `maxDevices` | The device limit, 1 to 20. | `2` |
| `folders` | Pinned folders, for the terminal and Files. | `[]` |
| `recentFolders` | The last 5 folders you opened a terminal in. | `[]` |
| `shortcuts` | The ⚡ commands. Up to 30, each 1 to 200 characters. | `claude`, `codex`, `npm run dev`, `git status`, `git pull` |
| `repoRoots` | The folders where Git looks for repositories. | `~/Desktop`, `~/Desktop/Projects`, `~` |
| `awake` | The Keep Mac awake mode: `off`, `plugged`, or `always`. | `plugged` |
| `chatIdleMinutes` | Minutes before an idle chat engine stops. | `10` |
| `requireApproval` | `true` makes new devices wait for approval on the Mac. | `false` |
| `fileRoots` | The folders Files may show. | Your home folder |
| `fileUploadMax` | The largest Files upload, in bytes. | 2 GB |
| `fileZipMax` | The largest folder download before compression, in bytes. | 4 GB |
| `adminPort` | The port of the Mac-only Admin page. | The phone port plus 1, so `7778` |
| `access` | `{"connected": true, "keepOpen": true}`. Whether phones can connect, and **Keep connection open**. | both `true` |

Some environment variables also change Pocket Dev. They are for special cases:

| Variable | What it does |
| --- | --- |
| `PORT` | Use another port. |
| `POCKET_DEV_CONFIG` | Use a `config.json` in another place. |
| `POCKET_DEV_PASSWORD` | Use this password instead of the stored one. Pocket Dev then prints it at start. |
| `POCKET_DEV_REPO_ROOTS` | Folders for Git, separated by `:`. Wins over `repoRoots`. |
| `POCKET_DEV_ADMIN_PORT` | Use another port for the Admin page. Wins over `adminPort`. |
| `POCKET_DEV_NO_OPEN` | Do not open the Admin page by itself at start. |

## 5. Access and permissions

This is the most important part of the guide. It lists everything Pocket Dev can do on your Mac, every permission it may have, and every file it writes.

### 5.1 Who Pocket Dev runs as

Pocket Dev runs as your normal user, `ani`. It is not an administrator and not `root`.

That has two sides:

- **It can do everything you can do in Terminal.** A logged-in phone can read, change, and delete any of your files, run any program, use your logins for Claude, Codex, and GitHub, and reach the internet. Treat a logged-in phone like your unlocked Mac.
- **It cannot do what needs an administrator.** It cannot change system settings, install system software, or read other users' files. It never runs `sudo` by itself. When something needs `sudo` (the lid switch, sleep with the lid switch on, force shutdown), Pocket Dev opens a terminal and **you** type your Mac password there. Pocket Dev does not store it.

### 5.2 Everything Pocket Dev can do

| Access | Used by | Why it is needed |
| --- | --- | --- |
| A full shell (`zsh`) as `ani`. Read, write, and delete your files. Run any command. Use the network. | Terminal | A terminal is the main feature. Any command you type runs with your full rights. |
| Read and change files in your home folder (or the `fileRoots` folders). Move items to `~/.Trash`. | Files | Browse, upload, download, rename, Trash. |
| Your Claude Code login (in `~/.claude` or the macOS keychain). | Chat, and `claude` in terminals | Claude Code runs with your account and your plan. |
| Your Codex login (in `~/.codex`). | Chat, and `codex` in terminals | Codex runs with your account. |
| Your GitHub CLI login, account `anisirji`, with the scopes listed below. | Git (pull requests), `gh` in terminals | `gh` acts on GitHub as you. |
| `git push` with your Git credentials. | Git (create a pull request) | A branch must be on GitHub before a pull request. |
| Read `~/.claude/projects` and `~/.codex` (never write). | Resume | To list and show your conversations. |
| See the command line of every running program (`ps`). | Resume, Open apps | To warn "open on laptop?" and to add up memory and CPU per app. |
| List your apps, ask them to quit, and end their processes. | Open apps | Quit and Force quit. |
| Read window names through System Events. | Open apps | Needs Automation and Accessibility. |
| Ask macOS to shut down through System Events. | Power | Needs Automation. |
| Run `caffeinate`, `pmset -g`, `pmset sleepnow`, and `ioreg`. | Power | Keep awake, battery, sleep, lid state. None of these needs a password. |
| Run the Mac's `zip` program. | Files | Download folders. |
| Listen for connections on port 7777 on every network the Mac is on, and on forwarded ports on the LAN IP. | The server, Ports | So the phone can connect. |

**The GitHub scopes.** A scope is one kind of permission that GitHub gave to `gh` when you logged in. Your `gh` login has these:

| Scope | What it allows |
| --- | --- |
| `repo` | Full control of all your repositories, private ones too: read, push, pull requests, settings. |
| `workflow` | Change GitHub Actions workflow files. |
| `delete_repo` | Delete repositories. |
| `gist` | Create and change gists. |
| `read:org` | Read which organizations and teams you belong to. |

The Git view uses only a small part of this: list, review, merge, close, reopen, and create pull requests, and delete a merged branch on GitHub. It never deletes a repository. But any command typed in a Pocket Dev terminal can use the full login, for example `gh repo delete`. To see your scopes on the Mac, run `gh auth status`.

### 5.3 macOS permissions

macOS asks before a program may control other apps or read protected folders. These permissions are called **TCC** permissions (Transparency, Consent, and Control). You find them in **System Settings → Privacy & Security**.

macOS gives a permission to the app that **started** the program, not to Pocket Dev by name. That app is:

- **Terminal** (or iTerm), when you ran `npm start` there.
- **Code** (VS Code), when you ran it in the VS Code terminal.
- **node**, when it runs as the background service.

A permission given to Terminal or Code also covers every other program you start from that app. A hand-started server and the service need separate permissions.

| Permission | Where to find it | Needed for | What you may have granted |
| --- | --- | --- | --- |
| Incoming connections | Firewall popup on the first start, or **System Settings → Network → Firewall** | The phone can connect. Only matters when the firewall is on. | Allow for `node`, if the popup appeared. |
| Automation → **System Events** | Popup on first use, or **Privacy & Security → Automation** | Normal shutdown, window names in Open apps | Allow for `node` or the starting app. |
| Accessibility | **Privacy & Security → Accessibility** | Window names in Open apps | Grant it to the app macOS identifies as running Pocket Dev; this may differ between Terminal, VS Code, and a service. |
| Full Disk Access, and Files and Folders | **Privacy & Security → Full Disk Access** and **Files and Folders** | Files, for protected folders such as Desktop, Documents, and Downloads | Grant access to the app macOS identifies; permission prompts depend on how the server was launched. |

To remove a permission, open the list in System Settings and turn the switch off, or select the app and click **−**.

### 5.4 What changed on the Mac

Pocket Dev itself writes the files in this table. Everything else that changes on the Mac is what you do with Pocket Dev: commands in terminals, actions in Files, edits by Claude or Codex, and the settings in [5.5](#55-settings-you-set-yourself) that you change yourself.

| Path | What it holds | Who can read it | When it is written |
| --- | --- | --- | --- |
| `pocket-dev/config.json` | Your settings (see [4.11 The settings in config.json](#411-the-settings-in-configjson)). Includes `passwordHash`, never the password. | Only you (mode `600`) | First start, and each time you change a setting in the app |
| `~/.pocket-dev/` | The folder for everything below | Only you (mode `700`) | First start |
| `~/.pocket-dev/devices.json` | One entry per logged-in device: a hash of its cookie, an id, the name, the browser text, when it was created and last seen, the IP, how it logged in, and its status | Only you (`600`) | Each login, logout, rename, and every 30 seconds while devices are active |
| `~/.pocket-dev/local-secret` | The port and a random secret, so `npm run qr` and `npm run awake` can prove they run on the Mac | Only you (`600`) | Each start |
| `~/.pocket-dev/uploads/` | Files you uploaded from the terminal's 📎 | Only you (`700`, files `600`) | Each upload. Never cleaned. |
| `~/.pocket-dev/chats/` | One file per chat, with its last 1,500 events | Only you (`700`, files `600`) | During chats |
| `~/.pocket-dev/security.log` and `security.log.1` | The security log | Only you (`600`) | Each login and change |
| `~/.pocket-dev/admin.json` | The Admin page address, so `npm run admin`, `connect`, and `disconnect` find it | Only you (`600`) | Each start. Not deleted when Pocket Dev stops. |
| `~/Library/LaunchAgents/dev.pocket.server.plist` | The service definition | Your user | `npm run service:install` |
| `~/Library/Logs/pocket-dev.log` | Everything the server prints: start lines, login QR links, IP changes, warnings | Your user | While the service runs |
| The system setting `SleepDisabled` | `1` when **Lid closed** is on | System setting | `npm run lid -- on` (with your password) |
| `~/.Trash` | Items you moved to the Trash from Files | Your user | Each Trash action |

Short-lived files with `.tmp` at the end appear for a moment while Pocket Dev saves a file safely. A hidden `.pocket-dev-upload-<random>` file appears in a folder during a Files upload.

Pocket Dev does not change `~/.claude` or `~/.codex` itself. Claude Code and Codex do write their normal history there when you use them, from a terminal or from Chat.

Check your current installation with `npm run service:status`. A source merge or push does not install, restart, or activate the service. Use `npm run service:install` when you are ready to switch the running server.

### 5.5 Settings you set yourself

Pocket Dev does not change these settings. Set them yourself in **System Settings**, if you want them.

| Setting | Where | Why |
| --- | --- | --- |
| **Wake for network access**: on | Battery → Options | The phone can reach the Mac after the display sleeps. |
| **Prevent automatic sleeping on power adapter when the display is off**: optional | Battery → Options | Does the same as the **When plugged in** mode, also when Pocket Dev is not running. |
| **Optimized Battery Charging**: on | Battery | Protects the battery when the Mac stays plugged in all the time. |
| **Automatically log in as**: your user | Users & Groups | The service starts only after a login. Not available when FileVault is on. |
| Firewall: allow `node` | Network → Firewall | The phone can connect. |
| Automation: allow `node` to control **System Events** | Privacy & Security → Automation | Shut down from the phone, window names. |
| Accessibility: the app that runs Pocket Dev | Privacy & Security → Accessibility | Window names. |
| **Lid closed** | `npm run lid -- on` (asks your password) | Use the Mac with the lid closed. |

### 5.6 The leftover VS Code tunnel

At the start of this project, a **VS Code tunnel** was set up. Pocket Dev does not use it. It is independent of Pocket Dev; check its current state before relying on it.

**What it is.** A VS Code tunnel lets you open this Mac in VS Code or at `vscode.dev` from anywhere on the internet, after you sign in with the same GitHub account. It is a separate way into the Mac, with full access to your files and a terminal, and it works over the internet, not only on your Wi-Fi. Its safety depends on your GitHub account.

**Earlier setup recorded these components; verify their current state with `code tunnel status`.**

- A launchd service `com.visualstudio.code.tunnel`. Its plist is at `/Users/ani/com.visualstudio.code.tunnel.plist` (in your home folder, not in `~/Library/LaunchAgents`). Its log is `~/.vscode/cli/tunnel-service.log`.
- A second tunnel process started by the VS Code app, with the machine name `anikets-air`.

**How to remove it.** Run these on the Mac:

```sh
code tunnel status              # see what is running
code tunnel service uninstall   # stop and remove the tunnel service
code tunnel kill                # stop any other running tunnel
code tunnel unregister          # remove this Mac from the tunnel service
```

In the VS Code app, also turn off **Remote Tunnel Access** in the Accounts menu (the person icon at the bottom left), if it shows as on. Then run `code tunnel status` again to check.

### 5.7 Undo everything

To remove Pocket Dev and everything it changed:

```sh
cd ~/Desktop/pocket-dev
npm run service:uninstall        # stop Pocket Dev and remove the login service
npm run lid -- status            # if it says "stays awake", run the next line
sudo pmset -a disablesleep 0     # turn normal lid sleep back on
rm -rf ~/.pocket-dev             # devices, secret, uploads, chats, security log
rm -f ~/Library/Logs/pocket-dev.log
rm -f config.json                # settings and password hash
```

Then:

1. Remove the VS Code tunnel (see [5.6](#56-the-leftover-vs-code-tunnel)).
2. In **System Settings → Privacy & Security**, remove `node`, Terminal, or Code from **Automation**, **Accessibility**, and **Full Disk Access**, if you granted them only for Pocket Dev.
3. In **Network → Firewall → Options**, remove `node` if you no longer need it.
4. Change the Battery and login settings back if you changed them.
5. To delete the program itself, delete the `pocket-dev` folder.

Deleting `~/.pocket-dev` logs every phone out. Deleting `config.json` makes Pocket Dev create a new password at the next start.

## 6. Network and security in plain words

### 6.1 Plain http on the Wi-Fi

The phone talks to the Mac with plain `http`, not `https`. Nothing is encrypted by Pocket Dev.

Your Wi-Fi password does encrypt the radio signal between each device and the router. But every device that knows the Wi-Fi password, and the router itself, could read the traffic with special tools. With plain `http`, such a person could see:

- The password, once, when you log in with it.
- Your login cookie, in every request. With the cookie, they could act as your phone.
- Everything shown in your terminals and chats, and everything you type, also a `sudo` password typed into a Pocket Dev terminal.
- The files you upload, download, or preview.

So use Pocket Dev only on a Wi-Fi you trust, like your home JioFiber. Do not use it on a café, office, or hotel Wi-Fi. https is planned, see [11. Planned next](#11-planned-next).

### 6.2 Ports and addresses

| Port | Who can reach it | What it is |
| --- | --- | --- |
| **7777** | Every device on every network the Mac is connected to | Pocket Dev for the phone. It listens on all networks (`0.0.0.0`), so on a café Wi-Fi other people there could open the login page too. |
| **7778** | Only the Mac itself (`127.0.0.1` and `::1`) | The Admin page. No password, so every program and user on the Mac can use it. |
| Forwarded ports, for example **3000** | Every device on the same Wi-Fi | Your dev site. **No password.** |

Pocket Dev also makes connections out to the internet:

- The phone loads the terminal display library from `cdn.jsdelivr.net`.
- `gh` and `git push` talk to GitHub.
- Claude Code and Codex talk to Anthropic and OpenAI.

### 6.3 What someone on the same Wi-Fi can and cannot do

**They can:**

- Open the login page at `http://<Mac IP>:7777`.
- Try passwords. Each wrong try takes 1 second. The rate limit locks them out after 10 wrong tries in 15 minutes. The Admin page warns you after 5 wrong tries in an hour.
- Open any forwarded port, with no password.
- With special tools, read the plain `http` traffic (see 6.1) and copy your cookie.

**They cannot,** without your password, a fresh QR code, or a copied cookie:

- Open terminals, Chat, Git, Files, Apps, or Power.
- Make a QR login code. Only the Mac itself, with the local secret, can make one.
- Open the Admin page, because it answers only on the Mac.
- Log in with the password while your own devices fill the device limit.

### 6.4 What the protections stop

| Protection | What it stops |
| --- | --- |
| The password is stored as a `scrypt` hash. | Someone who copies `config.json` still does not know your password. |
| `devices.json` stores only hashes of cookies. | Someone who copies `devices.json` cannot log in with it. |
| A 1-second wait after a wrong password, and the rate limit. | Fast password guessing. |
| Approve new devices, Block, and Lockdown. | A stranger who learned the password, once you notice. |
| **Disconnect** and **Keep connection open** off. | Anyone reaching the Mac while you do not use it. |
| QR codes work once, expire in 10 minutes, and only the Mac can make them. | An old photo of a QR code, or a phone that makes its own codes. |
| The device limit. | An extra device logging in with the password while yours are logged in. |
| The cookie is `HttpOnly`. | A script in a page reading your cookie. |
| The cookie is `SameSite=Strict`. | Other websites sending requests with your cookie. |
| The `x-pocket-dev: 1` header and JSON-only bodies. | A page on a forwarded port, or any other page, changing things in Pocket Dev (CSRF). |
| The `Origin` check on terminal connections. | Another page opening your terminals. |
| Git accepts only repositories from its own scan. | A request that runs `git` in some other folder. |
| Files checks every path, also after it follows symlinks. | Reading files outside your home folder through a trick path. |
| Previews run in a sandbox, and HTML shows as text. | A previewed file running code inside Pocket Dev. |
| Upload names are cleaned, and uploads never overwrite. | An upload that replaces another file. |

### 6.5 What the protections do not stop

- **Someone who reads the Wi-Fi traffic.** Plain `http` is readable (see 6.1).
- **Someone with your unlocked phone.** The phone stays logged in for a year. Log it out in Settings from another device if you lose it, or delete `~/.pocket-dev/devices.json` on the Mac and restart Pocket Dev.
- **Someone with access to your Mac user.** They can read the log with its QR links, start terminals, and anything else.
- **Forwarded ports.** They have no password at all.
- **Commands you run.** Pocket Dev does not check what a command does. `rm -rf` works the same as in Terminal.
- **Claude or Codex in Bypass or Full access mode.** They then run any command without asking you.
- **The VS Code tunnel.** It is a separate way in over the internet. See [5.6](#56-the-leftover-vs-code-tunnel).
- **A changed copy of the terminal library.** The phone loads xterm.js from `cdn.jsdelivr.net`. If that site served bad code, the code would run inside your Pocket Dev page.
- **DNS rebinding on port 7777.** Pocket Dev checks the `Host` header only on the Admin page (see 4.9).
- **Other programs on the Mac.** The Admin page has no password. Any program you run on the Mac can open `http://localhost:7778` and, for example, turn off approval.

## 7. Memory, CPU, and battery

| Part | Measured or expected use |
| --- | --- |
| The server, idle | About 0% CPU and about 19 MB of memory. This was measured on the first version (V1). |
| Each terminal | One `zsh` process plus what you run in it. The server keeps up to about 500 KB of output per terminal. |
| Resume | At start, one scan that reads up to a few hundred MB of history files from disk. After that, it reads only new lines. |
| A Chat engine | About 150 to 300 MB while active. Each Claude chat has its own `claude` process. All Codex chats share one `codex` process. Stopped after 10 idle minutes. |
| Open apps | While the sheet is open, every 10 seconds: two small `osascript` runs and one `ps`. |
| Power section | While it is open, every 15 seconds: three `pmset` calls, one `ioreg`, and the update check. |

Your Mac has 8 GB of memory. VS Code and two or three active chats can use a large part of it. Idle sleep for chats exists for this reason.

**Battery.** caffeinate itself uses almost no power. The cost is that the Mac does not sleep.

- **When plugged in** has no battery cost, because it works only on the charger.
- **Always** keeps the Mac awake on battery. The battery then drains as if you were using the Mac with the screen off.
- **Lid closed** keeps the Mac awake in every case. In a bag it gets hot and the battery empties.

## 8. Troubleshooting

### 8.1 The phone cannot connect

Check these in order:

1. **Is the phone on the same Wi-Fi?** Mobile data does not work. Turn on Wi-Fi on the phone.
2. **Did the IP change?** Run `npm run qr` or `npm run service:status` on the Mac and use the new address.
3. **Is the Mac asleep?** Open the lid or press a key. A sleeping Mac does not answer. To prevent it, use **Keep Mac awake** and see 5.5.
4. **Is Pocket Dev running?** Run `npm run service:status`. If it says `not installed` or `not answering`, start it with `npm run service:install` or `npm start`.
5. **Is phone access off?** Run `npm run admin` on the Mac. If **Connection** says **Disconnected**, tap **Connect**, or run `npm run connect`. With **Keep connection open** off, access closes 30 seconds after the Admin page closes.
6. **Is the firewall blocking it?** Open **System Settings → Network → Firewall → Options** and allow incoming connections for `node`.
7. **Does the page load but stay blank?** The phone needs internet to load the terminal library from `cdn.jsdelivr.net`.

### 8.2 The QR code says it expired

Each code works once and only for 10 minutes. A restart of Pocket Dev also cancels it. Run `npm run qr` on the Mac and scan the new code.

If `npm run qr` says `Pocket Dev is not running`, start Pocket Dev first. The same message appears while phone access is off, because `npm run qr` uses port 7777. Then run `npm run connect` first.

### 8.3 Device limit reached

The login page says `Device limit reached (2)...`.

- Scan a QR code instead. It always works and logs out the device used least recently.
- Or, on a logged-in phone, open **Settings** and log out an old device, or raise the limit.

### 8.4 This device is blocked

Someone blocked this browser on the Mac. On the Mac, run `npm run admin`, find the device in **Devices**, and tap **Unblock**. Logging in again does not help.

### 8.5 The terminal output looks scrambled

The terminal size may not match the screen. This happens when the same terminal is open on the Mac and on the phone.

1. Type something on the phone, or tap **Send** with an empty input. The size changes to the phone.
2. Type `clear` and tap **Send** to clear the screen.
3. In full-screen programs such as `vim`, the program redraws after the size changes.
4. Reload the page. It replays the recent output.

### 8.6 File names show as `???`

The shell did not know that the text is UTF-8. Pocket Dev now sets `LANG=en_US.UTF-8` for every terminal and for the service. If you still see `???`, check `echo $LANG` in the terminal. If it is empty, reinstall the service with `npm run service:install`.

### 8.7 Permission errors

| Message | What to do |
| --- | --- |
| `-1743`, `Not authorized to send Apple events`, or `Pocket Dev may not control System Events` | On the Mac: **System Settings → Privacy & Security → Automation**, find the app that runs Pocket Dev (`node`, Terminal, or Code) and turn on **System Events**. |
| `macOS may be asking on the Mac for permission.` | Look at the Mac screen. A box asks for permission. Click **Allow**. |
| `Pocket Dev needs Accessibility to read window names` | **Privacy & Security → Accessibility**, turn on the app that runs Pocket Dev. If `node` is not in the list, click **+** and pick the file that `which node` prints. |
| `macOS blocked access. To allow it, give node Full Disk Access...` | **Privacy & Security → Full Disk Access**, add `node` or the app that runs Pocket Dev. |

After you change a permission, restart Pocket Dev (`npm run service:install`) if the error stays.

### 8.8 Shutdown was blocked

An app on the Mac probably asks "Save changes?". Choose one:

- Tap **See open apps** and quit the app (Quit lets it save, Force quit does not).
- Tap **Try shut down again** after you saved on the Mac.
- Tap **Force shut down…** and type your password. All unsaved work is lost.
- Tap **Keep the Mac on**.

If the message says a macOS update is being installed, wait until it ends.

### 8.9 The Lid closed switch is locked

The switch works only with the lid open. Open the lid, then change it. If the phone says `Lid setting did not change within a minute. Check the terminal.`, look at the terminal that opened. You may have typed the password wrong, or `sudo` is still waiting.

### 8.10 Forgot the password

You need the Mac for this.

**With the Admin page.** Run `npm run admin` on the Mac. In **Password**, type a new password twice and tap **Change password**. You do not need the old password there.

**By hand.** **Change password** in the phone's Settings asks for the current password, so it does not help here.

1. Open `config.json` in the `pocket-dev` folder on the Mac.
2. Delete the `passwordHash` entry and add `"password": "your-new-password"`.
3. Restart Pocket Dev. For the service, run `npm run service:install`. For a server you started by hand, press Ctrl+C and run `npm start`.

At the start, Pocket Dev turns the plain password into a hash and removes the plain text. Your phones stay logged in.

To get a phone in without any password, run `npm run qr` and scan the code.

### 8.11 Resume says "open on laptop?"

Close that conversation on the Mac (the VS Code tab, or the Terminal window with `claude`), then wait 2 minutes. The mark also shows for 2 minutes after the file last changed. If you are sure it is closed, you can continue anyway.

### 8.12 Commands for status and logs

| Command | What it shows |
| --- | --- |
| `npm run service:status` | Whether the service runs, the phone URL, caffeinate's sleep holds, and the last 20 log lines |
| `npm run service:logs` | The log, live (Ctrl+C to stop) |
| `npm run qr` | A new login QR code and URL |
| `npm run admin` | Opens the Admin page on the Mac |
| `npm run connect`, `npm run disconnect` | Turns phone access on or off |
| `npm run autostart` | Whether the service starts by itself at login |
| `npm run awake` | The Keep awake mode, power, battery, and the lid setting |
| `npm run lid -- status` | Whether Lid closed is on |
| `pmset -g assertions` | Every program that holds the Mac awake |
| `ipconfig getifaddr en0` | The Mac's Wi-Fi IP |
| `lsof -nP -iTCP:7777 -sTCP:LISTEN` | Which program listens on port 7777 |

## 9. What Pocket Dev does not do

- It does not work outside your home Wi-Fi yet. No internet access, no mobile data.
- It does not use https yet.
- It does not show the Mac's screen. It is not screen sharing.
- It cannot wake the Mac or turn it on.
- Terminals and port forwards do not survive a restart of Pocket Dev.
- It never runs `sudo` and never stores your Mac password.
- It does not clean old uploads in `~/.pocket-dev/uploads`.
- Forwarded ports have no password.
- The Git view does not commit, stage, pull, or switch branches.
- Delete branch after a merge deletes only the branch on GitHub.
- Files does not delete for good, does not move between folders, and does not search inside files.
- Open apps does not open apps or move windows.
- Resume continues a conversation in a terminal, not in Chat.
- Chat does one turn at a time per chat.
- The phone needs internet to load the terminal library.
- There is no Android app. It is a web page.

## 10. Glossary

| Word | Meaning |
| --- | --- |
| **Accessibility** | A macOS permission that lets a program read and control other apps' windows. |
| **Automation** | A macOS permission that lets a program send commands to another app, here System Events. |
| **caffeinate** | A macOS program that keeps the Mac awake while it runs. |
| **Cloudflare Tunnel** | A service that gives a computer at home a safe public web address without opening the router. Planned for Pocket Dev. |
| **Cookie** | A small piece of data the browser stores and sends back with every request. Pocket Dev's cookie `pd_token` proves the phone is logged in. |
| **CSRF** | Cross-site request forgery. An attack where another web page makes your browser send a request with your cookie. |
| **DHCP** | The way the router gives each device its IP address. |
| **Diff** | The lines that changed in a file, red for removed and green for added. |
| **DNS rebinding** | A trick where a website makes the browser treat it as a local address, to reach programs on your network. |
| **FileVault** | macOS disk encryption. |
| **Heartbeat** | A small signal sent again and again to say "I am still here". The Admin page sends one every 10 seconds. |
| **Hash** | A one-way scramble of data. You can check a value against it but not get the value back. |
| **http, https** | The ways a browser talks to a server. `https` is encrypted, `http` is not. |
| **IP address** | The number that identifies a device on a network, for example `192.168.29.17`. |
| **LAN, LAN IP** | Local area network, your home network. The LAN IP is the Mac's address on it. |
| **launchd, LaunchAgent** | The macOS program that starts and watches other programs. A LaunchAgent is one program it runs for your user after you log in. |
| **localhost** | "This same computer". `127.0.0.1` (IPv4) and `::1` (IPv6) are its addresses. |
| **Lockdown** | The Admin page's emergency button that logs out every device at once. |
| **Passkey** | A login that uses the phone's fingerprint or face unlock instead of a password. Planned. |
| **pmset** | The macOS command for power settings: sleep, battery, and more. |
| **Port** | A number that picks one program on a computer. Pocket Dev uses 7777. A dev site often uses 3000. |
| **Port forwarding** | Passing connections from one address and port to another. Pocket Dev passes `<LAN IP>:3000` to `localhost:3000`. |
| **pty** | Pseudo-terminal. A fake terminal device that makes programs behave as if a person typed at a real terminal. |
| **QR key** | The one-time code inside a Pocket Dev login QR code. |
| **Scope (GitHub)** | One kind of permission that a GitHub login has. |
| **scrypt** | A slow, safe way to hash passwords. |
| **Shell** | The program that reads your commands in a terminal. On your Mac it is `zsh`. |
| **sudo** | A command that runs another command as administrator after you type your Mac password. |
| **Symlink** | A shortcut file that points to another file or folder. |
| **System Events** | A hidden macOS app that other programs ask to control windows, apps, and shutdown. |
| **TCC** | Transparency, Consent, and Control. The macOS system behind the Privacy & Security permissions. |
| **Tunnel** | A connection that carries traffic from the internet to a computer at home. |
| **WebSocket** | A connection that stays open, so the browser and the server can both send data at any time. Terminals and chats use it. |
| **xterm.js** | The library that draws the terminal in the phone browser. |

## 11. Planned next

These parts are planned. None of them is built.

- **A domain and Cloudflare Tunnel.** Reach the Mac from anywhere, also on mobile data, at your own web address. The Mac makes an outgoing connection to Cloudflare, so you do not need to open ports on the JioFiber router.
- **https.** With the tunnel, the traffic between the phone and Cloudflare is encrypted.
- **Passkeys and fingerprint login.** Log in on the phone with your fingerprint instead of the password.
- **Android share target.** Share a screenshot or file from any Android app straight into Pocket Dev.
