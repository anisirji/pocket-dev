# Pocket Dev multi-machine: execution plan

Source of decisions: `docs/MULTI_MACHINE_SCOPE.md`. This plan is based on a read-only pass over the code on 2026-11-09. Nothing below has been run on a non-Mac machine.

## Rules

- Every step is built in its own worktree under `.claude/worktrees/`, branched from `multi-machine-design`.
- Nothing merges into `live`, and the `dev.pocket.server` service is never restarted, until the owner has seen the step working and says so.
- Every step ends with: `node --test test/*.test.mjs` (the test "over the connector a file may be 100 MB" already fails before any change) and, for UI, a look in a browser at phone size.
- At most three agents work at the same time.
- No attribution lines in commit messages.

## What the code reading found

| Area | Finding | Consequence |
|---|---|---|
| Routing | `handleApi` in `server.js:581` checks header, same origin, guest block, then login. A new `/api/room/*` fits after the login check and inherits all of it. | Room routes are cheap to add and safe by default. Guests are blocked from them. |
| Persistence | JSON files in `STATE_DIR`, written to a temp file then renamed, mode 0600 (`collaborators.js` is the model). | A room store follows the same pattern. |
| Cookies | A device login holds at most 8 hosts (`auth.js:116`). The device limit defaults to 2. | Both must change for rooms of many devices. |
| Collaborators | Grants hold role, folders and duration. Guests only get files and messages. They never get AI chats (`ai: false`). | "Collaborator level on a device" exists for files and messages. Chat visibility is a new rule. |
| Messages | One JSONL file, ids unique on one machine only, deletes remove lines, participant keys are machine-local. | Sync needs global ids, deletion records and key mapping. |
| Chats | One JSON file per chat, rewritten whole, capped at 1500 events, images and attachments are files with machine-local paths. | Sync treats events as an append-only stream and ships blobs by id. |
| Tasks | Nothing exists. | New. |
| Pages | About 110 `/api/` references, five near-duplicate fetch wrappers, three WebSocket builders using `location.host`, no per-machine storage keys, no service worker. | A server proxy with a path prefix plus one small shim script. |
| Cross-origin | Origin, Host and SameSite=Strict cookies block direct calls from a page to another machine. | The phone talks to one front door, which forwards. |
| Linux | `package.json` allows only darwin. `npm install` needs force. Power code starts `caffeinate` at boot. Probably starts with errors, not run. | A platform layer is needed (table in the scope notes). |

## Build order

Each step is small and ends in something we can test.

| # | Step | Test | Needs the owner's hardware |
|---|---|---|---|
| 1 | **Room core.** Device id, `room.json` store, create, join with a code, approve, leave, kick, revoke. Join gives a collaborator entry at the level the device owner chooses (admin, or folders). | Two server instances in one test: create, join, approve, kick, leave. | No |
| 2 | **Sync log.** A small module: changes with global ids, per-device cursors, deletion records, catch-up after being offline. No network yet. | Unit tests: out-of-order, duplicate, offline catch-up, deletion. | No |
| 3 | **Platform layer.** One `platform` module with Mac behavior unchanged and Linux and Windows implementations for trash, open, zip, screenshot, power and health. Unsupported options say so. | Unit tests per function with injected commands. Mac behavior compared before and after. | Linux and Windows machines |
| 4 | **Device list and status.** Room members, online or offline, last seen, over the room link. Dead-device state in the phone UI. | Two servers, stop one, the other reports it offline. | No |
| 5 | **Forwarding.** `/m/<device>/...` proxy for HTTP, WebSocket, downloads and Range. Shim script: path prefix, per-machine storage keys, the three WebSocket builders, file URLs. Machine switcher in the header. | Two servers: terminal, files, git through the front door. Browser at phone size. | A second machine on the same Wi-Fi |
| 6 | **Shared messages and tasks.** Messages get global ids. Jira-style tasks (`MAC-14`). Sync between members using step 2. | Two servers: write on each, catch up after one is off. | No |
| 7 | **Chat and image replication** that follows each member's access level. Needs the chat-visibility rule from the scope notes. | Member with one folder does not receive other chats. | No |
| 8 | **Modes and Bypass.** Read-only, Plan, Ask, Auto, Bypass with duration (1, 2, 3, 4 hours, always) and a banner. | Unit tests for timer and mode checks. Browser check for the banner. | No |
| 9 | **Linux, then Windows runs.** Remove the darwin-only gate, run the full suite and a real session. | Real runs. | Yes |
| 10 | **Domain failover.** Several devices behind one name, tested away from home. | Real network tests. | Yes |

