# Connected computers and shared AI

Pocket Dev uses one computer network for personal computers and AI-only connections. The existing Chat, Terminal, Files, Git and Workspace interfaces stay in place.

## Connect and share

1. Open **Settings → Connected computers → Connect another computer**. On local **Pocket Dev Admin**, use **Devices & access → Connect or manage computers**.
2. Select **My computer** only for a computer you own. Choose **Show QR** on one computer and **Scan QR** on the other. An already logged-in phone can scan on behalf of the computer whose Settings it has open. **Choose QR photo** accepts a photo or screenshot when the browser cannot use its camera, including Wi-Fi HTTP pages. Manual connection details remain under **Enter connection details instead**. Codes expire after ten minutes and work once.
3. For personal pairing, both computers must choose the personal-computer flow. Computer access is approved by the owner on the target computer; joining a network does not grant it.
4. In **Settings → AI Tools**, turn on sharing for the installed provider. In the connected computer’s details, authorize that recipient for the provider. Either computer can share and receive at the same time.
5. Select the provider in the existing Chat provider selector. Shared entries show the source computer. The project remains on the computer selected in **Work on**.

Showing a QR on both computers does not block pairing: a computer with no other connections can still scan and join. A failed code leaves its previous state intact. Computers with existing peers keep those connections; show the QR on the network host and scan it from the new computer. Joining separate populated networks is not an automatic merge. A phone login QR and a computer-pairing QR serve different purposes.

Shared Claude and Codex sessions use the provider computer’s existing sign-in and normal engine environment. Pocket Dev does not add an API-key requirement, subscription check, billing system, or usage quota. Credentials stay on the provider computer.

## Access and execution

Computer access and provider access are separate, directional grants. Sharing Claude grants neither Codex nor general computer access. Trust in one computer never propagates to its other connections.

Each conversation records its AI source and its workspace separately. The source runs an independent agent process with its local file and command tools disabled. Its workspace requests return through an authenticated, encrypted channel to the workspace computer. A Room host can relay that channel without reading its content.

Workspace file tools check project boundaries and links. Writes, folder creation and commands follow the chat’s permission mode and approvals. Plan mode prevents mutations; Accept edits approves file edits; Never ask rejects unapproved mutations; explicitly selected Bypass skips approval cards while retaining workspace boundaries. Questions use the existing chat cards. Concurrent conversations cannot acquire overlapping project folders; use separate Git worktrees for simultaneous writers.

Turning off provider sharing, removing a recipient’s grant, or disconnecting a computer stops the affected sessions. Reconnect restores connectivity without restoring grants revoked on this computer. Source interruption or a network failure stops the current operation; commands are not automatically replayed. Switching sources waits for the current operation to end and carries the conversation forward through the existing handoff mechanism.

Relevant project content goes to the source computer and the AI service. The source computer’s administrator can inspect that processing. An AI-only connection prevents general device access; it does not conceal processing from the source administrator.

## Compatibility in this implementation

| Capability | Status |
| --- | --- |
| Personal and AI-only computers in the same network | Implemented |
| Existing sign-in for shared Claude | Implemented; no API-key gate |
| Independent, simultaneous Claude sessions | Implemented |
| Remote file reads, writes, directory creation and questions | Implemented |
| Remote command execution | Requires sandbox-exec on macOS or bubblewrap on Linux; commands remain unavailable on Windows |
| Local Codex, Antigravity and Copilot | Preserved |
| Remote Codex | Implemented for servers that confirm environment-free threads and no inherited MCP tools; native checks passed with Codex 0.169 on macOS and 0.167.1 on Windows |
| Remote Antigravity and Copilot | Unavailable until adapters can enforce execution on the requesting workspace |
| Provider and source switching | Implemented through the existing provider selector and handoff |
| Images and text attachments | Sent through the encrypted session; text attachments are limited to 256 KB each |
| Internet routes | Reuses existing configured remote addresses; no transport-based change to trust |
| Connectivity after the Room host goes offline | Existing host dependency remains; affected sessions stop |

Remote commands run with a private home directory, a minimal environment and an OS sandbox. Their sandbox currently has no network access. Local terminals and local AI engines retain their existing behavior.

Personal Codex chats can explicitly enable a separate browser through the optional Playwright MCP integration. This per-chat setting is excluded from shared-provider capabilities. Shared Codex still starts with environment-free threads and inherited MCP servers disabled; authorizing shared AI does not authorize browser access on the source computer. [Personal browser setup](AI_SETUP.md#browser-automation-in-personal-codex-chats) describes the local option.

## Upgrade behavior

The persistent computer ID is retained. Device signing keys and `connections.json` are added in the local state directory. Old blanket Room grants are revoked without deleting their project copies. Start the updated version on both computers, then approve personal access explicitly from the target computer’s details.

Local chats, messages, uploads and collaborator project copies remain on disk. Room task boards, Room chat mirrors, message replication, assigned controllers and room-wide modes are retired. Retired collaboration API routes return HTTP 410. Existing downloaded message attachments remain readable; an uncached archived attachment must be opened on its original computer.

The Admin page shows legacy project access only when old grants or copies exist, with review and revocation controls. Compatibility code for existing standalone collaborator invitations remains during migration; new computer connections use the unified grant system.

## Verification

Release validation runs the complete macOS test suite and a native Windows suite covering pairing, directional permissions, encryption, workspace operations, Codex isolation, launchers and the external updater. GitHub Actions repeats these checks. The test runner limits parallel test files to four to avoid exhausting local agent-process startup resources.

Chrome checks cover 14 phone, landscape, tablet and desktop sizes, keyboard resizing, provider/model switching, connection Settings, project editing, terminals, and both camera transports. The connection screen is checked at 390 px and 1280 px. Browser checks accept `PLAYWRIGHT_MODULE` and `CHROME_PATH`.

Separate builds were tested on a physical Mac and Windows 11 PC over Wi-Fi. Validation covered pairing, AI-only denial of computer access, discovery, encrypted SDK workspace reads, approved Windows file writes, simultaneous sessions in separate Windows projects, revocation while approval was pending, personal-computer forwarding in both directions, and reconnect without restoring revoked permissions. Real signed-in Codex model calls from both computers read the other computer's test workspace. Model requests used temporary test projects.

A live Windows Claude request reached the signed-in provider and correctly reported its weekly account limit. Successful Claude model generation could not be checked while that limit was active; its workspace tool and approval flows were verified through the real Agent SDK with a fixture CLI.

The native Codex check (`node test/native/check-remote-codex.mjs`) also created a thread with no execution environments and verified that an inherited MCP process did not start. That preflight used an isolated temporary home, no login, and no model prompt. The adapter refuses incompatible servers before sending a prompt. The protocol contract can be inspected through `codex app-server generate-json-schema --experimental`; see also the [Codex app-server reference](https://developers.openai.com/codex/app-server).

Live validation found and fixed a Windows npm batch-launch failure and a WebSocket startup race when the upgrade and first encrypted message arrive in one packet. Regression tests cover both. Windows shared commands and remote Antigravity/Copilot remain unavailable as described above. Linux runtime and a public-internet connection between physical computers were not tested for this release.
