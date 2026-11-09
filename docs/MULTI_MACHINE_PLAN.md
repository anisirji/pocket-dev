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

## Room pages (built 2026-11-09, branch mm-room-pages)

- **Files.** `public/room-pages.js` (pure helpers exported for `test/room-pages.test.mjs`, page code runs only in a browser) and `public/room-pages.css`. Loaded by one module script tag in `index.html` and two entries in the server page allowlist. The pages open as a full-screen layer over the app (below the Mac status bar), so they work from Settings and from the header.
- **Entry points.** Tasks and Room chats buttons in the Room screen (when in a room); a header button (checkbox glyph, next to the gear) that is hidden unless `/api/room` reports a room, rechecked every 30 s and when the page becomes visible.
- **Tasks.** Grouped To do / Doing / Done, newest edit first. Card shows id, title, assignee ("You", member name, "Unassigned", "Left the room") and creator. One-tap status row on each card, tap the card to edit (title, description, assignee, status, delete with confirm). Filter All / Mine (assigned to this device). Polls every 5 s while open and no form is open. Tasks from offline devices appear as normal because they are synced.
- **Room chats.** List from `/api/room/chats` (device name, title, last activity, "Read-only" badge), open one to read it: text, tool runs and edits collapsed, a banner saying it is a copy owned by the other device, no composer. Pictures show a placeholder button and are fetched only when tapped (blob route); `tooLarge` and missing blobs show a note. Thinking events and streaming placeholders are not shown. Empty state explains that only Admin-level devices share chats.
- **Messages.** A "from <device>" mark in the bubble footer for messages with `origin` (`messages.js`, 1 line; `messages.css`, 1 rule). The sender name already carried the device in brackets, so the mark is the only addition.
- **Decisions.** A compact own renderer instead of reusing `chat.js` (it is tied to a live conversation object). Default assignee for a new task is this device. Deleting asks with `confirm()`.
- **Gaps.** Mirrored chats are rendered once per open and refreshed only by going back to the list (no live update of an open copy). No pagination for long chats or many tasks. No drag between columns. The header glyph is plain text, not an SVG like its neighbours. Not tried on a real phone or Safari; only headless Chrome at 390x844 on loopback. Downloading a non-image attachment from a mirror opens the blob URL directly (not exercised).

## Permission modes and Bypass (built 2026-11-09, branch mm-modes)

Decisions made without the owner (he would not answer); change them if he disagrees.

