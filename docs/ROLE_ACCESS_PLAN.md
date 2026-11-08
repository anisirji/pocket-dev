# Role-based sharing: proposed first release

Status: implementation in progress, authorized by the owner on 2026-11-08. The access and file-sharing foundation is implemented; repository-scoped AI is not implemented or enabled. The target design below remains the requirement for completing AI collaboration.

## Current implementation

- Collaborators appears in Mac Admin and phone Settings. The Mac owner must explicitly select the trusted devices retained as Admin before enabling sharing. Other active devices become pending; later password logins require Mac review, and new Admin pairing stays Mac-local.
- Viewer access is read-only for one repository and explicitly selected related folders. Developer file access uses a separate project copy; writable related folders are copied too. Read-only related folders stay read-only. Copies omit Git metadata, dependencies, symlinks and common credential files. Owners must review shared contents because secrets can have arbitrary names.
- Invitations use a separate guest cookie, one-use random tokens with a 10-minute lifetime, explicit acceptance, and access durations of 1 hour, 1 day or 7 days. Tokens are in the URL fragment, so preview GETs do not send or consume them. Existing sessions must log out before acceptance. Guest admission never evicts an Admin.
- Guest requests are denied by default before owner/auth routes and all WebSocket upgrades. Only scoped Files, the current-access summary, status and logout are available. File operations use request-local roots and check symlinks, source availability, owner sharing policy, write modes, expiry and revocation. Grant changes invalidate outstanding invitations and existing transfer scopes. Revoked/expired guest sessions cannot regain access when a grant is renewed.
- Redeemed grants and hashed sessions live in private `collaborators.json`; unused invitation tokens are memory-only. Developer copies live under `collaborator-workspaces` in the state directory and remain available to the owner for review. There is no automatic apply or host execution.
- **AI is deliberately unavailable to every guest.** On this Mac, the Docker CLI is present but its engine socket is unavailable. A project copy is not an execution sandbox. A validated isolated runner, supported AI authentication, network restrictions, per-grant Chat, resource controls and escape tests are still required. The full original AI-collaboration feature is incomplete until those are delivered.

No live migration, invitation, or service restart was performed during implementation. Enabling access requires the owner's trusted-device review in Mac Admin. HTTP remains suitable only for a trusted private connection; roles do not encrypt traffic.

## Purpose

Let the Mac owner give a developer access to one selected repository, AI assistance for that repository, and explicitly selected related folders, including an optional folder under the Mac's Downloads directory. Other repositories, personal folders, credentials, conversations, and Mac controls remain inaccessible. Keep the existing owner experience and device management. Use device access grants rather than introducing accounts, passwords for every guest, organizations, or a general permissions product.

Confirmed scope: repository-scoped AI access is a core first-release requirement. A file-sharing-only release would not satisfy this use case. An isolated execution workspace is part of the feature's enforcement; choosing a working directory or filtering the Files page is insufficient.

## Recommended roles

| Role | Scope | Actions |
| --- | --- | --- |
| Admin | Owner's trusted devices | Existing owner features, plus creating and managing restricted guest invitations. Pairing another Admin device remains a Mac-local action. |
| Viewer | One selected repository and explicitly selected related folders | List, search, preview, download, and export permitted files. No file changes or AI execution. |
| Developer | One isolated repository workspace and explicitly selected related folders | Work on that repository with the enabled AI engine, view and change workspace files, run the AI's project commands inside isolation, and download allowed files. Extra folders are read-only unless the owner explicitly grants write access. |

Developer is an appropriate name because this version includes scoped AI work, not only file management. Reuse the existing chat and Files interfaces. A full code editor is outside the role feature; the AI performs code changes in its workspace. A separate interactive terminal is not required for the first release.

All guest roles exclude the owner's host terminals, AI conversations, global history, credentials, other repositories, port forwarding, screen capture, apps, power, owner settings, and device administration. Developer AI and any Git commands operate only inside that grant's execution workspace. A guest cannot issue invitations, change AI sandbox limits, attach host files by guessing a path, or upgrade its own access. Static browser assets do not grant capabilities; every underlying request must be authorized.

Do not add arbitrary custom roles or a permission-checkbox matrix in the first release. The configuration is role, repository, AI enabled/disabled, extra folders with read/write mode, and access duration. Folder grants inherit to their contents and subfolders. Exact individual-file grants can follow if actual usage calls for them.

