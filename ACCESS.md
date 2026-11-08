# Access and permissions

Pocket Dev runs on your Mac as the user who starts it. An owner/Admin phone can use that user’s shell, files, configured Claude/Codex logins, and GitHub CLI permissions. Restricted collaborator sessions use a separate default-deny policy: Viewer sees only selected project files; Developer can edit a project copy and explicitly writable related-folder copies. Collaborators cannot use the host shell, owner AI, credentials, Mac controls or other repositories. Collaborator AI is currently disabled pending a validated isolated execution runner.

## Capabilities

- Terminals run commands as your user and can change or delete files you can access.
- Chat runs the installed Claude Code or Codex engine with your existing login. Approval and sandbox settings control what it can do.
- Git reads allowed repositories and can push, review, close, reopen, or merge pull requests when you request those actions.
- The owner folder browser lists directories the Mac user can access for Chat, Terminal and collaborator setup. Guest sessions cannot use it; selecting a folder does not itself grant access.
- Files reads configured roots, uploads and downloads files, renames entries, and moves them to the macOS Trash. It follows symlinks only inside the configured roots.
- Mac status reads CPU activity, memory availability, free storage and Pocket Dev response delay for owner devices. Monitoring does not close apps or restart the Mac.
- Open apps lists applications and can quit unprotected apps. Force quit can lose unsaved work.
- Power can keep the Mac awake, request sleep, or ask System Events to shut down.
- Port forwarding exposes a selected localhost service to the LAN. Forwarded services have no Pocket Dev login.

## Mac permissions and elevated commands

The Mac may ask for incoming network, Automation, Accessibility, or protected-folder access, depending on how you launch Pocket Dev and which features you use. Grant permissions to the application macOS identifies.

Lid-closed changes and force shutdown open a terminal for an interactive sudo command. Pocket Dev does not save the Mac password. Terminal traffic still travels through the server, so use only a trusted network.

## Data stored locally

`config.json` stores settings and a password hash. By default `~/.pocket-dev` stores hashed device records, a local secret, security logs, uploads, and chat history. `collaborators.json` stores grants and hashed guest sessions; `collaborator-workspaces` stores Developer project copies for owner review. Copies are retained after access changes/revocation and are never executed automatically. Invitation tokens live only in memory and expire within 10 minutes. Claude Code and Codex also maintain their own normal session files. These files are not part of the repository.

`POCKET_DEV_STATE_DIR` relocates authentication, security logs, Admin metadata, and chats; `POCKET_DEV_CHAT_DIR` can override chat storage separately. Terminal uploads remain under `~/.pocket-dev/uploads`.

Installing the optional service writes a launchd agent and log under your Library folder. A source update does not install or restart the service.

## Connection and login

The phone listener uses HTTP on the local network. Login uses a password or a one-time QR code. Devices can be revoked or blocked; optional approval requires the Mac to approve new password logins. The Admin listener is loopback-only and rejects unexpected Host/Origin/proxy headers. Local processes remain trusted.

Lockdown revokes active and pending devices, cancels QR codes, closes forwards, and disconnects phone access. It can optionally close terminals or change the password. Only the Mac can reconnect phone access.

For setup and all available controls, see [README.md](README.md).