- **Where it runs.** `modes.js`, on the target device, for every request that arrives with room credentials (`req.roomPeer`): HTTP in `handleApi`, terminal and chat sockets in the upgrade handler. A device's own owner is never gated. The state is `modes.json` in the state folder (0600, temp+rename); it is wiped when the device leaves the room, and ignored when the room id changes.
- **Modes per member per device.** `read-only`, `plan`, `ask`, `auto`, `bypass`. Default when nothing was set: `ask` if this device gave the collaborator level, `auto` if it gave admin level (an admin-level member already had full use before this feature, and the existing room tests rely on it). Set with `PUT /api/room/modes/:memberDeviceId` `{mode, bypassHours: 1|2|3|4|'always'}`; `:memberDeviceId` may be `all`. `GET /api/room/modes` returns `{members: [{deviceId, name, mode, default, bypassUntil (ms, 'always' or null), banner}], assigned, banner}`. A member sees only its own entry through `/m/<device>/api/room/modes`, so a phone can show the banner.
- **Classifier** (`classify`, pure). Reads (GET/HEAD, and the file list/search/download routes) pass in every mode. Read-only denies everything else (403, `code: mode-denied`). Plan answers 202 `{status: 'proposed', approvalId}`; once the owner or assigned person says yes, the member sends the same request again and it passes once (a yes lasts 10 minutes and is used up). Ask holds every change until answered. Auto lets it through unless risky. Bypass lets everything through.
- **Risky (asks in Ask and Auto, not in Bypass):** a path (body `path/cwd/dir/from/to/dest/paths`, or the same in the query) outside the granted folders (a device with no folder list, an admin-level one, has no such limit); a delete outside them or of a directory or a file over 50 MB; a command text with a recursive delete, a download-and-run pattern (`curl`, `wget`, `| sh`, `chmod +x`, `./x`, `npx`, `docker run`, `git clone`), an install or system setting change (`brew/apt/pip/npm -g install`, `sudo`, `defaults write`, `launchctl`, `pmset` ...); and routes that change the machine or access (`/api/power`, `apps`, `forwards`, `admin`, `devices`, `collaborators`, `handoff`, `connection`, `network`, `settings`).
- **Approvals.** `GET /api/room/approvals` (`pending`, `recent`), `POST /api/room/approvals/:id {decision: allow|deny}`. Only the device's owner (a logged-in owner, not a room peer) and the assigned person may use them. First answer wins, a second one gets 409. Nobody answers their own request, not even the assigned person. A held request finishes with the request's normal result after a yes, or 403 `approval-denied`; after `POCKET_DEV_APPROVAL_MS` (default 5 minutes) it fails with 408 `approval-expired`; if the requester hangs up it is cancelled.
- **Assigned person.** `PUT /api/room/assigned {deviceId|null}` (owner only), `GET` returns it. It is stored in `modes.json`, not in `room.json` (room.js is untouched, other work edits it). The "person" is a member device; it reaches this device's approval routes through `/m/<device>/api/room/approvals`. The assigned person can change modes except Bypass and except their own.
- **Bypass.** Only the device's owner turns it on, with a duration (required). The next look at the mode, and a 30 s timer, return it to `auto` when time is up and log `room-mode-changed` by `timer`. The banner flag is in `GET /api/room/modes`. A member in Bypass is ranked as an admin device on that target (so a collaborator-level device is opened to everything an admin device can reach, private zone included). `/api/room/*` (kick, leave, ...) and `/api/local/power` stay closed to peers even then. Whole-room Bypass: `PUT /api/room/modes/all {mode:'bypass', bypassHours, confirm:true}` returns 202 with a `confirmToken` and changes nothing; only a second call with the same body plus `confirmToken` (valid 60 s) applies it. Without `confirm: true` it is 400.
- **Not asking for what a role forbids anyway.** On a collaborator-level device, a route a guest can never use (terminals, sessions, settings) and file writes for a viewer grant go straight to the existing role policy and fail there, with no approval, so the owner is not asked about something that would be refused.
- **Audit.** Security log events `room-action` (every non-read request from a member: allowed, denied by mode, waiting, proposed, refused by role policy), `room-approval` (answer, who by, expiry), `room-mode-changed`. Fields include the device, the member, the action text and the result. Reads are not logged (volume).

Gaps, honestly:

- The terminal socket cannot be judged per keystroke. Read-only and Plan refuse opening it, Ask holds one question for opening it, Auto lets it open. A command typed into an open terminal is not classified. The command text is only checked when it comes in a request body (session creation with a `command`, chat messages).
- The classifier is pattern based and can be fooled (an obfuscated command, a script that does the download). It is a guard against mistakes, not a sandbox. "Big" for a delete is any directory or a file over 50 MB, not a measured tree size. Git routes are checked for paths only (a push is a normal change); `git clone` is flagged only as a route that is not known to exist.
- Held and proposed approvals live in memory: a restart drops them (the held request fails when the connection closes). Modes, the assigned person and Bypass expiry persist.
- Chat's own per-chat approval cards (`POST /api/chat/:id/answer`) are separate: a member answering one is a change like any other and goes through its mode.
- Auto does not confine work to a sandbox folder beyond the folder checks above; the copy a developer grant works in is the existing mechanism.
- Not checked: the Bypass banner on the device's own page (UI), Plan or Ask over a real WebSocket terminal, behavior when the assigned person's device is offline (they simply cannot answer; the owner can), host handover while approvals are pending.