## Small owner flow

Add **Invite someone** to the owner's Admin profile, including the phone. Reuse that form in the Mac admin Share & login section:

1. Optional label, such as “Sam, website development.”
2. Role: Viewer or Developer, with its allowed actions summarized.
3. Choose one repository. Developer enables AI for that repository by default; the owner can turn it off.
4. Optionally add specific related folders and choose read-only or read/write for each. Home and the whole Downloads folder are never preselected.
5. Access duration: 1 hour, 1 day (default), or 7 days.
6. Generate one invitation, then offer **Share invite**, **Show QR**, and **Copy link** for that same invitation.

Example: “Sam · Developer · Website repo · AI enabled · Downloads/Website-assets (read-only) · Access for 1 day.”

This allows the Website repository, that developer's AI chats for Website, and the selected assets folder. It does not allow another repository, Documents, the rest of Downloads, or the owner's existing chats. Downloading an allowed file to the recipient's device does not itself grant access to the Mac's Downloads folder.

The QR may be redeemed once within 10 minutes. The guest's access duration begins on redemption. The QR contains an opaque random token; the role, folders, and duration stay on the server. Editing URL parameters cannot increase access. Anyone holding an unused QR/link can redeem it, so it is an access credential, not proof of a person's identity.

The guest scans the QR or opens the shared link, accepts the invitation, and lands in the assigned project. A Developer sees only that project's Chat and Files; a Viewer sees Files. Show role, project name, extra folders, expiry, and Log out. Do not show disabled Mac-control panels or the owner's global folders, recent projects, histories, or other devices. Reuse Chat and Files components instead of building a second dashboard.

### Sharing to WhatsApp

- **Share invite** opens the device's native share menu when supported. The owner chooses WhatsApp, chooses a contact, and sends. Pocket Dev does not need contact access, a WhatsApp integration, or an automatic messaging service.
- Where native sharing is unavailable, provide **Share on WhatsApp** to open a prefilled message in WhatsApp/Web, with **Copy link** always available as a fallback.
- Share a short message and the same scoped invitation link used by the QR. Do not include absolute folder paths or secrets in the message. The role, folders, one-use limit, and expiry are enforced by the server regardless of how the link is delivered.
- Canceling the share menu is not an error and does not use up the invitation. Show “Share menu opened” or “Link copied” as appropriate; do not claim that WhatsApp delivered a message.
- Link previews and automated fetches must never consume the invitation or create a session. An invitation GET serves a generic landing page with no private file information; accepting the invitation is an explicit browser action through a protected POST. Keep preview metadata generic, avoid caching the token-bearing page, and remove the token from the displayed URL after successful acceptance.
- A WhatsApp message does not make a local Mac address reachable from another network. For the initial local-network release, show “Recipient must be on the same Wi-Fi.” Remote access requires a separately configured secure connection.

In the existing Devices section, show label, role, folders, expiry, and status. Support changing role/folders/expiry and Revoke. No separate Users, Teams, Groups, or role-editor screens.

Guest invitation redemption must not evict an Admin device when the device limit is full. Refuse the invitation and let the owner make room. An invite opened by an already logged-in browser must not silently merge permissions or promote that browser; show which existing session must be signed out before using the invite. Blocked devices remain blocked.

Keep an explicit **Pair my own device** flow for Admin access, distinct from **Invite someone**. Creating Admin credentials remains a Mac-local owner action. An authenticated Admin phone may create or manage Viewer/Developer invitations, but a guest cannot. Do not distribute the owner's password to guests. Review existing password, QR, and phone-settings routes so they cannot offer an alternative path to Admin access.

## Enforcement that must ship with the UI

