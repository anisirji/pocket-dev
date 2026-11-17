# Pocket Dev 2.0

2.0 is a big release, so it gets a new major version. The npm package is `@anisirji/pocket-dev`; the last version on npm before this one was 1.1.5.

## Why a major version

- **A command was removed.** `pocket-dev takeover` is gone. Use **Open here** in the phone's Resume sheet, or **Continue on Mac** in the More menu.
- **Installing now makes one change.** `npm install -g` adds a **Pocket Dev Admin** tile with the Pocket Dev logo: a Dock tile on macOS, a Desktop and Start menu shortcut on Windows, and an applications menu entry on Linux (also the GNOME favourites bar). Skip it with `POCKET_DEV_NO_PIN=1` or `npm install -g --ignore-scripts`. Remove it with `pocket-dev admin unpin`.
- **A lot is new** (below).

## What is new

### Four chat engines, one chat
- Claude Code, Codex, Antigravity (experimental) and GitHub Copilot (experimental).
- The settings row under the chat title starts with a **Provider** pill, then **Model**, then Mode, Effort and the engine's other pills. Pick the provider, then the model.
- Switching the provider keeps the whole conversation: Pocket Dev keeps its own copy of the history and hands it to the new engine with your next message. Long chats are compacted (the newest turns word for word, older turns as a short digest), and the full history stays on your computer and on the phone.
- The provider can change only when no reply is running. The model can change at any time and applies from the next reply.
- An engine that is not installed shows its install and sign-in commands when you tap it. After a usage limit, the chat offers a one-tap **Continue with** button for each other installed engine.
- Every answer shows which model wrote it once a chat has used more than one.

### Continuing between your computer and your phone
- **Open here** (Resume sheet) closes the other copy of a conversation for you, then opens it in a terminal or in Chat. It asks once if the other copy is mid-reply.
- **Continue on Mac** (More menu) releases Pocket Dev's copy and shows the resume command to run on the computer. It does not use the clipboard.
- The Resume sheet lists Claude Code, Codex, Antigravity and Copilot conversations.

### Updating
- `pocket-dev update` (and `--check`), an update step at the start of `pocket-dev setup`, and a version look-up on the npm registry at most every six hours. That look-up is the only thing Pocket Dev asks the internet for by itself. Turn it off with `pocket-dev config set updateCheck false` or `POCKET_DEV_NO_UPDATE_CHECK=1`.
- The phone shows an update icon beside the Settings gear and a notice every time the page opens until you update. It explains the steps. The phone cannot install anything.
- The Admin page shows a banner and an **Update** button that installs the new version and restarts the service.
- The computer shows a desktop notification at start and every six hours until it is current. `pocket-dev config set updateNotify false` turns off only that.

### Other changes
- **Files and photos:** the paperclips and **Upload** offer **Photos and videos** or **Files** on phones.
- **Agents strip:** Claude Code helper agents running in a terminal tab appear in a strip above the terminal.
- **Fixes:** the answer boxes keep the caret at the end on phone keyboards that move it; page assets are checked by a test so none can go missing; an engine whose configured path does not exist counts as not installed.
- **Logo and favicon** for the Dock tile, shortcuts and browser tabs.

## Known limits
- Antigravity and Copilot are experimental. Antigravity was not proven end to end because the account's quota was spent; Copilot's own prompts were run for real only through its protocol, and a prompt typed in Pocket Dev's Chat screen was not.
- The Windows and Linux paths for the Admin tile and for desktop notifications were built and tested against fakes, and were not run on real machines. Windows cannot pin to the taskbar by program: the shortcut is created and setup shows the two clicks.
- The Android system file picker and a real four-engine switch have not been tried on a real phone.
- A real `npm install -g` update with the real service restart was not run.

## Upgrading
```
pocket-dev update
```
or `npm install -g @anisirji/pocket-dev@latest`. Then restart the background service: `pocket-dev service restart`.
