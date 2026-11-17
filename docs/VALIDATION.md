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
- `test/takeover-server.test.mjs` runs `server.js`. It checks login and `x-pocket-dev` refusals, a take over with its security-log entry, and Continue on Mac through the real route. That last check closes a test terminal through the terminal API, which leaves the tab showing `[Continued on your Mac]`.
- The `pocket-dev takeover` command is gone. `test/takeover-api.test.mjs` now covers **Continue on Mac** instead: a terminal named by id, a chat named by tool and id, a chat that is asleep, the one yes for a reply in progress, bad requests, and a stranger's device. The integration test checks that a collaborator, even with an owner cookie alongside, gets 403 from the take over route.

Mutation checks reverted each guard in turn: the user, zombie, ancestor, allowlist, and pid-reuse checks, the busy gate, the signal order and waits, the confirmation re-scan, the scope, and the CLI's checks. Each change failed at least one test.

A read-only listing of this Mac's processes, with no signal function loaded, matched the VS Code extension's `native-binary/claude --resume=<id>` to its conversation. Through `~/.claude/sessions`, it also matched two VS Code tabs started without `--resume`. With the real parent process, the session that ran the check was excluded as Pocket Dev's own ancestor.

A Playwright drive in Chrome at 360 × 740, against a throwaway server with fixture processes, passed 21 checks of the earlier take over screen: list badges, two confirmations, Stopping… progress, the closed-program toast, the force-quit offer and its warning, and no horizontal scroll. That screen is gone. The Resume sheet now has **Open here** buttons and no panel, and More has **Continue on Mac**. Neither has had a browser run yet, and `scripts/check-responsive.mjs` was not run for this change.

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

Neither a delayed endpoint nor these readings can prove that macOS or its desktop is frozen. Network loss, sleep, a busy service and a frozen Mac can look alike from the phone. This feature reports observed load and response status, and does not automatically restart Pocket Dev or the Mac. It was initially committed in the integration checkout; the later local merge is recorded below.

## Merge into the server checkout, 2026-11-08

At the owner's explicit request, the integration branch's source was combined with `/Users/ani/Desktop/pocket-dev` on `live`. The Admin conflict resolution retains Messages, managed internet access and folder browsing, and preserves the live branch's manual Remote quick-link recovery controls and `qr --link`. The resolution is present in the working file, but staging and committing fail on `.git/index.lock` with `Operation not permitted`; the merge remains in progress and HEAD is still `0010a82`.

All 163 model-free tests across 23 files passed again in the actual server checkout, with no skips. The full-suite retry failed on sandbox-denied TCP and Unix listeners (`listen EPERM`); terminal-host startup also cannot create its socket. The run was stopped. The responsive harness failed to import the unavailable `playwright` package. These remain release blockers. Syntax checks passed for 65 application/script files and four inline scripts; `git diff --check` passed. No server restart, state migration, tunnel change or publication was performed.

## Model switching with real engines, 2026-11-17

A throwaway Pocket Dev server (spare port, temporary state and config folders, scratch chat folder under the system temp directory, no Codex daemon socket) drove the real Claude Code 2.1.319, Codex 0.166.0 and Antigravity 1.5.9 through the HTTP API. Each chat said "Remember the word X. Reply with the single word ok.", was switched to another engine, and was then asked to repeat the word. About 10 real prompts were sent. The engines wrote their own sessions into the real `~/.claude` and `~/.codex`, and the Claude and Codex test sessions were deleted afterwards. Any Antigravity session folders under `~/.gemini` were left alone.

| Chat | Hop | Engine started | Answered | Used the carried history | Time to answer |
| --- | --- | --- | --- | --- | --- |
| 1 | Start on Claude | yes | `ok` | not asked | 2.0 s |
| 1 | Claude to Codex | yes | `PINEAPPLE` | yes | 7.1 s |
| 1 | Codex to Antigravity | yes | usage-limit message only | not provable | 5.1 s |
| 1 | Antigravity to Claude | yes | `PINEAPPLE` | yes, with the Antigravity turn in between | 2.5 s |
| 2 | Start on Codex | yes | `ok` | not asked | 5.1 s |
| 2 | Codex to Antigravity | yes | usage-limit message only | not provable | 4.1 s |
| 2 | Antigravity to Codex | yes | `MANGO` | yes | 5.1 s |
| 3 | Start on Antigravity | yes | usage-limit message only | not asked | 5.1 s |
| 3 | Antigravity to Claude | yes | `KIWI` | yes, from a first message Antigravity never answered | 3.0 s |
| 3 | Claude to Codex | yes | `KIWI` | yes | 12.6 s |

