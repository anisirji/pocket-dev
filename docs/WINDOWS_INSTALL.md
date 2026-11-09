# Pocket Dev on Windows (first test)

Untested on Windows. Written from the code, not from a run. Write down the exact error text of anything that fails.

## 1. Install the tools (once)
1. Node.js 22 or newer (LTS) from nodejs.org. Check: `node -v` in PowerShell.
2. Git for Windows (optional, only if you want to use git inside Pocket Dev): git-scm.com.
3. Claude Code, if you want Claude chats on this machine: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in.
4. If `npm install` below fails on `node-pty`: install "Visual Studio Build Tools" (workload: Desktop development with C++) and Python 3, then run `npm install` again.

## 2. Get the code
Copy `pocket-dev-multi-machine.zip` to the PC and extract it, for example to `C:\pocket-dev`.

## 3. Install and start
In PowerShell:
```
cd C:\pocket-dev
npm install
node server.js
```
- The first start prints a random 12-character password. Copy it.
- The server listens on port 7777 and the admin page on port 7778 (this PC only).
- The first time, Windows Defender Firewall asks if Node.js may accept connections: choose Private networks, Allow.
- Settings and data live in `%USERPROFILE%\.pocket-dev`.

## 4. Open it
- On this PC: http://localhost:7777
- From the phone, on the same Wi-Fi: http://<this PC's IPv4 address>:7777 (find it with `ipconfig`).
- Log in with the printed password.

## 5. Join your Mac's room
1. On the Mac (demo or real), Settings, Room, create a room, tap Invite: you get a code and the Mac's address.
2. On the Windows PC page (or phone logged in to it): Settings, Room, Join: enter the Mac's address, the code, choose Admin for yourself.
3. The switcher shows both devices.

## 6. What to check, and what to write down
- Does `npm install` finish? (error text if not)
- Does the server print its URLs and stay running?
- Does the phone open it? Terminal opens (it should be PowerShell)? Files list? Git?
- Settings, Power and Health: the lines that say "Not available on this system" are expected for temperature, lid and window names.
- Trash a file from Files: does it land in the Recycle Bin?
- Download a folder as zip: expected NOT to work on Windows yet.
- Join the room from the Mac and switch to the PC.

## 7. Start at login (optional, later)
The Admin page (http://localhost:7778) has a Windows start-at-login option that creates a Task Scheduler task. Untested.
