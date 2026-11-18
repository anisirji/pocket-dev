# Pocket Dev 2.1

The npm package is `@anisirji/pocket-dev`. The previous version is 2.0.0. 2.1.0 was tagged but never published; 2.1.1 is the first 2.1 on npm and adds the newest-first Chats order. Nothing was removed and no setting changed, so this is a minor version.

## What is new

### One Chats list for everything
- **Chats** is one list, newest first: your Pocket Dev chats and recent Claude Code, Codex, Antigravity and Copilot conversations from the computer, mixed by when each was last active. A conversation you are having on the computer right now sits at the top. Computer conversations carry an **on computer** tag. Search and **Show more** find older ones.
- Tap a computer conversation to continue it in chat, with its earlier messages.
- While the list is open it reloads every 8 seconds, so a conversation started on the computer appears without a tap. A failed scan keeps the list on screen.
- The separate **Resume** entry is gone. **Continue on computer** is now in chat settings.

### Opening a conversation the computer is still using
- Opening a conversation that a program on the computer still has open never stops that program. This holds whether the program is idle or mid-reply. The chat opens at once and you can read along. While the program replies, the chat shows its reply and its current step with the spinner.
- Sending a message continues the conversation in the chat. Pocket Dev waits for any reply on the computer to finish, closes the program, and sends your message. The chat says that the program's window may show that the session ended. That is normal, and nothing is lost.
- **Stop** on such a chat stops the reply on the computer and takes over at once.
- If the program on the computer closes by itself, the chat continues on its own and nothing is signalled.
- While the computer holds the conversation, the Provider and Model pills wait and say why.
- An idle program is closed with an interrupt (SIGINT) first. Idle Claude Code then exits with code 0 instead of 143, the code the VS Code extension shows as an error. A Codex app-server that is replying in another thread is never stopped.
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
