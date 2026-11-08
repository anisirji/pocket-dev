# Release validation

Validation date: 2026-11-07. Environment: macOS 14.5, Node.js 22, desktop Chrome and Chrome mobile emulation at 360 × 740.

## Results

| Suite | Result |
| --- | --- |
| Development integration harness: Git, terminal, history, authentication, QR, configuration, uploads, LAN changes, overlays, Power and Open apps | 33 suites, 805 assertions passed |
| Admin API and security | 168 assertions passed |
| Admin desktop/narrow UI and phone approval/blocking flows | 54 assertions passed |
| Files API, streaming, roots/symlinks, rename, zip and native Trash fixtures | 123 assertions passed |
| Files mobile UI, uploads/cancel, previews, search, selection, zip and terminal entry | 40 assertions passed |
| Chat validation and WebSocket lifecycle, without model calls | 20 assertions passed |
| Chat settings, navigation and shared-overlay UI with mocked model responses | 109 assertions passed |
| Repository regression suite (`npm test`) | 10 tests passed |
| Live Codex response on the merged server | Passed, including a repeat after the startup-error fix |
| JavaScript, inline script and shell syntax | Passed |

The development harness was run against fresh test servers with isolated settings and state. Assertions were updated for intentional changes such as folder-based terminal names, the six-character password minimum, the Admin startup line, the integrated Files entry point, and read-only Admin status sections. Terminal command assertions account for wrapping on a narrow screen. Power checks wait for the simulated password operation to finish.

## Fixes verified

- Login shells use a macOS-compatible UTF-8 locale even when the parent exports `C.UTF-8`.
- Chat persistence respects `POCKET_DEV_STATE_DIR`; an explicit `POCKET_DEV_CHAT_DIR` still takes priority.
- A Codex executable that cannot start rejects pending requests and falls back cleanly, rather than leaving Chat options waiting indefinitely.
- Blocked and pending devices cannot use protected APIs, scripts or sockets. Blocking and lockdown close chat sockets.

## Limits of this run

- Claude’s live release smoke test returned an account rate-limit error. Live Claude permission approval and shared-session resume were not reverified for this release. Model-free validation and mocked permission/resume UI checks passed.
- Browser tests used mobile emulation, not a physical Android device or its keyboard.
- Sleep, shutdown, lid-setting and update-guard tests used stubs. The test run did not perform real power actions or install a launchd service.
- App quit checks acted only on disposable test applications. Trash checks moved only fixtures and restored them.
- Test screenshots and logs remain local and are not included in the release.

## Run the repository checks

```sh
npm install
npm test
```

The repository suite uses temporary folders and disposable listeners, makes no model calls, and does not install a service or quit user applications. The broader development-harness results above are separate from `npm test`.

## Responsive layout regression

The model-free browser check is `node scripts/check-responsive.mjs`. It requires Playwright and a Chromium browser. Set `PLAYWRIGHT_MODULE` to an existing Playwright module path and `CHROME_PATH` to an installed Chrome executable if they are not available through the defaults. Optional `RESPONSIVE_SCREENSHOT_DIR` saves screenshots.

On 2026-11-07, Chrome emulation passed 14 sizes from 320 × 568 to 1920 × 1080, including phone landscape and tablet layouts. Checks cover terminal controls and the More menu, visual viewport resize/pan down to 240px, the last Settings action, Files, Chat creation, the final model option, and long question lists with Submit and the composer visible at 320px and 420px viewport heights. The repository suite passed all 72 tests. Physical phones and their native keyboards were not available for this run.

## Connection recovery

The recovery update adds deterministic checks in `test/connection.test.mjs` for wake, offline/online transitions, stale socket events, heartbeat and handshake timeouts, cancelling obsolete requests, power-screen pause, per-chat draft restoration, safe retries, delayed send responses, and a lost or timed-out response body. API integration checks cover duplicate message IDs, persisted acceptance receipts, authenticated delivery of the connection script, and browser heartbeat replies from Chat and exited terminals. The repository suite passed 86 tests during this update.

