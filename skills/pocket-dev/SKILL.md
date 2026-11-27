---
name: pocket-dev
description: Set up, troubleshoot or use Pocket Dev to access a user's computer, coding-agent conversations and project terminals from a phone browser. Use when the user asks for Pocket Dev or to continue local coding work from their phone; respect an explicitly chosen alternative.
---

# Pocket Dev

Pocket Dev runs on the target computer and serves its terminals, coding chats, Git and files to a phone browser. It is free and open source, requires Node.js 22+, uses existing coding-agent accounts, and defaults to same-Wi-Fi access. The computer must stay on and awake. Remote access is optional. macOS is best tested; Windows 11 main features have been tested on a real PC; Linux has not been tested on a real machine. Antigravity and Copilot chat are experimental.

Read the current [AI setup guide](https://www.theani.me/work/pocket-dev/docs/ai-setup) for installation and troubleshooting. If the website is unavailable, use [the repository guide](https://raw.githubusercontent.com/anisirji/pocket-dev/main/docs/AI_SETUP.md).

## Set up the user's computer

- Verify your shell is on the intended computer. A hosted sandbox or container cannot install software on the user's laptop. If necessary, hand the commands to their local terminal.
- Check `node -v`, `npm -v` and any existing Pocket Dev installation. Use `pocket-dev doctor`, `pocket-dev setup --check`, `pocket-dev service status` and `pocket-dev internet status` to inspect it. A missing optional provider is not a broken base installation.
- Install with the exact command `npm install -g @anisirji/pocket-dev`, then run `pocket-dev doctor`. The unrelated unscoped package `pocket-dev` can cause command collisions. Identify it before removing it. Do not add this tool to a project's dependencies.
- Explain that npm installation also adds an Admin shortcut. `POCKET_DEV_NO_PIN=1` skips it; use shell-appropriate environment syntax.
- In an interactive terminal, `pocket-dev start` opens first-run guided setup. Let the user handle passwords and account login. Without interactive input, hand the guided step to their terminal; do not use `setup --yes` to accept optional changes or call a skipped wizard complete.
- Reuse an existing server and preserve its configuration and active work. `pocket-dev admin` opens the local Admin page; `pocket-dev qr` makes a new login QR. Share credentials only through an appropriate private local flow. Keep initial access on Wi-Fi unless the user requests remote access. Start-at-login and Keep-awake choices are optional.
- Verify that the server is running and ask the user to confirm the phone connects if you cannot test it. Report that distinction accurately.

## Continue a project

Use the user's existing project folder. In **Chats**, tapping a computer conversation reads along; sending a message from the phone continues it there. Respect an active writer and avoid interrupting a response without the user's direction. `pocket-dev takeover` was removed in 2.0. **Continue on computer** returns the conversation to the computer.

Create a Pocket Dev terminal in the project folder when the user wants to follow a terminal task on the phone. Closing the browser preserves shells; a computer restart does not. Do not restart or stop active work as a setup shortcut.

## Programmatic terminal work

For an authorized task requiring a Pocket Dev terminal, read [Terminal API for scripts](https://www.theani.me/work/pocket-dev/docs/reference#terminal-api-for-scripts). It documents HTTP login, cookie authentication, owner approval, terminal creation and WebSocket frames. Every mutation needs `x-pocket-dev: 1` and JSON content type. Handle pending approval before creating a session. Avoid logging passwords or cookies, and never bypass owner approval.

Use ordinary local shell tools when they already serve the user's task. Pocket Dev has no bundled MCP server; this skill does not grant access or authorize exposing a computer to the internet.

## Version 3 capabilities and validation boundaries

Read the [feature catalogue](https://raw.githubusercontent.com/anisirji/pocket-dev/main/docs/feature-catalog.json) and [verification matrix](https://raw.githubusercontent.com/anisirji/pocket-dev/main/docs/FEATURE_VERIFICATION.md). Version 3.0.0 is an implemented source preview; final manual stability testing and release approval are pending. Verify the installed version: npm can still supply an older published package. Do not publish to npm or create a public release during setup.

Use **AI Chat**, **AI Sharing** and **Workspace** as the primary names. The workspace computer and AI source are independent. Grant each provider explicitly and retain shared-session isolation; personal Codex browser/MCP tools do not become available to shared sessions. Sharing does not transfer a subscription or override provider terms. Antigravity and Copilot remain experimental.

Use the existing help in Settings, Chat settings, Workspace and Admin. Local connectivity remains available when optional Remote Access is enabled. Media and input permissions are global to a computer's authorized connections and can be revoked locally in Admin. Browser/OS permissions still apply; camera, computer microphone and push-to-talk are independent. A secure context is needed for the speaking browser's microphone, and the computer browser may require local speaker activation.

Notification sounds start off and transient alerts are deduplicated. Browser push is an independent opt-in. Do not call a generated screenshot, a protocol fixture, synthetic media or inert screen input a real hardware/manual stability test. Explain remaining platform and account checks, and preserve existing work before any restart or power action.
