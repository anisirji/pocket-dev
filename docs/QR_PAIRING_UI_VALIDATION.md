# QR pairing and UI validation, 27 November 2026

Scope: local source changes after npm 3.0.0 was published. Package and lockfile version remain 3.0.0. This work did not publish another npm version, restart the owner's running service, change the owner's connections, or create a public release. Existing uncommitted documentation and marketing work was preserved.

## Connection flow

- Local Admin: Devices & access → Connect or manage computers → Connect another computer.
- Phone or desktop app: Settings → Connected computers → Connect another computer.
- Select My computer only for a computer you own, then Show QR on one and Scan QR on the other.
- Both sides must select My computer before pairing grants computer access. Otherwise, pairing is AI-only; provider sharing still needs its existing grants.
- QR photo/screenshot decoding works when live camera scanning is unavailable. Live camera scanning requires a supported secure context; plain Wi-Fi HTTP uses the photo fallback.
- Manual address/code entry remains collapsed. QR expiry removes the image without automatically generating another invitation.
- The QR screen detects a new peer and returns to the computer list. Back, Close and hidden pages stop camera tracks and QR polling. Pending camera permission/startup is also cancelled safely once the browser returns a stream.
- Showing a QR on both computers no longer prevents joining an otherwise empty network. Failed attempts preserve the previous state and persistent identity.
- Populated networks are protected from replacement. The existing network host shows a QR for the new computer to scan. Members identify that host rather than showing an unusable invitation action. Separate populated networks are not silently merged.
- Local Admin keeps its loopback/origin/CSRF rules. Pairing advertises the public computer port rather than the Admin port. Room peers and collaborators do not gain connection-administration privileges.

## Automated results

`npm test`: **992 tests, 989 passed, 3 platform-specific skips, 0 failed**. The first sweep found a missing experimental-provider mention in the generated README; the canonical description now states that local Antigravity and Copilot are experimental, and the complete suite passed on rerun.

**26 browser scripts passed** with installed Google Chrome on macOS. Several older scripts initially looked for an absent Playwright browser; those were rerun with CHROME_PATH pointing at the installed Chrome. Selectors expecting the removed two-step pairing form were updated without dropping navigation, refresh, draft-clearing or overflow assertions. The Chat close-button selector now distinguishes Close from the existing Help button. A force-shutdown UI check timed out on the initial concurrent run, then passed at both widths on an isolated rerun; its fixture never executes a real power action.

New pairing tests use two disposable real servers, actual QR photo decoding, synthetic browser camera frames and a supplied detector result for the live-camera callback. They cover 320, 390 and 1280 px, invalid photos, camera cleanup during startup/Back, both screens completing, expiry, focus restoration and no horizontal overflow. API checks cover all four combinations of ownership choice, failed attempts, existing-network protection, persistent identity, public-port advertisement and local Admin access protections. Existing responsive checks cover 14 portrait, landscape, tablet and desktop sizes plus keyboard resize/pan.

Browser checks completed:

- `check-camera-audio.mjs`
- `check-camera-host.mjs`
- `check-camera.mjs`
- `check-codex-browser.mjs`
- `check-connection-qr.mjs`
- `check-connections.mjs`
- `check-engine-dropdown.mjs`
- `check-file-picker.mjs`
- `check-folder-picker.mjs`
- `check-guides.mjs`
- `check-held-chat.mjs`
- `check-hold-to-speak.mjs`
- `check-monitored-command.mjs`
- `check-navigation-refresh.mjs`
- `check-notifications.mjs`
- `check-pairing-qr.mjs`
- `check-power-actions.mjs`
- `check-responsive.mjs`
- `check-screen-control.mjs`
- `check-screen.mjs`
- `check-settings.mjs`
- `check-setup.mjs`
- `check-unified-chats.mjs`
- `check-workspace-git.mjs`
- `check-workspace-persistence.mjs`
- `check-workspace.mjs`

Generator freshness and integrity checks passed: 9 generated surfaces, 108 links, 10 feature entries, package version/contents and asset validation. `git diff --check` passed. Dark UI screenshots were visually inspected; an unreadable primary label and empty error spacing were corrected. Existing theme variables remain in use.

## Limits

The original sweep used macOS/Chrome. The Windows follow-up below adds native Windows/Edge checks; Safari and physical phone behavior remain unverified by this work. Camera/audio and native input checks use the documented synthetic/inert sources. Real operating-system permission prompts, physical camera focus, actual phone camera UX, human audio quality and final manual stability approval remain manual checks. No new dependency was added. Installed npm copies need a later published update to receive these changes; a running source service needs a restart before its new backend is active.


## Windows follow-up, 27 November 2026

The owner’s actual Windows PC was reachable through its existing approved connection. The current source package was installed in an isolated temporary folder with install scripts disabled, separate server ports, test homes/state and Edge profile. No dependency was added to the product, and the installed service and owner’s connection configuration were not upgraded or reset.

Windows Node **24.21.0**, native Microsoft Edge **158.0.4370.33**:

- `test/native/check-pairing-windows.mjs` passed. It exercised all four ownership combinations, invalid-code state preservation, empty-room recovery after both sides created a QR, protection of populated networks, public-port advertisement and callbacks in both directions.
- Native Edge passed actual QR screenshot/photo decoding from local Admin into the other computer’s Settings at **390×900** and **1280×900**. Both reached the connected-computers list, with the expected computer-access grant, no JavaScript exceptions and no horizontal overflow. Manual entry was opened and visually checked at both sizes.
- The first screenshot-based pairing attempt captured the wrong screen region; the harness now waits for paint and captures a full frame. The decoder correctly rejected the original image, and the corrected capture passed. This was a harness capture issue, not a successful pairing claim from the failed attempts.
- Visual inspection found text inputs using narrow intrinsic grid columns. The shared CSS now gives manual-entry fields the available width. Mac responsive checks passed again at all **14 sizes**, and all **5 static/hygiene checks** passed after this adjustment.
- `test/native/check-settings-windows.mjs` passed at **390×844** and **1280×900**: all six categories, footer, self-inclusive computer counts, repeated refresh without duplicate history, Back navigation, new QR connection choice, actual Windows apps/health/power metadata, unsupported AI sharing, login QR, cancellation, preview cleanup and no polling by hidden pages. The harness retains platform-specific unsupported power controls.

Both Windows reports recorded successful cleanup of their isolated servers, browser profiles and state. A final process audit checked the temporary installation before removing it. The original Windows service remained reachable and the existing approved login remained active. Windows QR tests used image files rather than a physical webcam; no owner camera/microphone, desktop capture, real power action, model request or service update was performed. The new flow is still local source work, not an npm update.