## Modes UI on the phone (built 2026-11-09, branch mm-modes-ui)

Decisions made without the owner; change them if he disagrees.

- **Files.** `public/modes-core.js` (pure helpers, shared, tested in `test/room-modes-ui.test.mjs`: time left, banner text, who may change what, plain-words request descriptions, errors), `public/room-modes.js` + `.css` (mode controls inside the Room screen), `public/room-approvals.js` + `.css` (inbox and header bell), `public/room-banner.js` + `.css` (Bypass strip). `room-screen.js` only gets a place for the mode controls and an Approvals button; `server.js` and `index.html` only got allowlist entries and tags.
- **What the Room screen shows.** "What other devices may do here": one row per other device with a chip (Read-only, Plan, Ask, Auto, Bypass; Bypass shows the time left counting down), a one-line explanation, and Change. Change opens a sheet with the five modes and their explanations. Bypass goes on to a duration sheet (1, 2, 3, 4 hours, Always) under a red plain warning. "Change for everyone" is the room-wide version: after the duration the server hands back a confirm token and the phone shows a second sheet ("Are you sure?"); only its red button sends the token. "Who answers for this device" is a list of the other devices plus "Only me" (owner only).
- **Who sees what.** The phone's logged-in owner controls this device. A device that was named to answer for another one gets a section "On <device>" with Change on every row except Bypass and its own row. Everyone else sees one read-only line: their own mode on that device and that only its owner can change it. This is found by asking `/m/<id>/api/room/assigned` of every other device (cached 30 s) and then `/m/<id>/api/room/modes`; the server still decides, the UI only hides what would be refused.
- **Banner.** `GET /api/room/modes` every 15 s (not while the page is hidden), time left counted locally each second, shows while any member is in Bypass on this device. It sits inside the Mac status strip (`#macStatus`) so every full-screen layer already leaves room for it; with no strip it is fixed to the top. "End now" sets each member in Bypass back to Auto. A failed check keeps the last state, so a bad connection does not hide a warning. It shows this device's Bypass only, not other devices the phone is working on (the banner would need the forwarded call per device).
- **Approvals.** A bell in the header appears only while something waits here, or on a device that named this one to answer. The inbox polls every 5 s while open and 8 s for the bell (not while hidden). A card says who asked (and on which device), what in plain words, why it is risky, how long it has waited, Allow and Deny. When someone else answers first, the card turns into "Already answered by <name>" and goes after 6 s; a card this phone answered goes at once. Empty, "could not check" (with the last known cards) and offline states exist. The inbox does not use the app's back-button history, so the phone's back gesture does not close it (use the cross).
- **Summary text.** `modes.js` now puts the folder or file in an approval's one-line summary for mkdir, rename and similar requests (`dir`+`name`, `from`, `dir`, `cwd`, `repo`), so the card can say "Create folder x".