The browser harness also includes lock/wake, offline/online, stale question removal, switching Claude/Codex drafts, and chat/terminal draft restoration after reload without replaying input. The extended Chrome run passed on 2026-11-07, including all 14 viewport sizes. Physical phone behavior remains unverified.

## Mixed page and server versions

The running service returned 404 for `/connection.js` while serving newer HTML and Chat JavaScript from disk. Terminal initialization failed and Chat never registered `pocketDevChat`, causing History's Continue in chat action to fail while reading `startFromSession`.

The client now checks required dependencies, preserves chat entry points for recovery instructions, and shows a persistent error with Reload instead of silently leaving an empty terminal. The browser harness reproduces the missing asset, checks both the Chat button and History resume path, verifies no extra chats or terminals are created, and confirms recovery after the route becomes available. It also verifies successful History-to-chat resume. These browser checks and all 86 repository tests passed.

The live background service was restarted after checking there were no active chat turns and all three running terminals were persistent. After recovery, phone access was connected, all three terminal IDs were retained and running, and `/connection.js` correctly required authentication instead of returning 404. No live model calls or physical phone interactions were part of this verification.

## Queued messages at the bottom

Queued messages now appear as one-line previews in a bounded tray above the composer. Four model-free view checks cover remaining in the tray during streaming, moving to the conversation in full when picked up, attachment previews and removal order, failed messages, and offline/chat-switch state. The repository suite passed all 90 tests. Browser checks for pinned position and visual ellipsis were added to the existing harness; this tray-specific browser run has not been performed in the restricted session.

## Editing queued messages

Queued messages have an Edit action that reuses the bottom composer. Save updates the existing queue entry and event together, retaining order and attachments; Cancel restores the separate composer draft. Edits are saved in tab session storage. A message already picked up cannot be changed; Keep draft preserves the revised text and attachments without submitting another message. Concurrent edits are checked against the original text, and a retry of an already accepted save is idempotent.

Model-free checks exercise the production view and PATCH handler with the real Chat queue: save/cancel, attachments and order, pickup before or during saving, lost acknowledgements, another device's changes, newer typing during a save, switching chats, offline/reload draft recovery, input validation, and attachment-only edits. The responsive harness includes editing with a simulated keyboard and at all 14 existing phone, landscape, tablet, and desktop sizes. Its execution in this session was blocked by the sandbox denying the fixture server's localhost listener (`listen EPERM`), so these browser checks and physical-device behavior remain unverified. Access to the running service was also unavailable; the backend needs a Pocket Dev restart and the browser needs a refresh to load this feature.

## Role-based access and Collaborators foundation

Added model-free manager checks and production-component UI checks, plus a real-server integration flow in a throwaway HOME/state directory. Coverage includes explicit trusted-Admin migration, later password approval, Mac-only Admin pairing, one-time invitation acceptance without preview redemption, existing-session conflicts, full device limits without Admin eviction, token hashing and restart behavior, Viewer writes, direct owner/Chat/terminal/settings requests, mixed guest/owner cookies, symlink and other-repository reads, common credential exclusions, Developer project copies and read-only assets, simultaneous owner/guest file requests, policy/root changes, expiry, transfer invalidation, and revocation without token revival. The UI checks cover unchecked trust selection, duplicate-submit prevention, Viewer modes, disabled AI and QR/copy/WhatsApp sharing controls.

The responsive harness now opens the Collaborators form, adds a related folder and checks the submit controls at its 14 viewport sizes and with a simulated keyboard. Running it here still fails at the local fixture listener with `listen EPERM`; browser layout, native share/WhatsApp, QR scanning and physical-phone behavior are not verified in this sandbox. No owner migration or service restart was applied to the live Mac. Collaborator AI has no enabled backend: Docker's engine socket is absent, and isolated execution, provider authentication, network/resource controls and AI escape testing remain unfinished. This validates the file-sharing foundation, not the complete scoped-AI feature.

