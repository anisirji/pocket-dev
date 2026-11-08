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

Results and limits are recorded in the final section of [VALIDATION.md](VALIDATION.md). The combined branch passed 134 model-free checks. Full-suite and browser execution remain pending because this sandbox denies TCP listeners and Unix sockets.

The isolated branch `admin-port-fix`, in `.claude/worktrees/codex-admin-port-fix`, contains only the Admin-port forwarding fix on top of `0c71403` (commit `c453473`). It is prepared separately for review and has not been applied to the live checkout or main.

## Remaining work

1. Run `npm test` on the combined checkout with local listeners allowed. The nine socket-dependent files, including the Internet access exploit regressions, have not been verified in this session.
2. Run `scripts/check-responsive.mjs` with Playwright and Chrome available.
3. Use a separate test server and state directory for the phone checks below.
4. Fix any issues, then obtain the owner's explicit instruction before merging into the live checkout or restarting its service.
5. Fix Collaborators after the owner describes the problem. The earlier session recorded that request without a reproduction; a clarification was requested during this session.

## Phone and Mac checks

- Take over: use disposable conversations only. Check idle and busy handoff, refusal and force, CLI reverse handoff, and whether the VS Code panel respawns its process. Do not take over a conversation doing active development.
- Messages: Everyone and direct delivery between owner, guest and Mac; guest history cutoff; attachments, download and hide/delete; long press, keyboard, real video and iPhone HEIC; Wi-Fi and internet size rules.
- Internet access: real Quick link and domain tunnel; link the phone on Wi-Fi; switch both directions with the same conversation; turn internet off from the remote route; verify HTTPS and approval from another owner device.
- Confirm that a guest Messages socket receives no waiting-login code while an eligible owner device receives the notice.
