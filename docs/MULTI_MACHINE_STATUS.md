# Pocket Dev multi-machine: status for the owner's test (2026-11-09)

Branch `mm-int` (worktree `.claude/worktrees/mm-int`). Not merged into `live`; the live service was not changed by this work. Full suite on this branch: 402 tests, 400 pass; the 2 failures are the known "over the connector a file may be 100 MB" test and its parent. Every Linux and Windows path was only tested with fake commands. Nothing ran on a second real machine.

## Built
- Rooms: create, invite (single-use 10-minute code), join with a chosen level (admin, or collaborator with folders), kick, leave, hand over. One host per room, one room per device.
- Liveness: timed pings, online/offline, retried kick and update notices.
- Access: admin level recorded; collaborator level creates a real collaborator grant, removed on leave or kick.
- Forwarding: `/m/<deviceId>/...` for HTTP, downloads with Range, uploads and WebSockets (terminal, chat, messages), one hop through the host. The target applies the rank its own owner gave the member.
- Phone: Room screen, device switcher with page shim, tasks page, room chats page, messages origin mark, mode controls, Bypass banner, approvals inbox, agents panel in chat (separate merge into live).
- Tasks (ids like `LAP-14`), messages and AI chats replicate between devices through a sync log with no database. Chats go only from admin-level devices and are read-only mirrors.
- Modes: read-only, plan, ask, auto, bypass (1, 2, 3, 4 hours or always, banner, room-wide needs a second confirmation), approvals inbox, audit log.
- Hardening: open sockets close on kick, failed-secret limits, body limits, host-down behavior.
- Platform layer: trash, open URL, shell, zip, power, health, screen, apps, service install for Mac, Linux and Windows, "not available on this system" where there is no equivalent. package.json no longer limits to darwin.

## Gaps and risks (to discuss)
1. Star topology: members reach each other only through the host. If the host is down, members only serve their own device. This is narrower than "no single point of failure".
2. Domain failover is not built or tested (same tunnel on several devices away from home; address list at home).
3. No real Linux or Windows run. Command output formats (wmctrl, ss, systemctl, Win32_Battery, Task Scheduler, ConPTY) are assumptions. Several scripts and the `pocket-dev service` CLI are still Mac only.
4. No second real machine, no real phone browser, no tunnel/HTTPS test. Everything ran on 127.0.0.1.
5. Admin-level members count as admin on that device, including collaborator management.
6. Modes classifier is pattern based and can be fooled. Terminal input is not checked per keystroke; modes decide whether the terminal can be opened. Pending approvals live in memory and are lost on restart.
7. Replication: leaving or being kicked while offline keeps copies until the device reaches the host; data of a kicked member stays in other devices' logs and is only hidden; each log is held in memory and nothing runs `shrink()` on a schedule; chat mirror does not update live; no pagination.
8. Direct messages across devices are not built.
9. Fixed on mm-final-ui: the strip name is a pill that opens the sheet on every screen; the header chip shows only on another device, with a readable width (see the plan, Final UI pass).
10. The "Work on" sheet opening by itself: not reproduced; likely causes removed (layout shift, strip tap), sheet now closes on page show. See the plan, Final UI pass.
11. A forwarding test failed once under heavy CPU load and passed on rerun.
12. The agents panel counts an agent as running if it acted in the last 90 s when the SDK sends no status; real Claude does send task messages.
13. Bypass is only the owner's to enable; there is no per-folder limit in Bypass by design.

## Try it
`node /Users/ani/Desktop/POCKET-DEV-ROOM-DEMO/start.mjs` starts three separate copies (Home Mac, Studio PC, Work Linux box) from this branch with a room already formed, three tasks, a message and a chat; password `test-password` for each. They have their own data and ports; your real app is untouched. Stop with `pkill -f POCKET-DEV-ROOM-DEMO/start.mjs`.