Every answer was labelled with the engine that wrote it (`claude`, `codex`, `antigravity`). The switch call itself returned in under 1.4 s.

What this does not show: the signed-in Antigravity account had used its quota ("Individual quota reached", reset in about 153 hours), so Antigravity never produced a real answer. Handing history to Antigravity is covered only by the fake-engine tests, not by a real answer. Tool use, approvals and file edits after a switch were not tried with the real engines. Claude was run with its default model and settings.

Two things found and fixed:

- Antigravity reports a spent quota as an ordinary answer, so the chat showed no limit error and no "Continue with" buttons. A short quota answer now becomes the same "usage limit reached" error that Claude and Codex give (`antigravityQuotaNotice` in `chat/limits.js`).
- A harness slip, not a product bug: Codex 0.39 in `/usr/local/bin` has no app-server mode. Pocket Dev prefers `~/.local/bin/codex`, and a Codex that cannot start already reports "codex app-server exited" within 5 seconds, so nothing changed there.

## Handoff compaction, 2026-11-17

A switch sends the new engine the whole conversation up to about 30,000 tokens (120,000 characters), word for word, exactly as before. Above that, the newest turns up to about 15,000 tokens (60,000 characters) stay word for word and each older turn becomes one digest line: the question (400 characters), the start of the answer (600), the files changed and the commands run. No model is called, so the digest works while the old engine is rate limited. The whole prompt is capped at about 50,000 tokens (200,000 characters): the oldest digest lines go first, then the oldest word-for-word items, and the prompt says how many were left out. The digest is kept on the chat (`handoffDigest`, at most 500 lines) so a later switch extends it instead of redoing it; the chat's own events are never changed.

`test/chat-engine-switch.test.mjs` covers: a short chat sent unchanged byte for byte, a long chat with the newest turns word for word and older ones digested, a second switch reusing and extending the kept digest, the hard cap, the digest surviving a restart and staying out of what the phone receives, and a real server with a 17-message chat (the switch note says earlier turns were summarised, the next engine receives the digest and the newest question in full, the oldest question only in the digest, and the chat still shows every message in full). Not tried: compaction with the real engines, because the Antigravity quota was spent (see above).

## Updating and the version check

`pocket-dev update`, the "Latest version" step of the guided setup and the daily notice were checked three ways. First, 38 tests with every outside action replaced (registry, npm, service, spawn): version comparison (1.2.0 against 1.1.5 on npm says up to date, 1.10.0 beats 1.9.9, a release beats its prerelease), offline, a source checkout, `npx` and a project install, an `EACCES` message that points to the own-folder fix, accepting, declining, `--yes`, `--dry-run`, `--check`, no terminal, `--only`, the opt-out, the 24-hour cache, the six-hour retry after a failed look-up, concurrent requests making one request, and a login needed for the notice. Second, real servers against a local stand-in for the registry: the phone and the Admin page learn of a newer version, a restart inside the day does not ask again, and the opt-out sends no request at all. Third, a real run: the packed package was installed into a throwaway npm prefix, `pocket-dev update --check` and `setup --check` named the newer version, `pocket-dev update --yes` ran a real `npm install -g @anisirji/pocket-dev@latest` there and replaced the copy, and `setup --dry-run` in a real terminal showed the step. Chrome at 390 px showed the phone notice with no install button, and the Admin page showed it under This computer.

Not verified: a real update that restarts the background service (the throwaway run had no service, and the owner's service was never touched), the setup re-run after an update (covered with a fake updater only, because a real one would run the whole guide), Windows and Linux, and the `EACCES` message against a real permission error (it is matched on npm's own wording in a fixture).

## Admin shortcut (Dock, taskbar, launcher), 2026-11-17

`pocket-dev admin pin`, `unpin` and `pin --status`, the install hook (`scripts/postinstall.js`), the setup step and the logo as page icon. 34 new tests (`test/taskbar-pin.test.mjs`, `test/favicon.test.mjs`) use an in-memory file system and a scripted command runner, so no test touches a real Dock, PowerShell or gsettings. They cover idempotence, unpin, dry run, non-interactive runs, paths with spaces and quotes, the missing-server message, a Dock that writes its old list back, and that the install hook does nothing for a local install, CI, the opt-out, an unsupported system or a Linux machine without a desktop, never throws, and writes the record.

