# Pocket Dev 3.0.0 implementation on the 2.5.0 baseline

The current request is the final implementation specification supplied on 2026-11-26. The owner selected 3.0.0 as the next version on 2026-11-27; it remains unpublished. The existing Settings redesign and Workspace changes are retained. This file tracks implementation and verification; an unchecked item is not complete.

## Phase 1 — Core AI experience

- [x] Verify personal Codex/Claude environment, MCP and browser integration; preserve shared-session isolation.
- [x] Verify bidirectional AI sharing and revocation.
- [x] Add confirmed engine activity states to existing Chats and Workspace.
- [x] Add deduplicated event-driven transient notifications and optional sounds, with supported opt-in browser push.

## Phase 2 — Workspace and resources

- [x] Verify synchronization, external edits and draft conflicts.
- [x] Improve modified-file indicators and existing diff integration.
- [x] Verify existing Git graph integration.
- [x] Show authorized computer resources only in visible views.

## Phase 3 — Screen, camera and audio

- [x] Improve the existing screen viewer and supported monitor/quality selection.
- [x] Add explicit locally authorized, single-controller desktop input with host stop controls.
- [x] Extend existing camera signaling with independent audio and push to talk.
- [ ] Finish physical Mac screen/control and media-hardware validation. Permission, revocation, disconnect and cleanup paths pass inert/synthetic tests.

## Phase 4 — Setup and standardization

- [x] Extend the existing Admin setup dialog with validated actions and progress.
- [x] Reuse capability detection through lightweight shared feature states.
- [x] Expose notification and update preferences in Admin and Settings.
- [x] Add shared contextual written guides.
- [x] Standardize new feature errors and explicit recovery without replaying mutations.

## Phase 5 — Freeze and validation

- [x] Review shared components, bounded caches/queues and visible-page resource cleanup; physical throughput remains outside the verified scope.
- [x] Run Mac security and regression checks.
- [x] Test an isolated Mac package installation and a baseline-to-candidate upgrade without losing existing data.
- [x] Document native-platform and physical-device validation limits.
- [ ] Finalize documentation before release; do not overwrite published artifacts.

No central backend, extra inbox/dashboard, replacement editor, second Git client or mandatory account is introduced. Screen input and microphones remain off until explicitly authorized. AI prompts, terminal commands and file writes must never be replayed automatically. Physical platform tests that cannot be run must be reported as limitations.

## Verified progress

- Personal Codex browser MCP integration passed native macOS Codex 0.172.0 → Chrome navigation and clicking, shutdown/disable checks and global configuration preservation. Personal native sandbox policy, MCP input and modern permission requests have regression coverage. Shared browser settings are excluded from the provider schema, retaining inherited-tool isolation.
- Confirmed activity states and one-time live AI/message alerts passed real-server tests and two-tab Chrome checks. Preferences and optional sound passed at phone size. Browser push registration, recipient authorization, revocation, privacy and worker behavior passed isolated tests; real vendor delivery and physical phones remain unverified. Explicit command/build monitoring was pending at that checkpoint; the verified Mac addition is recorded below.
- The Mac suite passed 927 tests with two platform skips before the push addition; subsequent focused push, message privacy and browser checks passed. Full regression must be repeated after the remaining implementation batches.
- The owner restricted further work and testing to macOS. Temporary Windows browser-test files were removed. Earlier Settings validation remains recorded, but no Windows browser-automation success is claimed.
- Workspace Git indicators, staged/unstaged/untracked diff links, graph access, external edits and commit updates passed real scratch-repository browser checks. Existing draft/conflict recovery and project terminal/browser tests also passed. Authorized CPU/RAM rows passed visible-only refresh, selected-computer routing and AI-only denial checks.
- The subsequent full Mac suite passed 934 tests with two skips. Native personal Codex → Chrome navigation, clicking, disable and configuration-preservation checks passed again.
- Shared contextual guides passed native dialog, Escape, Back and responsive checks in Settings and Workspace. Screen quality/display selection, downloads, paused refresh and cleanup passed fixture-browser tests. macOS screen enumeration was checked natively; multiple physical monitors and native display capture remain unverified.
- Camera audio passed actual WebRTC with synthetic Chrome devices on the Mac: computer audio reception, phone push-to-talk transmission, independent permissions, release outside the button, late permission results, audio-only mode, microphone denial preserving video and host Stop. A later socket disconnect released all phone and host tracks. Physical microphones, speakers and Safari remain unverified; physical desktop input testing remains pending.

## Mac continuation and freeze checks

