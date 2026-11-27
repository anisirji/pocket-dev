# Pocket Dev 3.0.0

Status: unpublished; the owner’s Mac service was updated locally to 3.0.0 on 2026-11-27. This version brings together the work built on the published 2.5.0 baseline. Existing Workspace projects, chats, settings and authentication are preserved.

## Changes

- Settings uses six primary categories, persistent navigation on desktop, full-screen navigation on phones and the theani.me author footer. Dark remains the Workspace default; light and system themes remain available.
- Admin, Settings and setup share one Local/Remote QR selector. Local is selected first; enabling Remote adds another method. Codes and links track LAN address changes, and remote failures preserve local access. Existing share/login permissions and single-use expiry remain in place.
- Workspace retains the shared compact folder picker, recent projects per computer, independent panels, saved drafts and conflict recovery. Modified-file indicators connect to the existing Git diff and graph.
- Personal Codex chats can opt into browser tools in a separate browser profile. Shared sessions retain their existing access boundaries. Permission requests and MCP forms use explicit approval flows.
- Confirmed chat activity powers transient, deduplicated alerts, optional sounds and supported opt-in browser push. Explicitly monitored commands notify their initiating login on completion without replaying commands.
- Screen viewing adds display and quality choices, snapshots and pause controls. Optional Mac input requires supported native permissions, local approval and a visible host stop control.
- Camera startup automatically requests background launch on macOS, Windows and Linux. Browser tab/focus behavior remains subject to browser preferences. Camera transport supports independently enabled listening and push to talk. Microphones stay off until requested; release, denial, host Stop and disconnect clean up media tracks.
- Graphical Admin setup adds predefined actions, bounded progress, post-install checks and recovery. Shared capability states and contextual guides explain availability.
- Native Mac text input sends Unicode characters as individual key pairs, fixing truncated text in Chromium.
- Windows Codex defaults to stdio transport, avoiding a Unix-socket URL built from a Windows path. Folder ZIP downloads preserve Unicode names and empty directories without following outside-root junctions.
- The pinned Anthropic Agent SDK includes the upstream filesystem permissions fix. Claude limit notices display reset timestamps when supplied by Claude Code; the existing account sign-in remains in use.

## Validation and outstanding checks

The full Mac suite passed 959 tests with three skips and no failures. The latest selected native Windows suite passed 154 tests with ten Unix-only fixture skips and no failures. Native Codex browser operations, Windows personal Codex chat, Settings, scratch Git workflows, files, ZIP downloads and temporary port forwarding were checked. A clean Mac package installation and baseline-to-candidate upgrade preserved fixture state.

Native Mac screen capture passed, and locally approved input delivered accented text and emoji, Backspace, clicks and scrolling into a disposable window; host Stop revoked the session. Actual camera/microphone WebRTC passed two-way RTP, push to talk and track cleanup on both Mac and Windows with speaker output muted. Native Windows screen capture also passed. The Windows background-launch recheck preserved the foreground window while its test tab remained open; browser-dependent focus behavior is still best effort. Audible speaker behavior, physical phones, Safari, multiple monitors and real vendor push delivery remain unverified. Safari still refused WebDriver after the reported setting change; real Chrome push registration returned permission denied. The tested Mac Claude Max account reports a five-hour usage limit; the PC's Copilot launcher could not find its CLI. The existing source-based Mac launchd service was restarted into 3.0.0, preserving settings, device identities/permissions, connections, saved chats and a logged-in session. No registry publication, power action or destructive application control was executed.

See the repository's [validation record](VALIDATION.md) for exact scopes and remaining checks. The Windows installation remains unchanged. The package has not been published to the registry.

Written by [theani.me](https://theani.me).