Not verified or left open: the real iPhone Safari (only headless Chrome at 390 x 844 was driven), the bell and sheets with the on-screen keyboard (the bell takes the Tasks button's place in the header while something waits: no room for both at 390 px), a collaborator-level device's own phone (no folder grants were used in the browser run), the assigned person's device going offline mid-answer (the card shows a plain error), and the "Work on" switcher sheet: it opened once by itself during a scripted run after closing Settings; this was not traced to this change.

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

## Invite and join experience (built 2026-11-09, branch mm-join-ux)

Decisions made without the owner after he tried it on real devices; change them here if they are wrong.

- **Short code.** 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 characters, no 0, O, 1, I, L), shown `ABCD-EFGH`. Accepted in any case, with or without hyphen or spaces (`normalizeCode`). Single use, 10 minutes, stored as a SHA-256 hash of the normalized code. Legacy 43-character codes are dropped (a room code only lives 10 minutes). The existing peer guard is the guessing limit: 10 wrong tries per address and claimed device, 40 per address, then 429 (tested). About 8.5e11 codes against 40 tries per lock window.
- **Errors tell codes apart.** `/api/room/accept` answers 403 with `code`: `wrong-code`, `used-code`, `expired-code` (spent and expired codes are remembered for an hour so the joiner is told which it was). A host that cannot be reached answers 502 `unreachable` with "Could not reach the host at <address>"; the phone adds the three likely causes (same Wi-Fi, firewall and port, wrong port).
- **One-line invite.** `192.168.1.24:58765  ABCD-EFGH` (`inviteLine`), copied, shared (`navigator.share` when present) and encoded in the QR. `parseInvite` in `public/room-invite.js` (pure, used in browser and node) reads a URL plus code, `host:port code`, `host:port/code`, or a code alone, in any case, with http or https, trailing slashes and odd spacing. A code alone reveals a separate host field.
- **Host address.** `POST /api/room/invite` returns `address`, `addresses` and `invite`. The server picks, in order: the address the request came in on (Host header, `x-forwarded-proto`) when it is not loopback, the Wi-Fi address, the internet address, the .local name, then the address stored for the host. Never 127.0.0.1, localhost or ::1. No usable address: 409 `no-address` with plain words. Create and join use the same rule for the member addresses when the UI sends none, and refuse loopback addresses (400 `loopback`). `GET /api/room` carries `advertised` (the addresses this device would tell the others) and `allowLoopback`.
- **Loopback opt-in.** `POCKET_DEV_ROOM_ALLOW_LOOPBACK=1` allows loopback addresses (tests and demos run every server on 127.0.0.1). `test/helpers/server.mjs` sets it; the demo script sets it. `createRoom` takes `allowLoopback` for in-process tests. The join form blocks a loopback host before any request ("127.0.0.1 means this device itself. Use the Wi-Fi address of the host, like 192.168.1.24:7777") unless the server reports `allowLoopback`.
- **Callback check.** After a successful accept the joiner pings the host with `check: true`; the host calls the joiner back on each of its addresses and returns `callback: {ok, address, tried}`. A join response carries it. When it failed the screen says "Joined, but the host cannot reach this device at <address>" with an editable address and "Save and test" (`POST /api/room/address`, which tells the host through a `notify` of type `address` and checks again). The joiner stays in the room (a retry or an address fix repairs it); nothing is silent.
- **Room screen.** Room is its own full-screen layer (`openRoom()` in `public/room-screen.js`), opened by a "Room" row at the top of Settings (shows "Not in a room", "Host of 2 devices"...) and by the header button (the old tasks button, glyph changed; Tasks and Room chats are now buttons in the screen). First view: status line, devices with online dots, one main button (Join a room, Add a device, Leave). "Start a room on this device" is a quiet second button. Below: Shared work (Tasks, Room chats, Approvals), and an expandable "Permissions" area holding the mode controls and the assigned person (loaded when first opened). Per-device Make host and Remove sit under "Manage". "Add a device" and "Join a room" are bottom sheets. The invite is made when the sheet opens; "Get a new code" makes another; the sheet says "<name> joined" when a device arrives. Wording: "device" and "invite".
- **Scan (owner request).** The join sheet has "Scan QR with camera" (rear camera, live preview, Cancel, tracks stopped when the sheet or screen closes) and "Choose a photo of the QR" (`<input type=file accept=image/* capture=environment>`, works on any page). Decoding: `BarcodeDetector` when present, else vendored jsQR 1.4.0 (`public/vendor/jsqr`, Apache-2.0, not MIT; licence file kept next to it). On a plain http LAN page the camera button explains "The camera needs a secure page. On this device open http://localhost:<port>, or choose a photo of the QR instead." Permission denied, no camera and camera busy have their own messages.

### Not verified (join experience)