**macOS, run for real on this Mac.** `npm pack` and `npm install -g --prefix <temp folder>` of the tarball: the Dock gained exactly one tile, after Chrome, showing the Pocket Dev logo (looked at in a screenshot cropped to the Dock), `~/Applications/Pocket Dev Admin.app` and `~/.pocket-dev/pinned.json` (`via: install`) existed, and installing again over it left one tile. The launcher opened the Admin address of a throwaway server on a spare port, and with that server stopped it showed the plain "not running" message and opened nothing (the dialog program was replaced by a recorder for that check). `pocket-dev admin unpin` from the installed copy removed the tile at once, it stayed gone after 5 seconds, the `persistent-apps` list was identical to a copy saved before, and the app and record were gone. Two real bugs came out of this and are fixed: the Dock settings hold binary data, so the tile list is read from XML and not JSON (the first version would have added a duplicate tile on every run), and the Dock can write its old list back as it restarts, so pin and unpin now check the Dock and repeat once. Only a timestamp and a change counter differ in the Dock settings afterwards.

**Windows, not run.** The PC reachable through `~/.pocket-dev-remote` was offline (its helper answered "unreachable"), so the PowerShell shortcut creation was not tried on a real PC. The `.lnk` target, the script launcher and the instruction to pin are covered by tests with a fake PowerShell only. Windows cannot be pinned by a program, so the last click is the person's.

**Linux, not run on a desktop.** The generated shell launcher was run for real here (with a fake `node` and `notify-send`) and behaves as described. The `.desktop` file, icon placement and the GNOME `gsettings` steps are covered by tests with fixtures only.

## File picker on phones, 2026-11-17

The owner reported that **Upload** in Files only offered pictures and that the paperclip in Chat would not share files. No server rule caused it: `POST /api/upload` (Chat and terminal paperclip) and `POST /api/files/upload` (Files) keep any bytes under any name, and only the size caps apply (25 MB for the paperclips, 2 GB for Files). The terminal's file box asked for `image/*,*/*`, which steers Android Chrome to its photo picker, and the others set no list, so Android chose its own start screen.

Now every paperclip and the Upload button open a two-choice menu on touch devices: **Photos and videos** (`image/*,video/*`) and **Files** (`application/*,text/*,audio/*` plus common document and code extensions, no images), set just before the picker opens. A desktop browser keeps its one normal picker. The helper is `public/file-choice.js`.

Checked: 5 helper tests with a small fake DOM (`test/file-choice.test.mjs`), 3 server tests that send real pdf, zip, text and png bytes through both upload routes and check the 25 MB refusal (`test/upload-files.test.mjs`), and `node scripts/check-file-picker.mjs` in real Chrome with touch emulation at 390 px: the Chat paperclip, the terminal paperclip and Files Upload each showed both choices at 44 px, set the expected accept list, and uploaded a pdf, zip or png with no page errors.

Not run: **Android's own system picker.** Chrome's file chooser event is answered by the script, so what is verified is the accept list the page sets and the upload that follows, not what Android shows for it. Test it once on the phone: tap the paperclip, choose Files, and the document browser should open without the photo-only view. iOS Safari was not run either.

## Update icon, Admin Update button and reminders, 2026-11-17

New: an update icon and a ping on the phone, an Update banner and button on the Admin page, a desktop notification on the computer, terminal lines, a six-hour look-up schedule, and `updateNotify`.

