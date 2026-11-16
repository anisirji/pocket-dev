# Roadmap

Items marked **Upcoming** are plans, not features. Items marked **Experimental** exist but are not proven.

## Experimental: Google Antigravity CLI

Chat has a third engine, Antigravity (`agy`), next to Claude Code and Codex. It is **experimental**. It was tested by hand on macOS against Antigravity CLI 1.5.9 signed in with a Google account: a plain answer with thinking, a file edit and a shell command that ask permission (Approve and Deny both work), Stop, and waking a sleeping chat so it carries on with the same conversation. It has **not** been run on Windows or Linux, and other versions may differ.

How it works: Pocket Dev starts `agy acp` on the computer, one process per chat, and talks to it over standard input and output using the Agent Client Protocol (ACP). You see the answer and thinking as they stream, tool calls, file changes with their diff, and permission questions that you answer from the phone. Pocket Dev reuses the sign-in `agy` already has. It asks for no Pocket Dev API key.

What you need:

- Antigravity installed on the computer and signed in with your own Google account. If it is not signed in, the chat tells you to run `agy acp --login` in a Pocket Dev terminal.

Not done yet:

- **Terms of use.** Google's terms restrict reaching Antigravity through some third-party tools, and Google has not said whether starting the official `agy` program from another app is allowed. Check this before you rely on it.
- **Model and mode pickers.** `agy` offers several models and modes (for example Gemini, Claude and GPT-OSS models, and an "accept edits" mode). Pocket Dev does not show them yet; chats use the model `agy` is set to.
- **"Approve for this chat" for commands** remembers the exact tool title, so each different command still asks.
- **Setup.** `pocket-dev setup` does not install or check `agy` yet. The Permissions page shows whether it is found.

## Also planned

- Passkeys and fingerprint login.
- An Android share target.
- A room over the internet, and failover across devices.

See [Limitations](GUIDE.md#limitations) for what is not built today.
