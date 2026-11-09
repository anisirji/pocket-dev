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


## Forwarding through the room (built 2026-11-09, branch mm-fwd)

Decisions made without the owner; change them here if they are wrong.

- **Shape.** The phone logs in at any device it can reach (the front). `/m/<deviceId>/<path>` on the front is passed to that device, for HTTP (any method, streamed bodies, Range, status and headers) and WebSocket upgrades. The room is a star: the host forwards to any member with the host's secret for it; a member forwards to the host with its member secret, and the host forwards to the target with the host secret. At most one hop through the host; a path that itself starts with `/m/`, a request to oneself, and a relay by a member are refused with 508 or 400.
- **How the target knows who is asking.** Headers `x-room-id`, `x-room-sender` (who holds the secret), `x-room-secret`, `x-room-from` (the member the request is for). A member sending to the host can only name itself. The host sending to a member may name any member of the room (it vouches). Bad or missing secret, a member that is gone or removed, or an unknown origin: 403. Requests with none of these headers are handled exactly as before (the test "requests without the room secret behave as before").
- **Rank at the target is the target owner's choice at join.** `admin` level: the request acts as a virtual owner device (`auth.deviceFor` returns it, only for that request, never from a cookie). `collaborator` level: `collaborators.guest(req)` returns the member's room grant, so the existing guest policy applies (files and messages, granted folders, viewer or developer, same path checks and revocation). A host that relays for a member gives it no host power: the host's own rank on the target is the target's `level` too.
- **Never reachable through a peer request, whatever the rank:** `/api/room/*` (kick, leave, handover, invite), `/api/local/power`, and the login-owned routes (`/api/devices`, settings that need a cookie). `GET /api/status` answers `active` for an admin peer so a page can start.
- **Front checks.** On the front, `/m/` requires: `x-pocket-dev: 1` and same origin on mutating methods, a logged-in owner device (a collaborator cookie is refused), then forwards. The front's cookie, Host, Origin, Referer, `x-forwarded-*`, `cf-*` and any `x-room-*` the client sent are dropped; the target's `set-cookie` and hop-by-hop headers are dropped on the way back. Origin is rewritten to the target's only when the client sent one.
- **Addresses.** The target's `addresses` list is tried in order with a 3 s TCP probe; the one that answered is remembered for 20 s. No answer: 502 with `{ error: "<name> is not reachable right now.", deviceId }`. An upstream that stalls for 60 s or fails mid-way is a 502 if nothing has been sent, otherwise the connection is cut.
- **`GET /api/room/devices`** (`?live=1` pings first): `deviceId` and `devices[]` with `name`, `role`, `online`, `self`, `rank` (`owner` for self, otherwise the level that device gave: `admin` or `collaborator`, plus `folders` for a collaborator), and `path` (`direct` or `host`).

### Not done or not verified

- Not checked in a browser or on two real machines. Tests run three servers on one Mac over 127.0.0.1.
- HTTPS addresses (tunnel) use `https.request` and were not run. (Chat and messages sockets are now covered, see Hardening.)
- The pages do not know about `/m/`: absolute `/api/...` and `/ws/...` URLs in the pages, redirects with a `Location` header, and per-machine storage keys all need the shim from step 5 (UI).
- Rank lookups on a member use the member list it last got from the host, so a very recent change can take up to one ping interval to reach it. The host checks membership live.
- An admin peer reaching a device can use the device's collaborator-management routes, as any admin device can (the target owner chose that when granting admin level).
- If role-based sharing is off on a collaborator-level target, the member gets the usual "expired" answer for guests. The open authentication question above is answered by this design for forwarded requests; a member opening another device's address directly in a browser still has no login there.
- Messages and tasks are not forwarded: they already sync through the room.

## Message and chat replication (built 2026-11-09, branch mm-chats)

Decisions made without the owner (he would not answer); change them if he disagrees.

