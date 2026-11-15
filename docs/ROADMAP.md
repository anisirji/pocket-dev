# Roadmap

Items marked **Upcoming** are plans, not features. Items marked **Experimental** exist but are not proven.

## Experimental: Google Antigravity CLI

Chat has a third engine, Antigravity (`agy`), next to Claude Code and Codex. It is **experimental**: it was written from Google's documentation and tested only against a stand-in program that speaks the same protocol. It has not been run against a real, signed-in Antigravity, so it may not work yet.

How it works: Pocket Dev starts `agy acp` on the computer, one process per chat, and talks to it over standard input and output using the Agent Client Protocol (ACP). You see its answer and thinking as they stream, tool calls, file changes, and permission questions that you answer from the phone. Stop cancels the turn. Pocket Dev reuses the sign-in `agy` already has. It asks for no Pocket Dev API key.

What you need:

- Antigravity installed on the computer and signed in with your own Google account. If it is not signed in, the chat tells you to run `agy acp --login` in a Pocket Dev terminal.
- To start `agy` in a terminal, nothing more: it is an ordinary command.

Not done yet:

- **Real-world test.** It has to be run against a real, signed-in Antigravity on each system we claim to support. Until then, treat it as unproven.
- **Terms of use.** Google's terms restrict reaching Antigravity through some third-party tools, and Google has not said whether starting the official `agy` program from another app is allowed. Check this before you rely on it.
- **Resuming and settings.** A chat starts a fresh Antigravity session each time it wakes up, and there is no model or approval picker yet.
- **Setup.** `pocket-dev setup` does not install or check `agy` yet. The Permissions page shows whether it is found.

## Also planned

- Passkeys and fingerprint login.
- An Android share target.
- A room over the internet, and failover across devices.

See [Limitations](GUIDE.md#limitations) for what is not built today.
