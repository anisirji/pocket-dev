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
- Chat (`/ws/chat/<id>`) and messages (`/ws/messages`) sockets use the same pipe as the terminal socket, but only the terminal socket and a Range download are covered by tests. HTTPS addresses (tunnel) use `https.request` and were not run.
- The pages do not know about `/m/`: absolute `/api/...` and `/ws/...` URLs in the pages, redirects with a `Location` header, and per-machine storage keys all need the shim from step 5 (UI).
- A kick does not close sockets that are already open through a forward; new requests are refused at once. A front device that is logged out does close its forwarded sockets.
- Rank lookups on a member use the member list it last got from the host, so a very recent change can take up to one ping interval to reach it. The host checks membership live.
- An admin peer reaching a device can use the device's collaborator-management routes, as any admin device can (the target owner chose that when granting admin level).
- If role-based sharing is off on a collaborator-level target, the member gets the usual "expired" answer for guests. The open authentication question above is answered by this design for forwarded requests; a member opening another device's address directly in a browser still has no login there.
- Messages and tasks are not forwarded: they already sync through the room.
