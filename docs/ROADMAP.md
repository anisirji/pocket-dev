# Roadmap

Nothing on this page works yet. These are plans, not features. Anything marked **Upcoming** is not in the current release.

## Upcoming: Google Antigravity CLI

Support for Google's Antigravity command line tool (`agy`), next to Claude Code and Codex. It would come in two steps:

1. **In the terminal.** Start `agy` from a Pocket Dev terminal like any other command. This needs no new code in your phone app, only a shortcut and a setup check.
2. **In Chat.** Antigravity as a third engine in the Chat screen, with the same queued messages, streaming, permission questions and reconnection that Claude Code and Codex have today.

What it will need from you:

- Antigravity installed on the computer and signed in with your own Google account. Pocket Dev will reuse that login. It will not ask for a Pocket Dev API key, a cloud account or a subscription.
- The same operating systems Pocket Dev supports: macOS, Windows 11 and Linux, where Antigravity itself runs.

Open questions before this is built:

- **Protocol.** Google's documentation describes `agy acp`, which runs Antigravity as an Agent Client Protocol (ACP) server over standard input and output. That is the planned way to connect Chat. It has to be tested against a real, signed-in Antigravity before anything is released.
- **Terms of use.** Google's terms restrict reaching Antigravity through some third-party tools, and Google has not said whether starting the official `agy` program from another app is allowed. We will check this before release and say so plainly in these docs.
- **Testing.** The feature ships only after it has been run against a real Antigravity on each system we claim to support.

## Also planned

- Passkeys and fingerprint login.
- An Android share target.
- A room over the internet, and failover across devices.

See [Limitations](GUIDE.md#limitations) for what is not built today.
