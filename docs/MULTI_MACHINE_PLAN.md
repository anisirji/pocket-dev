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