- Real phones and a real Windows PC. Headless Chrome 390x844 on one Mac only. Camera tested with Chrome's fake camera fed a Y4M of the invite QR (decoded and filled the field); a real lens, focus and glare were not tested. The "secure page" explanation is covered by a unit test, not shown in a browser on a non-localhost address.
- Firewall behaviour on Windows. The "host cannot call you back" case is tested with a dead address, not a real firewall.
- `navigator.share` sheet (the Share button appears in headless Chrome but the system sheet cannot be driven).

## Final UI pass (branch mm-final-ui, 2026-11-09)

Checked in headless Chrome at 360, 390 and 430 px wide by 844, against three real test servers in one room (host, an admin member with a long name, a collaborator), with a Bypass banner, a held approval and two tasks present. Screenshots were read, not only measured.

### Decisions
- **Device name.** The status strip's first word is now a pill (dot, name, caret, 26 px tall, tap area about 44 px) that opens the same "Work on" sheet. The strip sits above every screen, so the current device is visible on Files, Chat, Messages, Settings and the rest. At home it shows only when the device is in a room; with no room it reads "This device" and does nothing.
- **Header chip.** Measured: at 360 px the header holds the five view buttons, Resume, Room, Settings and Ports with 4 px to spare, so no chip can keep a readable width there at home. The header chip is therefore shown only while working on another device, where Ports and Settings are hidden and free about 80 px; it has a minimum width of 84 px (94 px at 360, 124 at 390, 160 at 430). Before: a dot and a cut-off letter at 390; kept in `shots/chip-before` of the test run (not in the repo).
- **Sheet opening by itself.** Not reproduced without a tap: 6 s soak at each width left it closed. Two causes found by reading: (1) the chip appeared asynchronously after the room list loaded and moved the header buttons, so a scripted tap at a stored position hit the chip; the home header no longer changes when the room list loads. (2) The strip name opened the sheet and the rest of the strip opens Device health, so a script tapping the left of the strip got the sheet. The pill is now an obvious separate control. Also: the sheet starts hidden on every page show, closes on `pageshow`, and owns one history entry. Checked: a tap on the right of the strip opens Health and not the sheet; chip tap opens it; back closes it. No in-repo test (the behaviour lives in browser code that node:test cannot run); the wording function is covered by `test/machine.test.mjs`.
- **Wording.** `PocketMachine.say` now words text for this device too: with the room's name for it ("Home not responding"), or "Device"/"the device" with no room. Literal "Mac" was replaced by "device" in Settings, phone access, restart text, network prompts, Files, Chat, Messages, Resume, folder picker, collaborators and the page-load error messages. Kept as Mac: the Screen Recording hint (a macOS setting), "Open on Mac" in Resume (about a terminal on a Mac), the Admin page notes, login page. The Messages participant named "Mac" in the data is shown as "Admin page".
- **Back gesture.** The Room sheets, the mode sheets, the approvals inbox, Tasks/Room chats and the device sheet each own one history entry through `pocketDev.overlays`. Checked: back closes the sheet and leaves the Room open; a second back closes the Room.
- **Keyboard.** One handler in machine.js scrolls a focused field of the Room, Tasks, mode, approvals and device sheets into view after the keyboard appears.
- **Tap targets.** Tasks status buttons, Bypass "End now", the offline banner button and Settings buttons are 44 px tall. Settings rows keep their own layout.
- **Mode text.** "This device on X" in Permissions is now "Access for this device" under the heading "On X".
- **Wrapped, not cut.** Device names wrap in the Room list and Permissions (nothing is lost); they truncate with an ellipsis in the pill, chip, sheet and Tasks.

### Not done or not verified
- power.js, health.js and the Mac-only words in their texts were left to the Windows work; strings there that do not go through `say()` still say "Mac" ("Shut down Mac", "Keep Mac awake", "Mac health" title).
- Real keyboard, real Android back, real safe-area insets, and real touch were not exercised; Chrome's touch emulation and `history.back()` stood in.
- The admin page (this device only) keeps its Mac wording.
- Settings still has a few 40 px rows from before this project; the new ones are 44 px.
