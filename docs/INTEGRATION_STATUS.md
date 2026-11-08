# Pocket Dev integration handover

Updated 2026-11-08 after taking over the interrupted Claude session.

The three feature branches are combined in order: Take over, Messages, Internet access. They are on `integration-review` in `.claude/worktrees/codex-integration`, backed by the separate local repository `.claude/integration-repo`. These branches live in that repository, not in the live checkout's Git metadata. The original feature worktrees retain their contents, including the Internet access worktree's uncommitted documentation edits.

The live checkout remains on `live` at `0010a82`. Its stopgap Remote quick link section remains available there. The combined checkout starts from the feature branches' common base `0c71403` and does not include that stopgap; Internet access supplies the replacement. The running service, real devices, conversations and tunnel were not restarted, migrated or taken over. Nothing from this session was pushed.

## Review changes

- Verify a takeover target's start time, executable and user immediately before signalling it, as well as its command.
- Resolve the Messages and Internet access merge conflicts while retaining both routes, CLI commands, Admin integrations, client assets and documentation.
- Make consuming a pending attachment atomic with saving its message; preserve it after a failed disk append.
- Recheck sender access after asynchronous work and upload completion. Revocation prevents the write and removes partial uploads.
- Restrict waiting-login notices to eligible owner sockets, excluding guest Messages sockets.
- Apply test-history isolation to the newly merged server fixtures.
- Add a shared folder browser for Chat, Terminal and Collaborator setup, including Mac Admin; manual paths remain optional.
- Keep CPU usage, available storage, load state and reading age in the phone status strip, with offline and timeout recovery.

Results and limits are recorded in the final section of [VALIDATION.md](VALIDATION.md). The original combined branch passed 134 model-free checks; see VALIDATION.md for the later folder-browser and monitoring results. Full-suite and browser execution remain pending because this sandbox denies TCP listeners and Unix sockets.

The isolated branch `admin-port-fix`, in `.claude/worktrees/codex-admin-port-fix`, contains only the Admin-port forwarding fix on top of `0c71403` (commit `c453473`). It is prepared separately for review and has not been applied to the live checkout or main.

## Remaining work

1. Run `npm test` on the combined checkout with local listeners allowed. The nine socket-dependent files, including the Internet access exploit regressions, have not been verified in this session.
2. Run `scripts/check-responsive.mjs` with Playwright and Chrome available.
3. Use a separate test server and state directory for the phone checks below.
4. Fix any issues, then obtain the owner's explicit instruction before merging into the live checkout or restarting its service.
5. The owner identified typed folder paths as the blocking Collaborators problem. The shared folder browser now covers repository and related-folder selection on phone and Admin, as well as Chat and Terminal. Verify it on a real phone before release.

## Phone and Mac checks

- Take over: use disposable conversations only. Check idle and busy handoff, refusal and force, CLI reverse handoff, and whether the VS Code panel respawns its process. Do not take over a conversation doing active development.
- Messages: Everyone and direct delivery between owner, guest and Mac; guest history cutoff; attachments, download and hide/delete; long press, keyboard, real video and iPhone HEIC; Wi-Fi and internet size rules.
- Internet access: real Quick link and domain tunnel; link the phone on Wi-Fi; switch both directions with the same conversation; turn internet off from the remote route; verify HTTPS and approval from another owner device.
- Confirm that a guest Messages socket receives no waiting-login code while an eligible owner device receives the notice.

- Live monitoring: check CPU/storage updates on a physical phone, high-load and low-space alerts, background/wake, offline/online, and whether the status strip leaves controls usable with the keyboard open. Network loss cannot prove the Mac is frozen.

## Release authorization and remote-access check

The owner has authorized merging, pushing and updating the server **after all tests are complete**, and asked for an explanation of the effect on the existing remote connection before proceeding. That conditional authorization supersedes the earlier instruction to leave the live checkout untouched once its test condition is met. Do not ask for the same authorization again; do not deploy while the full-suite/browser checks remain blocked or failing.

Read-only checks found a separate launchd job running the live `server.js` on port 7777 with KeepAlive, connected access with keepOpen enabled, an allowed hostname for a manually started Quick Tunnel, no saved managed-network setting, role-based access enabled and one active legacy-cookie device. No secret, cookie hash or tunnel token was printed.

Restarting only Pocket Dev briefly drops its HTTP/WebSocket service. Leave the external cloudflared process, its port target, its allowed hostname and its terminal alive. The existing Quick URL is tied to that cloudflared process; do not replace it with a newly started managed Quick Tunnel during this release. An origin outage can return 502 while the Cloudflare connector itself stays connected.

The login migration needs special handling: Auth loads legacy cookies as LAN-only, so the current remote browser's legacy cookie will not authenticate through its public hostname after this upgrade. Role-based access also means a password login needs Mac approval. A fresh remote login/pairing path must be ready, with working local management access and rollback, before the restart. A login key minted by the old server is in memory and will not survive the restart; generate recovery keys through the new server, and verify the same remote origin after pairing. Do not weaken cookie-host validation to avoid this migration.

Before any live change: complete the outstanding tests; back up configuration and device state privately; verify local management access, the external tunnel's lifetime and target, and persistent terminals; wait for active chat turns/queues to finish; retain the old code and state for rollback. Restart only Pocket Dev, then check local health, the existing remote URL and authenticated access. The current session still cannot run listener-dependent tests or browser checks, and no merge, push or restart has happened.