1. A central authorization helper resolves the current device's server-stored role, scopes, expiry, and revocation state. Unrecognized roles and unclassified routes are denied.
2. Apply it before dispatching all protected HTTP handlers, including authentication/settings-owned routes and phone service routes. Guard every WebSocket upgrade as well. Hiding buttons is secondary.
3. Give guest file operations an immutable request-local scope. Do not change the Files handler's shared `roots` variables for each device; concurrent requests must not inherit another device's access.
4. Intersect a guest's granted repository/folders with the owner's sharing policy. Check both lexical paths and resolved real paths. Cover search, previews, original downloads, ZIP traversal, uploads, rename source/destination, Trash, and all AI tools. Paths presented to an isolated agent must map to its workspace, not arbitrary host paths. Do not expose metadata about denied paths.
5. Missing, moved, deleted, inaccessible, or empty shared roots fail closed. The current Files fallback to the home directory must never apply to a guest.
6. Do not directly expose Pocket Dev's running source, public assets, runtime state, authentication files, or credential directories as guest-writable host folders. A repository that contains the running application can be shared only as an isolated checkout. Scrub repository configuration of host credential paths and embedded tokens; do not expose the owner's global Git settings or credential helpers. Keep secret files out of workspace provisioning unless separately and deliberately supplied as scoped project secrets. The owner must still review shared contents; secrets can have arbitrary names.
7. Changing a grant or revoking it immediately affects new requests, invalidates outstanding invitations tied to that grant, closes relevant connections, stops its AI work and processes, revokes its runner access token, and cancels or rechecks in-progress transfers. Shrinking scopes requires rebuilding the workspace boundary before work resumes. Authorization must not be cached for the cookie's full lifetime. Bytes already delivered cannot be taken back.
8. Clear saved drafts and sensitive client state on logout, loss of authorization, and an access change. The guest gets a current access summary after reconnecting.
9. Record invitation creation/redemption, grant changes, expiry, and revocation in the existing security log. Never log invitation tokens, cookies, or file contents.

Folder access controls do not stop someone from copying a file they can download or protect an owner who later executes code written by a Developer. Changes must not be automatically executed on the host outside the isolated workspace.

## Isolated project AI is required

Current terminals run under the Mac owner's account. Claude/Codex use that account's installed engines, environment, logins, and session storage. Selecting a working directory does not isolate readable files, credentials, processes, network access, or shared conversations. Codex Workspace mode is not a promise that a guest can only read a selected folder.

Use one execution backend for the first version, with an isolated workspace per developer grant:

- Provision a clean checkout of the selected repository in the workspace. Keep changes separate from the owner's live checkout and let the owner review/apply the resulting diff or commits. Reuse existing Git concepts rather than adding a new approval product.
- Expose only the selected extra folders, read-only by default. In addition to the shared project data, the runtime necessarily has its own operating-system/tool files and private scratch space; these do not represent access to other Mac folders.
- Run the AI engine and all its commands/tools inside this boundary. Starting a host engine with a restricted `cwd` is not an alternative. Do not reuse the owner's live Codex daemon, Claude process, global transcripts, or owner chats.
- Give each grant separate AI sessions, uploads, generated images, task state, and downloads. Checking a repository path alone is not authorization to resume someone else's chat or fetch its attachments.
- Keep host credentials out of the runner. AI authentication must use a supported scoped credential/broker or the developer's own sign-in; do not mount or copy the owner's `~/.codex`, `~/.claude`, SSH keys, or GitHub credentials. A shared-owner AI budget must be enforced outside the runner. The feasibility phase must settle this authentication path before promising a particular engine.
- Do not mount the Docker/runtime socket, host home directory, host process namespace, or arbitrary owner-selected runtime arguments. The server constructs and validates the entire execution configuration from the grant.
- Restrict outgoing network access outside the runner, with only the approved AI provider and necessary project dependencies allowed. Block access to the Mac's Admin listener, Pocket Dev management routes, other local services, and private networks. A container's normal bridge network alone is not this restriction.
- Start workspaces on demand, apply resource limits, and stop idle or expired workspaces. Keep the owner UI small even though execution enforcement requires real isolation.