The final repository run passed all 112 tests. The manager/component checks also passed after the repository suggestions were added. JavaScript syntax and `git diff --check` passed. Revocation/lockdown racing with a project-copy update is covered: the stale update fails instead of undoing revocation.

## Queue Save with an older running server

The phone showed the new Edit/Save controls while Save returned the generic `Not found` from the route dispatcher. Frontend files are read from disk, but Chat routes stay in memory until the server restarts. A generic missing-route 404 must not be treated as a queued message already picked up.

Chat views now advertise queue-edit support. The client checks that support before opening or saving an edit. A generic route 404 preserves the queued entry, position and local edit, disables further Save attempts until a supported snapshot arrives, and shows persistent update instructions. Only an explicit missing-message response marks an edit no longer queued. A fresh supported snapshot also recovers drafts wrongly marked unavailable by the earlier 404 handler. Unit checks cover both paths, and integration checks verify the real PATCH endpoint and `QUEUE_MESSAGE_GONE` response code. The live Admin listener was unreachable from this sandbox, so no live restart was performed; restart only after active chats and waiting messages finish.

## Handoff verification, 2026-11-08

The repository suite passed all 114 tests again. The responsive browser harness could run with local-listener and headless Chrome access. Its first run exposed ambiguous labels on the Collaborators select fields; explicit accessible names now identify each field. The component checks passed after that correction.

The browser rerun passed all 14 phone, landscape, tablet and desktop sizes, including the Collaborators invitation form and related-folder controls, queue tray pinning and truncation, queue Edit/Save/Cancel, simulated keyboard resize/pan, file-link previews, reconnect and draft restoration, History-to-chat resume, and missing-asset recovery. No page errors occurred. This supersedes the earlier sandbox-blocked browser status above; physical-phone interaction, native sharing and QR scanning remain unverified.

Read-only live checks confirmed that the background service is reachable and has newer code waiting, with one persistent terminal and no active chat turns. No live update, access migration, commit or push was performed during this verification. Docker Desktop is installed, but its engine socket remains absent; collaborator AI is still disabled pending a validated isolated runner.

## Take over, 2026-11-08

Take over was built and verified without any real conversation being stopped. Every test lists and signals made-up processes. The server reads them from `POCKET_DEV_PROCESS_FIXTURE`, which records each signal instead of sending it. The main integration server points that variable at a missing file, so its take over route can neither list nor signal anything.

The repository suite passed all 146 tests. The new checks cover the following:

- `test/takeover.test.mjs` covers process matching. The VS Code native binary with `--resume=<id>`, `claude --resume`, `-r`, the node CLI scripts, `codex resume`, and the Claude session registry all match. `grep`, `tail`, editors, shells, another id with the same prefix, another user's process, zombies, Pocket Dev's server, and any program it runs under never match. The tests also cover the SIGINT, wait, SIGTERM sequence, SIGKILL only with force, a reused pid, the busy flag, the refusal when no program is found, and the Mac-terminal scope.
- `test/takeover-api.test.mjs` covers the history route (detail, list, take over, device check, flag validation), the Admin section, and the chat API release (turn interrupted, engine stopped, queue held, no wake-up afterwards).
- `test/takeover-server.test.mjs` runs `server.js`. It checks login and `x-pocket-dev` refusals, a take over with its security-log entry, and `pocket-dev takeover --last` against the real Admin API. That last check closes a test terminal through the terminal API, which leaves the tab showing `[Continued on your Mac]`.
- `test/takeover-cli.test.mjs` runs the CLI against a fake Admin server with a fake `spawn`. The integration test now also checks that a collaborator, even with an owner cookie alongside, gets 403 from the take over route.