**Tests (all with every outside action replaced).** `test/update-runner.test.mjs` (13): the phases checking, installing, restarting, done and failed; the restart only when this copy is the background service; the 409 on a second update; the permission help with no `sudo`; the refusal for a git checkout, `npm link` or `npx` copy; the honest message when npm finished but the version on disk did not change; the six-hour cache, one-hour retry and the Admin page's own one-hour freshness; the terminal line. `test/update-admin-server.test.mjs` (7) runs a real server with a stand-in registry and a stand-in npm: the button is off for a source checkout with the reason, a real `npm install -g @anisirji/pocket-dev@latest` argument list reaches the stand-in, the Security log records `update-started`, a second update gets 409, `EACCES` shows the own-folder fix, the header is required (403), the phone port has no such route (404, and 401 for a stranger), and the check turned off gives no banner and no route. `test/update-notice.test.mjs` (9): the icon data, Later for one page load only, a ping again after a page load or after more than ten minutes away, the last answer kept when a look fails, the steps worded per system. `test/desktop-notify.test.mjs` and `test/update-notify-server.test.mjs` (11): the macOS command uses `display notification` with the text as arguments and never a dialog, the Windows toast command carries the text in the environment, `notify-send` only when it exists, nothing thrown on failure, the reminder at most every six hours, silent when current or when `updateCheck` or `updateNotify` is off, and one record on a real server at start. No test shows anything on the real screen: test servers get `POCKET_DEV_NO_DESKTOP_NOTIFY`, and `NODE_TEST_CONTEXT` blocks it as well.

**Real Chrome** (Playwright, throwaway server, stand-in registry saying 9.9.9 and a stand-in npm). At 390 px: the icon sits between the More button and the Settings gear without overlap, its tap area is 44 px, the ping shows `Pocket Dev 9.9.9 is available` with Details and Later, the sheet shows the versions, three numbered Mac steps and the terminal alternative, Later closes it and keeps the icon, and a reload pings again. At 1280 px: the Admin banner shows with the tab title `• Update available`, the dialog states the install and restart, the banner shows `Installing 9.9.9…` with npm's last lines while it runs, and finishes with `npm finished, but this copy still reports 1.2.0. Restart Pocket Dev to finish: pocket-dev start` (the stand-in does not change the installed version). No page errors.

**macOS notification, run for real.** `createNotifier()` with the title `Pocket Dev test, ignore` returned in 146 ms and left no `osascript` process behind, so it was a banner and not a dialog that waits for a click. Whether the banner was visible depends on the Mac's notification settings for the Script Editor app, which was not checked.

**Not run:** a real `npm install -g` of a newer release followed by the real service restart and the page reconnecting; the Windows toast and the Linux `notify-send` paths (commands are built and tested, never run); the Admin page in Safari or Firefox.

## Provider and Model pills in the chat's settings row

The settings row under the chat title is `[Provider] [Model] [Mode] [Effort] ...`. Provider is a normal pill, first in the row, and opens the list of every engine the server knows. Choosing one switches the engine and opens that provider's model list; the Model pill, which was already there, is the second step.

`test/chat-engine-switch-ui.test.mjs` (14 tests, tiny DOM) covers: the Provider pill's content and its place first in the row, no separate header control left, the Provider pill dimmed, aria-disabled and opening nothing in each busy state (reply running, permission waiting, answer waiting, engine waking, message queued) and working when idle; the Model pill staying enabled in every state with the note "Applies to the next reply" and opening its sheet; a custom model name and a single-model provider; the list showing every engine with none disabled, four engines as four rows, the current provider leading to its models; provider-then-model (the model list is offered right after a switch, and not for a provider without a model setting); a switch refused while busy with nothing posted; the install and sign-in help for a missing or signed-out engine; touch targets and no clipboard use.

`test/chat-engine-switch.test.mjs` and `test/engine-dropdown.test.mjs` run a real server: a provider switch while a reply runs is refused with 409 and nothing changes; a model change while a reply runs, or a permission waits, is accepted, saved to the chat, remembered for that provider, leaves the running reply alone and reaches the next reply (the stand-in engine answers with the model it was given); switching away and back restores a provider's last model; and a switch that races a starting reply either fails with the engine, settings and history unchanged and the reply still running, or wins completely with the message stored after the switch. A mutation check confirmed the race test fails when the second busy check in `switchEngine` is removed. That test found a real flaw while it was being written: the first version stopped the old engine before its final check, so a reply that started during the switch was killed. The switch now re-checks right after its only wait, changes everything without another await, and retires the old engine afterwards.

`scripts/check-engine-dropdown.mjs` drove real Chrome at 390 x 844 with touch emulation against a throwaway server with stand-in engines (Claude marked not installed, Codex and Antigravity standing in, a fourth engine added to the list the page loads). All 26 checks passed: Provider then Model first in the row and visible without scrolling, no separate control, no horizontal scroll; during a reply the Provider pill dimmed and aria-disabled with "Stop the reply first" on a tap, the Model pill usable with the note "Applies to the next reply", a typed model saved while the reply kept running; once idle the Provider pill works again, the list shows four engines of at least 44 px with none disabled, the missing engine shows its install commands, Escape closes the list; a switch to Codex opens the model list at once and keeps the conversation, and switching back restores the model set earlier; no page errors.