A VM-backed container runner with explicit mounts is a candidate. Docker documents both [read-only bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) and the risks of [exposing daemon control or excessive host paths](https://docs.docker.com/engine/security/). A Docker CLI exists on the current Mac, but its daemon availability, supported host version, isolation configuration, and engine compatibility have not been verified. Do not require a new heavy runtime without first checking what is usable here.

For the first supported engine/project combination, prove that it works within the selected runtime. Linux workspaces may not support Mac-native build requirements; show an unsupported-workspace state rather than silently moving execution back to the owner's Mac account. Support one validated engine/backend first, then add the second engine using the same grant boundary.

Do not add command regex allowlists or rely only on model instructions to simulate this boundary. Git operations can invoke executable configuration and use owner credentials too; treating Git as harmless folder-scoped execution would need separate review.

## Compact implementation structure

- `auth.js`: store the grant reference on device records; validate invitation redemption, expiry, role changes, and revocation. Expiry is enforced server-side even while a browser has an active connection.
- A small authorization module: role definitions and common checks, with a default-deny route policy.
- `server.js` and auth/phone-admin routing: apply that policy before existing feature handlers and upgrades. A small current-access endpoint supplies guest UI capabilities without exposing owner settings.
- `files.js`: accept request-local allowed roots and read/write capabilities; retain existing path validation and streaming behavior, with guest-specific restrictions.
- Chat and engine adapters: bind a guest chat to its grant/workspace; start a separate engine in the isolated runner; validate every read, write, upload, attachment, resume, image, download, and socket path against that grant. Owner chats continue using the current host adapters.
- One workspace runner: create/stop workspaces, apply fixed mount/network/resource policies, and export changes/artifacts. Guest payloads cannot select arbitrary mounts, host paths, credentials, or execution flags.
- Owner UI on Mac and phone: reuse the invitation form, native/WhatsApp/copy sharing actions, and added guest-access fields/actions in Devices. No external messaging integration.
- Guest shell: reuse Chat and Files UI with scoped places, project-specific conversations, an access summary, and no owner-only data requests.
- Existing private JSON state remains the storage mechanism. Invitation tokens can remain short-lived in memory, so a restart expires unused invitations. Redeemed grants persist with device access. No new database or external service is required for this scope.

## Safe migration

Do not silently declare every existing logged-in browser an Admin. On enabling role-based sharing, have the owner review existing devices from the Mac. Explicitly retain trusted owner devices; unreviewed devices require re-pairing or an assigned restricted grant. The Mac-local admin console remains the recovery path.

Audit every current login path, including CLI-minted QR codes, pending-device approval, phone QR generation, and password login. Guest access cannot be enforced safely while any of those paths lets a guest create or acquire a full-access session.

## Delivery order

1. Prove one isolated repository + AI workflow: read/edit an allowed file, run a project command, consume a read-only extra folder, export a diff, and fail to read a second repository, host credentials, or a host management endpoint. Resolve AI authentication, runtime availability, and native-project compatibility here.
2. Implement and test shared authorization, grant ownership, workspace-bound Chat/Files operations, and request-local path scopes, with guest creation disabled until enforcement is complete.
3. Add scoped invitations, expiry, immediate role updates, revocation, and migration handling. Revocation must stop both browser access and ongoing execution.
4. Add the minimal owner invitation controls, WhatsApp sharing, and project-specific guest Chat/Files view.
5. Exercise the full scan, AI work, download, owner review/export, edit/revoke, disconnect, and reconnect flow on a phone.

Completion requires negative tests, not only a working QR scan: a Viewer directly posting a write request; a guest requesting another folder, chat, image, terminal, screen, or privileged setting; symlink and rename escapes; empty-scope fallback; simultaneous Admin/guest requests; expired/reused/modified invitation tokens; device-limit behavior; role changes during uploads/downloads; reconnect after revocation; and attempts to change one's own role or create another invitation.

AI-specific tests must attempt to escape through shell commands, alternate working directories, absolute attachment paths, linked Git worktrees, tool/plugin integrations, owner thread IDs, host gateway networking, and credentials in environment variables. No bypass/full-access setting may weaken the outer workspace boundary. Confirm that revocation kills long-running commands and prevents them from regaining access through a new connection.

## Network prerequisite

Role boundaries do not encrypt traffic. The existing HTTP transport remains a separate risk for login credentials, invitation redemption, and shared file data. Verify HTTPS/WSS deployment and cookie/origin handling before using invitations with people outside a trusted private connection. Do not present roles alone as making public or untrusted-network sharing secure.

## Deliberately deferred

Custom role creation, groups, organizations, email invitations, person accounts, billing screens, a database, a separate interactive terminal, per-command permission builders, a full code editor, multiple execution backends, and additional unvalidated AI engines are outside this first release. Repository-scoped AI isolation is part of this release's essential security work and is not deferred.
