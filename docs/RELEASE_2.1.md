# Pocket Dev 2.1

The npm package is `@anisirji/pocket-dev`. The previous version is 2.0.0. Nothing was removed and no setting changed, so this is a minor version.

## What is new

### One Chats list for everything
- **Chats** shows **In Pocket Dev** and **From your computer** together: recent Claude Code, Codex, Antigravity and Copilot conversations from the computer sit under your Pocket Dev chats. Search and **Show more** find older ones.
- Tap a computer conversation to continue it in chat, with its earlier messages.
- While the list is open it reloads every 8 seconds, so a conversation started on the computer appears without a tap. A failed scan keeps the list on screen.
- The separate **Resume** entry is gone. **Continue on computer** is now in chat settings.

### Opening a conversation the computer is still using
- Opening a conversation that is mid-reply on the computer no longer asks you to stop it. The chat opens at once, shows the computer's reply and its current step with the spinner, and queues what you type. Once the program on the computer is idle, Pocket Dev takes over by itself.
- **Stop** on such a chat stops the reply on the computer and takes over at once.
- While the computer holds the conversation, the Provider and Model pills wait and say why.
- An idle program that holds the conversation is closed in about 2 seconds instead of waiting for a slow interrupt. A Codex app-server that is replying in another thread is never stopped.
- **Windows:** Pocket Dev now finds, watches and stops the program that holds a conversation, including the program holding a Codex thread lock. Interrupts are sent as Ctrl+C to the program's console. If a program had to be ended at once, the note says its last step may be lost.

### Files and photos
- The paperclips and **Upload** on phones offer **Take photo**, which opens the camera directly, next to **Photos and videos** and **Files**.
- **Files** opens Android's document picker for PDFs, documents, zips and text files, instead of the Camera and Photos chooser.

### Set up with an AI assistant
- [Copyable setup prompts](https://www.theani.me/work/pocket-dev/prompts) for a coding assistant running on your own computer, an [agent setup guide](AI_SETUP.md), and a reusable agent skill in `skills/pocket-dev`. These files, and `llms.txt`, now ship in the npm package.

### Other changes
- A short note in the README and the setup welcome invites you to share Pocket Dev with three people if it makes your day a little freer.

## Known limits
- The Windows hand-over was built and tested against recorded Windows output, and was not run on a real PC for this release.
- Antigravity and Copilot are still experimental. The other limits in the [2.0 notes](RELEASE_2.0.md) are unchanged.

## Upgrading
```
pocket-dev update
```
or `npm install -g @anisirji/pocket-dev@latest`, then `pocket-dev service restart`. The Admin page's **Update** button does both.