Not verified: a real fourth engine (the Copilot engine arrives in another change), the Claude mid-session model call under a live reply (the engine code already used `setModel`; the change now reaches it when the next reply starts), and a physical phone.
## GitHub Copilot, 2026-11-17

Copilot is the fourth Chat engine and is **experimental**. It starts `copilot --acp --stdio` and shares its Agent Client Protocol client (`chat/acp-engine.js`) with Antigravity. Moving that client out of `chat/antigravity.js` kept all 25 existing Antigravity and switching tests green.

**Run for real (Copilot CLI 1.0.112, macOS, signed in, an isolated `COPILOT_HOME` and a scratch folder under /tmp).** Three prompts went straight to the protocol, which was the budget for this check: a plain answer ("ok"), a prompt that made Copilot create a file and ask permission (answered with Allow once; the file was created), and the session list. Their messages were saved and the stand-in `test/helpers/fake-copilot.mjs` replays those shapes: `initialize` (loadSession, image prompts, `session/list` and `session/close`), `session/new` (modes Agent, Plan, Autopilot), `agent_message_chunk`, `usage_update`, a `tool_call` of kind `edit` with a diff, `session/request_permission` with `allow_once`, `allow_always` and `reject_once`, `tool_call_update`, and the prompt result with usage. Without any prompt, `chat/copilot.js` itself was run against the real binary: starting a session with plan mode and `--reasoning-effort low`, changing the model and mode (`session/set_model`, `session/set_mode`), loading a saved session with `session/load` (4 replayed updates, none shown), and loading a session that holds no message yet, which Copilot answers with "Session not found"; Pocket Dev then starts a new session and queues the conversation so far for the next message. That last case was found by this run and is now handled and tested.

**Not run for real.** A prompt typed in the Pocket Dev chat screen, Stop (`session/cancel`), a spent premium allowance (the limit wording is a pattern, not something Copilot was seen to say), a signed-out Copilot (the sign-in message is mapped from the protocol's authentication error), image prompts, Windows and Linux, and `session/set_mode` with a prompt that follows.

**Tests.** `test/chat-copilot.test.mjs` (25 tests, a real Pocket Dev server with the stand-in), `test/history-copilot.test.mjs` (12) and the updated setup, integration and Antigravity history tests. They cover: history in Pocket Dev's own format with every answer tagged `copilot` and kept across a server restart; switching Antigravity to Copilot and back, and Copilot to Codex to Claude and back, with the whole conversation handed over and the "Switched from X to Y" line; compaction of a long Copilot chat on a switch; the chat list and the Resume sheet (title, folder, count, real messages, read-only files); Open here in a terminal and in chat; Continue on Mac for a Pocket Dev terminal and for a chat; process matching for `copilot --resume`; queue and Stop; permission requests with the diff, Approve for this chat and Deny; Mode, Model and Effort (including the restart for Effort); an attached picture sent as an image block; usage limits as an error and as an answer; sign-in and start-up errors; the not-installed refusal; login required; the terminal shortcut; setup and the Admin tool list.

**Phone checks (real Chrome, 390 × 844).** The new-chat sheet shows four engines in two rows, Copilot highlighted, with the Experimental note and the Model, Mode and Effort chips. With the Provider and Model pills that shipped meanwhile, the Provider list shows all four engines (Antigravity and Copilot marked experimental, Copilot in its own colour, with Model, Mode and Effort still reachable in the row), and a Copilot that is not installed is marked and shows `npm install -g @github/copilot`, `copilot login` and the plan note. A switch from Copilot to Antigravity kept the history, labelled the earlier answer "Copilot", showed the switch line and kept an unsent draft. The paperclip menu shows Photos and videos and Files. The Resume sheet lists the Copilot session under its own filter. After a Copilot limit error the chat shows Continue with Claude, Codex and Antigravity, and tapping one switches the chat and keeps its history. Open here in chat on a saved Copilot session resumed that session (`session/load`), woke the engine and answered. The five filter chips are wider than a phone, so the row scrolls sideways and keeps the chosen chip in view. No page errors and no sideways page scroll. `scripts/check-responsive.mjs` and `scripts/check-file-picker.mjs` pass.
