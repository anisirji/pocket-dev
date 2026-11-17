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

## Experimental: GitHub Copilot CLI

Chat has a fourth engine, GitHub Copilot (`copilot`, the npm package `@github/copilot`), next to Claude Code, Codex and Antigravity. It is **experimental**.

How it works: Pocket Dev starts `copilot --acp --stdio` on the computer, one process per chat, and talks to it over the Agent Client Protocol (ACP), the same way it talks to Antigravity. GitHub documents this server as a public preview that "may change" ([changelog, 2026-01-28](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/), [ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)). You see the answer as it streams, file changes with their diff, and permission questions (Allow once, Approve for this chat, Deny) that you answer from the phone. Pocket Dev reuses the sign-in `copilot login` already made, which Copilot keeps in the system credential store. Pocket Dev never reads, stores or sends a token and asks for no Pocket Dev API key. The Model, Mode (Agent or Plan) and Effort settings are sent to Copilot; Effort is a command-line argument, so it takes effect in a fresh process from the next message.

What was run for real (Copilot CLI 1.0.112, macOS, signed in): three prompts sent straight to the protocol, a plain answer, a prompt that made Copilot create a file and ask permission, and the session list; and, with no prompt, starting a session with plan mode and an effort argument, changing the model and mode, resuming a saved session with `session/load` (the replayed history is not shown again), and the "Session not found" answer for a session that holds no message yet, after which Pocket Dev starts a new session and sends it the conversation so far. The recorded message shapes are what the stand-in used by the tests (`test/helpers/fake-copilot.mjs`) replays.

What was **not** run for real: a prompt typed in the Pocket Dev chat screen (the three real prompts were the budget for this check), Stop (`session/cancel`), a spent premium allowance (the wording Pocket Dev looks for is a guess, so a limit may show as a plain error without the "Continue with" buttons), Copilot on Windows or Linux, and a sign-in that is missing.

What you need:

- A GitHub Copilot plan, Copilot installed (`npm install -g @github/copilot`) and signed in (`copilot login`). Setup can install it (it asks first) and shows the login command. Copilot has no command that reports whether it is signed in, so setup cannot tick it. A signed-out Copilot makes the chat say to run `copilot login` in a Pocket Dev terminal.
- Each prompt uses premium requests of your plan.

Not done, or not possible:

- **No model list.** Copilot lists no models over the protocol, so the picker offers Auto and a field for a model name; `/model` in a terminal shows what your account can use.
- **Autopilot and Allow all are not offered.** They run without asking, so they stay in the terminal.
- **Reasoning is not shown.** Copilot sends none over ACP.
- **Terms.** GitHub's documentation presents the ACP server for editors and other clients, but no terms page that I found speaks about third-party clients of the CLI. Check your plan's terms before you rely on it.
- **Project rules** (the list of remembered commands) are Claude Code's and are not available for Copilot.

## Also planned

- Passkeys and fingerprint login.
- An Android share target.
- A room over the internet, and failover across devices.

See [Limitations](GUIDE.md#limitations) for what is not built today.