Steps 1, 2 and 3 do not depend on each other, so they start first, one agent each.

## Not planned yet

Orchestrating AI and local models as a Brain (dropped for the first version). Copying a single message or a whole chat is a separate task owned by another agent.

## Open before the relevant step

- Step 7: who can see a chat, only its starter or everyone with access to the device.
- Step 5: how cookies work for forwarded requests (one login per device versus a room-membership proof).
- Step 10: whether the same tunnel can run on several devices. Not verified.


## Room liveness, retry and access (built 2026-11-09, branch mm-room-live)

- **Liveness.** The host pings every member and every member pings the host, every 30 s (`POCKET_DEV_ROOM_PING_MS` overrides it). A member answers a ping with the host's current list, so a member that missed an announcement catches up. `GET /api/room` carries `status` (`online` or `offline`) and `lastSeen` per member. A failed ping shows offline at once; silence alone shows offline after two intervals plus a short grace. Members cannot reach each other (they hold no secret for each other), so a member learns about other members through the host. Clock differences between devices are not corrected.
- **Retry.** A kick, member list or leave that cannot be delivered waits in `outbox` in `room.json` and is resent on the timer. Any answer, even a refusal, ends the retry; no answer or a server error keeps it. A newer member list replaces an older one for the same device. A handover is not queued: it must be acknowledged by the new host or it fails, so there is never a half-moved host. A queued leave keeps the member secret until it is delivered.
- **Access on a device.** The device owner's choice at join (`level`, `folders`, and for a collaborator `grantRole` viewer or developer, default viewer) applies to every other member of the room. Admin means those members are listed in `trustedAdmins` of `GET /api/room` and nothing else is created. Collaborator means one `collaborators.js` grant per other member (first folder is the repository, up to five more are read-only extra folders, no expiry, field `room: { id, deviceId }`). Grants are made when a member joins, revoked when it leaves or is kicked, and revoked on every device when the room entry goes. If the folders cannot be shared (not a Git repository, outside the file roots, 50 grants reached) no grant is made and the reason is in `accessErrors`.
- **Not done.** `trustedAdmins` is a record, not yet a login: no code reads it to let a member into the admin routes. Room grants cannot be used with an invite link. Grants stay `inactive` until role-based sharing is enabled on the Mac, as for every grant.

### Open: how a room member authenticates at a device

A grant is bound to a device id, but a person opening another device's link has only a browser. Options, none chosen:

1. The member's own device vouches: the browser asks its home device for a short-lived signed proof (signed with a key whose public half is stored in the room), and the target device checks it against the room list. No password crosses devices; needs a key pair per device.
2. A one-time link from the target device's owner, using the existing invite flow, bound to the member's grant. Works today but needs the owner each time.
3. A room-wide login (earlier idea, replaced in the decisions above) with its shared-cookie problem.

Also open: whether `trustedAdmins` members skip the Mac's approval step, and what a member sees when the grant is `inactive` because role-based sharing is off.

## Step 3, part 2: the platform layer (decisions)

All system calls go through `platform.js` (`createPlatform`, with injected `run`, `exists`, `readText`, `listDir`, `networkInterfaces`, `memory`). `POCKET_DEV_PLATFORM=linux|win32|darwin` makes a server behave as that system. `platform.capabilities()` returns `{ available, reason }` for every capability; an action called without its capability rejects with `Not available on this system: <reason>` (HTTP 501 from the power routes; 503 for the screen). `GET /api/power` and `GET /api/health` carry `unsupported: { capability: reason }`, and the Power, Health and Open apps screens show "Not available on this system".

