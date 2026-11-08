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