- **Transport.** `room-sync.js` is the one transport over the room star (member to host, host relays), used by three channels: `tasks`, `messages`, `chats`. Each channel is a sync-log file in the state folder (`tasks.jsonl`, `messages.jsonl`, `chats.jsonl`). Peer routes are `POST /api/room/sync/<channel>/push|pull|blob`; the old `sync/push|pull` still means tasks. Catch-up is a pull then a push at start and every `POCKET_DEV_TASK_SYNC_MS` (30 s).
- **Leave, kick, host leaving.** `room.onDrop` runs when the room entry is removed on a device. Every channel file is deleted and derived data goes (copied messages, mirrored chats, cached blobs). This also fixes tasks: `tasks.jsonl` is now cleared on leave, so old tasks cannot sync into another room. A removed device sends nothing: it is not in the member list, so the host never pushes to it and its secret is refused. A device that is offline when kicked keeps its copies until it next reaches the host (same limit as before: no remote erase).
- **Counter floor.** Because a log is deleted on leave, the device remembers its highest used counter in `<channel>.jsonl.floor` and never reuses it. Without that, a device that rejoins the same room would write changes the others already hold under those ids and ignore.
- **Messages.** Global id is `<deviceId>:<seq>`, computed on demand, nothing is migrated and `messages.jsonl` keeps its format. Only messages to Everyone written after this device joined the room are shared; direct messages never leave the device (other devices' people are not in the local people list, so there is no one to address). Participant keys are mapped to `<deviceId>:<localKey>`. A copy is stored in the local store as a message with `origin: {device, seq}` under a local seq, so `/ws/messages`, cursors, hide and Clear all work unchanged; its `from.name` reads `Name (Device)`, and the view carries `gid` and `origin`. `canSee` is untouched. Only the sending device deletes (tombstone); a copy answers 403 to DELETE and can be hidden or cleared locally. Attachments: metadata at once, bytes fetched on first open through the host and cached in the normal files folder.
- **Chats.** Replicated only from a device whose own level in the room is `admin` (the level applies to every other member); a collaborator-level device shares none, and nobody receives its chats. Checked on send, on relay and on receive. The owning device is the only writer. Mirrors are read-only: `GET /api/room/chats`, `GET /api/room/chats/:deviceId/:chatId` (with events), `GET .../blob/:id`; other methods answer 405 and the chat is not in `/api/chat`, so it cannot be resumed there. The session id, grants and settings never leave the device. Events go out when settled (a streaming event waits), after a quiet time of `POCKET_DEV_CHAT_SYNC_MS` (500 ms, at most 4x that), keyed `<device>/<chatId>/<eventId>`; an event that leaves the 1500-event window gets a tombstone; deleting a chat tombstones it. Events over 40 KB are cut (`truncated: true`). Pictures and attachments: the event carries `blobs[id] = {size, type, sha256}`; bytes come on request, checked against the hash, cached under `room-chat-blobs/`. `POCKET_DEV_BLOB_MAX` (default 10 MB) caps a blob; larger ones show `tooLarge`.
- **Sync log.** New `shrink()` drops the value of changes that lost to a newer one (ids and counters stay), so a chat edited many times does not keep every version.

Gaps, honestly:

- Not tested: the 1500-event window removal, tombstone of a chat while a member is offline, host handover with chats, a device with several addresses, real network (everything ran on loopback), long streaming turns.
- Direct messages to people on other devices, and `trustedAdmins` as a login, are not built. A collaborator-level device's own guests still see messages locally as before.
- Replicas of a member that was kicked stay in other devices' log files and are only hidden (the reader checks current membership); they are not erased. Hide-per-viewer (`hiddenFor`) is local.
- Memory: each channel log is held in memory in full. `shrink()` exists but nothing calls it on a schedule yet.
- A mirror shows the device's `cwd` path; the UI is not built.

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


## Phone side: machine switcher and page shim (built 2026-11-09, branch mm-switcher)

Decisions made without the owner; change them here if they are wrong.

- **One shim, no call-site edits.** `public/machine.js` is the first script on `index.html`. It patches `fetch`, `XMLHttpRequest.open`, the `WebSocket` constructor, the `src` and `href` setters (img, media, iframe, source, a) and `setAttribute`, and `Storage.prototype` get/set/remove. Pure parts (`PocketMachine.rewriteUrl`, `storageKey`, `blockedFor`, `allowedViews`) are tested in `test/machine.test.mjs`.
- **Switching reloads the page.** The choice is stored in `localStorage` key `pd.machine` (global, per phone) and the page reloads without its hash, so terminal, git, chat, files and messages all start fresh against the new device. If the remembered device is no longer in the room, the page goes back to this device.
- **What is forwarded.** Same-origin `/api/...` and `/ws/...` become `/m/<id>/...`. Always kept on this device: `/api/room`, `login`, `logout`, `devices`, `local`, `network`, `settings`, `invitations`, `collaborators`.
- **Settings and Ports are hidden on a remote device.** They describe the device the phone is logged in on; ports links would also point at the wrong host. Switch back to change them.
- **Storage.** On a remote device every key is stored as `m.<id>:<key>`; on this device keys are unchanged, so existing users lose nothing. `pd.machine` and the cached device list are global.
- **401 and 403.** A forwarded 401 is turned into a 403 unless this device's own `/api/room/devices` also says 401, so a refusal from the other device does not send the phone to the login page. A 502 with this device's id in the body shows the "<name> is not answering" banner with "Back to this device"; any later good answer hides it. `forward.js` now prefixes a root-relative `Location` with `/m/<id>`.
- **Collaborator rank.** On that device Terminal, Git, Chat, Settings, Ports and Resume are hidden, the page opens Files, and a small home with Files and Messages buttons replaces the terminal. Calls outside files, messages, status and folders are answered locally with 404 and never sent: the status strip treated a 403 as "logged out" and sent the phone into a login loop (seen in the browser check).
- **Chip.** Hidden when the room has fewer than two devices. Offline devices are greyed and cannot be picked; the reason is "Not answering right now" (the device list carries no last-seen time).

### Not done or not verified

- Checked in headless Chrome at 390x844 against three local test servers (this device, an admin device, a collaborator device, one killed to show offline). Not on real hardware or a real phone, not over the tunnel.
- Git, Chat, Messages and Files on a remote device were later checked in headless Chrome (see Hardening). Still not exercised in the browser: image downloads and the upload XHR on a remote device (rewrite covered only by unit tests).
- `location.replace('/login.html')` calls in individual scripts cannot be patched; they only fire on a real 401 on this device or on 403 from `macstatus.js` for allowed calls.
- Ports of a remote device and Settings of a remote device are not reachable from the phone.
- `login.html`, `guest.html`, `invite.html` and `admin.html` do not load the shim: login and invite belong to the device that is opened, admin runs on a local-only port.

## Hardening pass (built 2026-11-09, branch mm-harden)

Decisions made without the owner; change them here if they are wrong.

- **Sockets follow the room.** `room.js` has `onChange` (called when members, host or this device's membership change: kick, leave, handover, members list, ping catch-up, drop) and `snapshot()`. `forward.js` keeps every socket that exists because of the room: the pipes it passes on (front and relaying host) and sockets that arrived with a room credential (`forward.watch`, called from the upgrade handler). A socket is closed when the room id or host changed, or when its origin member, or the target of a pipe, is no longer a member. So a kick closes the kicked member's sockets on the host, the front pipe on the kicked device, and the sockets the host opened on another member for it; a handover closes everything that went through the old host (they reconnect through the new one). Plain HTTP requests in flight are not cut.
- **Host down.** A member's own device keeps working. A request for another device gets a 502 JSON that names the host when it is the host that cannot be reached ("Host, the host, is not reachable right now, so Beta cannot be reached through it.") and returns at once on a refused connection. A target that accepts the connection and then says nothing gets a 502 after 30 s (`answerMs`) counted from when the whole request was handed over, so a slow upload is not cut; an open response is cut after 60 s of silence as before. In the device list a member marks every device except itself offline while the host is offline, because nothing else is reachable.
- **Abuse limits.** Failed attempts (403) on `/api/room/ping|accept|notify`, `/api/room/sync/*` and on forwarded requests carrying `x-room-*` are counted with the login limiter (`createLoginLimiter`, now exported with parameters) in `peer-guard.js`: 10 failures per address and claimed device (sender, or the joiner's id for a join code), 40 per address whatever it claims; then 429 for the window (15 min, `POCKET_DEV_PEER_LOCK_MS`). A success never clears a count. The lock covers the right secret too, as the login does. A 429 is not treated as "arrived" by the host's outbox, so a kick note is retried. A device that spoofs another's id from the same address can lock that id out from that address only. JSON bodies over 64 KB (all JSON routes) now get a 413 with a reason instead of a reset. All secret comparisons in the room code go through `same()` (timing-safe, on hashes); join codes and tokens are looked up by hash. Forwarded bodies have no limit here (the target applies its own; uploads stream).
- **Wording.** `PocketMachine.sayFor/say` rewrites "the Mac", "this Mac", "Mac", "your Mac password" in the status strip, the health sheet and the power texts to the remote device's name (to "the device" if the name is not cached yet; it is cached once the list has loaded, so only a hand-set `pd.machine` shows that). Readings (values, the device's own name) are not rewritten.
- **Chip while Files, Chat or Messages are open.** Those screens cover the header. The status strip stays above them, so its first word is now the switcher: it shows the device name with a small arrow whenever the room has two or more devices (on this device too), and a tap opens the same sheet. The header chip is unchanged.

### Not done or not verified (hardening)

- The tests run three servers over 127.0.0.1, so the per-address limit sees one address; the real address logic (`cf-connecting-ip` through a tunnel) is the login's and is not retested.
- Headless Chrome at 390x844 on one Mac: Git, Chat list, Messages list and Files on the host as seen from a member, and the switcher opened from Files. Not driven: typing in a chat, the Git diff and Changes tabs, a member to member remote, offline states in the browser, a real phone, the tunnel.
- The Messages view of a remote device lists the directory entries of that device ("Mac", "Unknown device"); that naming comes from messages.js and was not changed.
- Role access is covered with each device's phone kept as Admin through the local enable route. A phone left waiting is refused as a front door (tested). Other approval flows between forwarded devices are not tested.
- Sockets opened by a plain HTTP stream (downloads) are not closed on a kick; the request ends by itself.
- Flaky: no failure seen in the forwarding tests in three full-file runs while other agents were running suites, but the host-down test relies on timers (1.5 s ping) and could be slow under heavy load; it only gets stricter, not looser, when delayed.