Decisions made without the owner:

- Mac behavior is unchanged: the same programs, arguments and timeouts. The `POCKET_DEV_PMSET`, `_IOREG`, `_OSASCRIPT`, `_TOP`, `_MEMORY_PRESSURE`, `_SCREENCAPTURE`, `_SIPS`, `_UPDATE_CHECK` overrides still work. `install-service.sh --print` was compared byte for byte with the old script for three environments.
- Keep awake: Linux `systemd-inhibit ... tail --pid=<server>`; Windows a PowerShell holding `SetThreadExecutionState`, waiting on the server pid. Neither can tell "while plugged in" from "always", so both hold in either mode.
- Sleep and shut down: `systemctl suspend|poweroff`, `rundll32 powrprof.dll,SetSuspendState` and `shutdown.exe /s /t 0`. The macOS update refusal is Mac only.
- Battery: `/sys/class/power_supply` on Linux, `Win32_Battery` on Windows. Temperature: Linux battery sensor only, none on Windows. Battery wear: Linux from sysfs, none on Windows. Lid state: Mac and Linux (`/proc/acpi/button/lid`); the "stay awake with the lid closed" switch is Mac only and is hidden elsewhere.
- Health: processor and disk were already portable (`os.cpus`, `fs.statfs`). Memory off Mac is the free share of installed memory, with no wired or compressed split.
- Open apps: Linux needs `wmctrl` (X11 only), Windows uses `Get-Process`. Quit is `kill -TERM` / `CloseMainWindow`. Window names are Mac only. Protected system apps are listed per system.
- Permissions: off Mac the list holds only the Claude, Codex and GitHub tool checks (not Mac permissions). The Mac probes stay in `permissions.js`; they were routed through `platform.macScript`, `platform.probeWindowAccess` and `platform.openUrl`, not moved.
- Screenshot and resize: Mac `screencapture` and `sips`; Linux a capture tool (grim, scrot, maim, ImageMagick `import`, gnome-screenshot) plus ImageMagick to shrink; Windows PowerShell and System.Drawing. Without both on Linux the Screen view says so.
- Service: Mac launchd (the install script remains, but its plist text now comes from `platform-service.js`); Linux a systemd user unit (`Restart=always`, 10 s); Windows a Task Scheduler task at logon that runs a PowerShell loop (the task cannot restart a clean exit, and Pocket Dev restarts by exiting). Files go in the user's own folders, no admin rights. A Windows service cannot report its pid, so the service sets `POCKET_DEV_SERVICE=<label>` and `isThisServer` uses that.
- Network: only a Mac announces `<name>.local`; elsewhere `urls().local` is null and the address is used. Docker, VM and VPN-style interfaces are listed last (Linux) or skipped (Windows names).
- Terminals: `platform.shellArgs` gives `-l` for login shells, `-NoLogo` for PowerShell, none for cmd. `args` is a new optional field of the host's create message; a host started before this change ignores it and uses `-l`. On Windows the host listens on a named pipe.
- Port owner: `lsof`, else `ss` (Linux), PowerShell `Get-NetTCPConnection` (Windows). Takeover's process scan is off on Windows (listed as unsupported).
- `package.json`: `os` allows darwin, linux, win32; `postinstall` is now `node scripts/postinstall.js`, which never fails.

Not verified (no Linux or Windows here): every Linux and Windows command and PowerShell script was only checked as text with an injected runner; the real output formats of `wmctrl`, `ss`, `systemctl show`, `Get-CimInstance Win32_Battery`, `Get-ScheduledTask`, ConPTY terminals and the named pipe are assumed. Still Mac only: `scripts/lid.sh`, `sleep.sh`, `shutdown.sh`, `status.sh`, `autostart.sh`, `uninstall-service.sh` and `bin/pocket-dev.js service ...` (they call launchctl or pmset); `pocket-dev service install` on Linux or Windows has no CLI route yet, only the admin page route through `installService`. `folder-browser.js` still lists Mac folders (`/Volumes`).
