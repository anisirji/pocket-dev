# Pocket Dev 2.4.0

Connect personal computers and AI-only computers through **Settings → Connected computers**. Share installed Claude or Codex from **Settings → AI Tools**, then authorize individual recipient computers. Existing sign-ins are used without an added subscription, API-key requirement or billing system.

Choose a shared provider in Chat's existing provider selector. Each conversation keeps its AI source separate from its workspace. The source runs an independent session; project file tools and approval cards execute on the workspace computer through an authenticated, encrypted channel. Explicit personal-computer access enables the existing computer switcher and forwarding. AI-only access grants neither computer control nor another provider.

Revoking sharing, disconnecting a computer or losing the source connection stops the affected work. Concurrent writers need separate projects or worktrees. Reconnecting does not restore revoked local permissions.

Settings now groups connection, AI, security and device controls. Room task boards, assigned controllers, chat mirrors and message replication are retired. Existing chats, downloaded messages and saved project copies remain on their original computers. Legacy blanket Room access requires fresh approval after updating both computers.

Windows Codex startup now resolves the npm launcher's native executable and waits for shared Codex to exit before removing its temporary workspace.

## Supported scope

- Shared Claude and compatible Codex support remote file reads, writes, directory creation and questions on macOS, Windows and Linux.
- Shared command execution requires macOS `sandbox-exec` or Linux `bubblewrap`. Windows shared command execution is unavailable; local terminals and local AI commands remain available.
- Shared Antigravity and Copilot are unavailable. Their existing local integrations remain available.
- Shared Codex requires a version that confirms an environment-free thread and disables inherited MCP capabilities. The native contract was verified with Codex 0.169 on macOS and 0.167.1 on Windows.
- The existing Room host still carries relayed connections; its interruption stops those sessions.

See the [connection and sharing guide](UNIFIED_CONNECTIONS.md) for permissions, migration, compatibility and validation details.

Physical Mac-to-Windows validation included real signed-in Codex model replies in both directions. The live Claude request reported the source account's weekly limit; Claude workspace reads, approved writes and revocation passed through the real Agent SDK with a fixture CLI. Linux runtime and physical public-internet routing were not validated for this release.