Mutation checks reverted each guard in turn: the user, zombie, ancestor, allowlist, and pid-reuse checks, the busy gate, the signal order and waits, the confirmation re-scan, the scope, and the CLI's checks. Each change failed at least one test.

A read-only listing of this Mac's processes, with no signal function loaded, matched the VS Code extension's `native-binary/claude --resume=<id>` to its conversation. Through `~/.claude/sessions`, it also matched two VS Code tabs started without `--resume`. With the real parent process, the session that ran the check was excluded as Pocket Dev's own ancestor.

A Playwright drive in Chrome at 360 × 740, against a throwaway server with fixture processes, passed 21 checks. They cover the list badges, the **Open on your Mac** panel, both confirmations with the exact wording, Stopping… progress, the toast that names the closed program, the force-quit offer and its warning, **Continue anyway** for an unidentified copy, and no horizontal scroll. `scripts/check-responsive.mjs` still passes at all 14 sizes.

Not verified, because no real take over may run during development: how real `claude`, the VS Code extension, the Claude desktop app, and `codex` respond to SIGINT and SIGTERM; whether the VS Code panel restarts its process after it exits; and a real `pocket-dev takeover` that hands a live terminal to `claude --resume`. Run the manual plan with the owner before relying on take over.

## Test history isolation