- Locally approved screen control is implemented and passed inert-adapter approval/socket checks. The native read-only Mac probe still reports missing Screen Recording permission. No native mouse or keyboard input has been injected; physical verification remains pending.
- The four-step graphical setup extends the existing Admin dialog. Passive checks, predefined explicit installs, bounded live output, post-install verification, interrupted-job recovery, pause/resume, single-use QR, password/session preservation and the shared completion marker passed focused and browser checks. Tests ran no real installers or OS permission prompts. Headless and explicit CLI setup remain available.
- Monitored Mac shortcuts are opt-in, run once in a separate supported shell and notify only the initiating login on confirmed exit. Concurrent duplicate IDs, failures, preferences, terminal links and reconnect/reload behavior passed real-server and browser tests. Ordinary terminal work stays quiet. Monitoring leases are not restored after a server restart.
- The Mac suite passed 956 tests with two platform skips both before and after the dependency patch. Anthropic's dependency was updated from 0.2.139 to 0.2.141 to incorporate its permissions fix; the subsequent production dependency audit reports zero known vulnerabilities. Final regression results are recorded in VALIDATION.md.
- A clean package staged only repository/task source files; unrelated images, marketing output and the download-reference-reels script were excluded. Installing that tarball into a disposable prefix succeeded with install scripts disabled. The baseline-to-installed-candidate test preserved the password/login, device IDs, settings, chats and project files. No global installation or owner state was changed.
- Published 2.5.0 artifacts have not been overwritten. Release remains pending the remaining native validation and freeze review.
- Final resource review retained the shared feature/picker/notification components, bounded delayed helper-completion metadata, and confirmed bounded capture/setup/push queues plus visible-page teardown. Notification and monitored-command regressions passed after the final cache bound.


## Owner-authorized endpoint validation, 2026-11-27

The later request to test the supplied Windows endpoint authorized additional Windows validation, superseding the earlier Mac-only testing restriction for this endpoint. An isolated current build passed 142 native Windows regression checks, native Codex → Edge browser operations, Settings, Workspace Git, guides, notification preferences and generated-media WebRTC. A real personal Codex chat completed. Testing found and fixed Windows Codex socket selection and directory/Unicode ZIP defects; the live 2.3.0 service remains unchanged.

The final full Mac suite passed 957 tests with three skips and no failures. Physical camera/audio and Mac native input remain pending. Claude returned a rate limit; the live Copilot launcher could not find its CLI. See [VALIDATION.md](VALIDATION.md) for tested scopes, media-source limitations and deployment status. These outstanding checks and live-provider failures prevent claiming that everything works or that the release freeze is complete.


## Local Mac 3.0.0 deployment, 2026-11-27

The owner authorized the local Mac update. The existing source-based launchd service now runs 3.0.0 with startup enabled. Private state backup and post-restart checks preserved configuration, device identities/access, connections and saved chats, and the validation login survived.

Actual native screen capture, camera/microphone WebRTC and locally approved Core Graphics input now pass on this Mac. Native input testing found and fixed truncated text; accented text and emoji, Backspace, clicking, scrolling and host Stop passed after the correction. Speaker output was muted. Physical phones, multiple monitors and other keyboard layouts remain pending.

Camera launches now request background behavior by default on all platforms, retaining normal permission prompts, system indicators and Stop controls. The host tab is reused. Browser/desktop policies can override focus requests; this is documented as best effort, and Windows/Linux native focus tests remain pending. The full Mac suite passed 959 tests with three skips after the launcher changes. Safari automation and real push registration were attempted but refused by their respective browser settings/services, so those checks remain unverified. Registry publication remains separate from this local update.


## Windows 3.0.0 verification, 2026-11-27

A disposable Windows 3.0.0 installation passed 154 selected regression tests with ten explicitly Unix-only skips and no failures. Native Edge Settings, scratch Workspace Git, Codex browser protocol operations, ZIP, guides and notification controls passed. Actual Windows camera/microphone WebRTC and screen capture now pass; generated-media transport passed independently. A repeated native launcher probe retained the original foreground window; the initial auto-closing-tab measurement was inconclusive. Universal browser focus preservation remains outside the guarantee. The live Windows service remains on 2.3.0. Only test fixtures and ongoing Windows CI coverage changed in this batch; no Mac service restart is needed for those changes.


## Independent connection QR selector, 2026-11-27

Admin, Settings and setup now share Local/Remote QR controls with Local selected first. Connection choices are explicit, codes and links update with the LAN address, remote failures do not invalidate local codes, and a missing LAN address clears the old code. Existing authentication, share versus login semantics and single-use expiry remain in place.

Mac validation passed 963 tests with three skips, the focused QR/legacy/static checks, the shared phone/desktop QR browser workflow and existing Settings/setup regressions. A disposable Windows 3.0.0 installation passed ten focused API checks and the same QR flow in Edge. The Mac service was reloaded with its two terminals preserved. The Windows installation remains unchanged; no release was published.