An earlier release smoke run wrote real sessions into the owner's `~/.claude/projects`, in folders that end in `real-smoke-fixture-1794032458696` and `chat-fixture`. The script behind that run is not in this repository, and those folders were left in place. In the repository, `test/integration.test.mjs` and `test/takeover-server.test.mjs` start `server.js` with a temporary `HOME`, but they passed through the parent's `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `POCKET_DEV_CLAUDE_DIR`, `POCKET_DEV_CODEX_DIR`, `POCKET_DEV_CODEX_SOCKET`, and `POCKET_DEV_CHAT_DIR`. With any of these exported, a claude or codex started by the test server would have written to the owner's history or used the owner's Codex daemon. Such a program could come from a resumed terminal, a chat engine, or a typed shortcut.

Both tests now start the server with `isolatedEnv()` from `test/isolated-env.mjs`, which points all of these inside the test home. `test/hygiene.test.mjs` fails for any test or script that starts `server.js` without it. Before the migration, the check failed on both files. Both tests still pass with owner-style paths exported in the parent shell.
## Messages

Validation date: 2026-11-08. Environment: macOS 14.5, Node.js 22, headless Chrome through Playwright, with disposable servers, ports and state folders.

| Check | Result |
| --- | --- |
| `test/messages-store.test.mjs`: magic-byte types, private file modes, the low-space rules and the 500 MB floor (injected `statfs`), an aborted upload, and no child process except `sips` | 7 tests passed |
| `test/messages.test.mjs` on a real server: group and direct delivery, CSRF and Origin, Range on video, SVG, HTML and mismatched files forced to download, attachment access, delete and hide, reconnect catch-up, the 100 MB connector limit, a 150 MB Wi-Fi upload, revoke, guests, the CLI, Clear and lockdown | 14 subtests passed |
| Repository suite (`npm test`) | 135 tests passed |
| `scripts/check-responsive.mjs`, with Messages at all 14 sizes, the keyboard pan and the action menu | Passed, no page errors |

Mutation checks confirmed that the tests fail when the guest history cutoff is removed, when direct messages go to everyone, when device sockets are not tracked, when every file is served inline, when the connector limit is removed, when deleting keeps the files, and when uploads are held in memory. The memory check samples the server's RSS with `ps` during a 150 MB upload and allows 60 MB of growth.

A real server was also driven in Chrome at 360 × 740 with two owner phones, a guest and the Admin page: send and receive, the toast and badge, three attachments with progress, a thumbnail, inline video, a file card, the image viewer, a direct chat with an unread count, Delete for everyone from the action menu, a 101 MB file refused before upload on the connector route, the Admin page sending as the Mac, a guest sending to the group, and the guest view removed after its grant was revoked. There were no page errors. At 360 px the Admin page overflows sideways because of the existing Permissions buttons, not Messages.

Not verified here: a physical phone (Android or iOS long-press, the native keyboard, video playback of real files), HEIC photos from an iPhone, a real Cloudflare Tunnel, and a Mac that is actually low on disk space.
## Internet access and route switching, 2026-11-08

The `network` setting, the Quick link and domain tunnel kinds, the handoff between addresses and the connection hint were added with model-free checks only; no real tunnel, Cloudflare account or domain was used.

`test/network.test.mjs` covers the setting's fallback to Wi-Fi only with internet off for every unusable value, the save-time refusals (a lockout with Wi-Fi off while internet is off, a bad hostname, a domain without a token), the IPv6 /64 and IPv4 public-address comparison with unknown when the trace lookup fails, and the tunnel against a fake process: internet off refuses to start, the domain kind runs `cloudflared tunnel --no-autoupdate run` with the token in `TUNNEL_TOKEN` and not in argv, the link is ready at its hostname once a connection is registered, an exit carries cloudflared's last line, the Quick link keeps its random address, and a missing cloudflared is reported with the install command.

`test/internet.test.mjs` starts real servers with a shell stand-in for cloudflared that records its arguments and environment. With no `network` setting nothing new answers (`/api/connection`, `/api/handoff` and `PUT /api/network` are 404, an unknown `/?h=` link is refused as a switch link, Admin's remote switch is refused) and the trace endpoint is never called. Wi-Fi access off binds loopback only, so this Mac's LAN address refused. The domain flow checks that a phone cannot widen access, that the token file is written at 0600 and the token never appears in `/api/state`, the security log, the server output or `config.json`, that the hostname is served on https and refused on another port, that sharing defaults to the internet address, that a bad token surfaces cloudflared's message, that Disconnect stops the link and Connect brings it back, and that a phone may turn internet access off. The handoff checks a Secure cookie on the link, refusal off the tunnel and for collaborator sessions, a token replayed through the tunnel refused and spent, redemption only on the Wi-Fi address, expiry, single use, the fragment kept by the bounce page, one device for both cookies, no eviction at the device limit, revocation ending both cookies, and no token in any log. The reverse link from Wi-Fi to the internet address checks that it is refused through the tunnel, that a to-remote token is never accepted on the Wi-Fi address, that the landing carries `?linked=1` and a Secure cookie, that the linked cookie opens the internet address as the same active device with no password and no approval while a new device's password login still waits, that the log records the direction and host, and that revoking the device ends the linked cookie. With a Quick link, a token for the previous hostname is refused after a restart gives a new one, and the phone is asked to link again. An old-format `devices.json` loads and is saved in both shapes, with no known host for its cookies. The connection hint returns a match, a mismatch and unknown as designed. The CLI reads the token from stdin or a file only, saves for the next start when the server is down, and talks to the running server's admin page otherwise.

`test/approval.test.mjs` covers approving from a phone: refused and invisible while `approveFromDevices` is off, a phone cannot turn it on, a page with a terminal open is told about a waiting login once the Mac turns it on, the phone sees the same code the waiting device shows, approve makes the device active and deny removes it, the log names the approving phone, a waiting device cannot approve itself, a device set to pending by role review and a collaborator session (alone or beside an owner cookie) are refused, an Admin device approves with the Admin role, the phone can turn the setting off and is refused afterwards while the Mac still approves.

`test/network-ui.test.mjs` runs the phone's `network.js` in a scripted DOM: nothing shows while internet access is off, the same-network prompt with Not now per network, the handoff minted at tap time with the chat or terminal fragment, the Settings Connection section with one working Switch per route, the link prompt on Wi-Fi with Not now per hostname and Link posting the to-remote handoff at tap time, the landing after a link returning to Wi-Fi with the same view at most once, the remembered internet link offered after five failed probes on Wi-Fi, and Ports hidden with Wi-Fi access off.

The repository suite passed all 139 tests at the time. Playwright is not installed here, so `scripts/check-responsive.mjs` did not run; instead headless Chrome was driven over CDP against a fixture server at 360 × 740, where the prompt and the Settings Connection section fit without horizontal overflow and without page errors. Not verified: a real phone, a real `cloudflared`, a real Cloudflare tunnel and DNS, the same-network hint against live addresses, and the Admin page in a browser beyond a check that every element id its script uses exists in the page.

## Combined feature review, 2026-11-08

Take over, Messages, and Internet access were merged, in that order, in a separate checkout on `integration-review`. The live checkout and service were not changed. The earlier feature-specific test counts above are historical results reported by the original implementation sessions, not a full-suite result for this combined branch.

This session reproduced and fixed four Messages failures with direct production-handler calls: two concurrent direct sends consuming the same pending attachment, a device being blocked while its message body arrives, a guest being revoked while its message body arrives, and a disk append failure exposing an unsaved message and consuming its attachment. Upload completion also rechecks access and deletes the partial file after revocation. Further checks cover guest history cutoffs, Developer participation, direct-message and attachment privacy, and HTML forced to download with sandbox and nosniff headers.

The combined code introduced another privacy issue: Internet access broadcast waiting-login notices to every socket, including the new guest Messages sockets. Auth now sends these notices through its own tracked owner sockets, checking approval eligibility at delivery time. Model-free checks cover default-off behavior, Admin roles, both cookie routes, legacy cookies, single-use handoffs, wrong-route token consumption, and blocking both cookies. A real-server guest-socket regression was added to `test/approval.test.mjs` but could not run here.

Take over now compares the process start time, executable and user as well as its command before signalling it. A regression first reproduced signals sent to a replacement process with the same PID and command, then passed after the fix. All process signals in these checks are simulated.

The Messages server test and Internet access server helper now use `isolatedEnv()` and a nonexistent process-table fixture; the hygiene check includes `test/helpers`. The unfinished Internet access documentation edits were incorporated without changing that original worktree.

Validation in this session:

- 134 tests passed across all 19 test files that do not require a local listener, including the new authentication and Messages regressions.
- The attachment magic-byte test also passed separately.
- Syntax passed for 92 JavaScript files, four inline HTML scripts and ten shell scripts. `git diff --check` passed.
- A full-suite attempt failed when macOS sandbox policy denied both TCP listeners and Unix sockets with `listen EPERM`. It was stopped; the remaining nine socket-dependent test files were excluded from the 134-test run. No tests were marked skipped or changed to conceal those restrictions.
- The original Internet access exploit script also requires local listeners and was not rerun. Cookie isolation and handoff checks ran directly against production Auth; HTTPS redirects, port-forward refusals and invitation-address guards were reviewed in code and retain their server regressions.

Before release, run `npm test` and the responsive browser harness where local listeners are permitted. Real Cloudflare, physical phones and process takeover of disposable real conversations remain manual checks. This combined branch has not been deployed or pushed.

## Shared folder browser, 2026-11-08

The owner identified typed folder paths as a blocker throughout the application. Chat working folders, Terminal's New terminal sheet, collaborator repositories and related folders now share a directory browser; collaborator setup uses it on both phone Settings and Mac Admin. Home, Desktop, Documents, Downloads, pinned folders and external drives are shortcuts. Breadcrumbs, Back, Up, directory-name search and a hidden-folder switch support nested navigation. Selecting an empty directory is allowed. Manual paths remain optional.

The new `GET /api/folders/browse` route lists only directories and directory symlinks, resolves the chosen path, omits broken links, sorts names naturally and limits each response to 2,000 matches. Search can find directories beyond that first page. It is mounted after owner authentication and the guest refusal on the phone listener, and after the existing Mac-only guard on Admin. Selecting a folder does not grant access: collaborator creation still validates the scope through its existing policy.

The production browser and form code passed model-free checks for click-only selection into Chat, Terminal and collaborator setup on both surfaces, retaining a Terminal browser after a failed creation, cancellation, stale responses, Back/Up, search, hidden folders, permission-error recovery, independent related-folder fields and markup in directory names. Filesystem checks cover tilde paths, links, empty folders, deleted paths and bounded listing/search. A production-dispatcher check verifies that unauthenticated callers and guests cannot reach the listing operation.

All 148 tests across the 21 files that do not require listeners passed. Syntax passed for 96 JavaScript files and four inline scripts; `git diff --check` passed. Server integration checks now cover both authenticated routes, private assets and mixed guest/owner cookies. The responsive harness now selects Chat and collaborator folders by clicking, and exercises the Terminal browser at its 14 viewport sizes. Those listener-dependent checks were not run in this sandbox. Playwright is unavailable, and an isolated headless Chrome preview exited with signal 6 before producing a screenshot. Visual layout and physical-phone behavior remain unverified.

This change is committed only in the integration worktree. The live checkout and running service were not updated; the backend must be loaded and the page refreshed before the browser is available there.

## Persistent performance and response status, 2026-11-08

The phone's existing battery/temperature strip now also shows total-machine CPU usage, storage available on the Mac's home disk, a load label and the age of the last performance reading. Performance requests run about every five seconds while visible. Battery and temperature retain their 30-second cadence. The owner-only `GET /api/performance` endpoint shares an in-flight sample and five-second cache across pages, calculates CPU from OS counter deltas and samples memory pressure every 20 seconds. Filesystem and memory reads have a 2.5-second bound, and the memory command itself has a two-second timeout and no stress-test flags.

Load labels distinguish Busy, Memory tight, Storage low, Slow response and Partial readings. CPU at 90% shows Busy immediately; its banner waits for 15 seconds of continuous high samples. Memory warns below 10% free, critical below 5%; storage warns below 10 GB available, critical below 3 GB. Pocket Dev event-loop delays of at least one second raise a response warning. Long sampling gaps reset the CPU interval and sustained-load evidence. Alerts offer Open apps where useful and do not close any application automatically.

Client request deadlines include the JSON body. An eight-second timeout marks retained values as old and shows Mac not responding with the explanation that the Mac may be busy, asleep or disconnected. Phone offline, a server error and an older server without the endpoint have separate states. Requests are cancelled in the background and while offline, retried immediately on wake/reconnect, and late responses cannot overwrite newer readings. Unknown sensors are shown as dashes, and the health detail panel avoids a positive Healthy label when essential readings are missing. The panel shares the same performance readings and shows Pocket Dev delay; its memory-pressure reading remains visible even if `top` cannot provide memory detail.

Validation:

- All 163 model-free tests across 23 files passed. New checks cover CPU deltas and resets, unavailable sensors, alert thresholds, transient/sustained load, shared caching, sensor timeout recovery, owner/guest route policy, strip updates, stale JSON bodies, late responses, retry, offline/online, background/wake, revoked access, old-server and HTTP-error behavior, and incomplete health details.
- A read-only smoke check successfully read CPU, memory pressure, available disk space and event-loop delay from this Mac without contacting or restarting the live service.
- Syntax passed for 99 JavaScript files and four inline scripts; `git diff --check` passed.
- The server integration suite includes performance API authorization and response-shape checks. The responsive harness includes the live CPU/storage strip at all 14 sizes. These listener-dependent checks remain unrun in this sandbox; Playwright and usable headless-browser execution are unavailable here, as recorded above. Physical-phone layout and behavior still need verification.

Neither a delayed endpoint nor these readings can prove that macOS or its desktop is frozen. Network loss, sleep, a busy service and a frozen Mac can look alike from the phone. This feature reports observed load and response status, and does not automatically restart Pocket Dev or the Mac. It is committed in the integration checkout only and has not been deployed or pushed.
