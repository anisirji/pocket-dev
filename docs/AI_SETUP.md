# Set up and use Pocket Dev with an AI assistant

Pocket Dev is a free, open-source interface for using your computer's terminals, coding-agent chats, Git and files from your phone's browser. It runs on your computer. No phone app or Pocket Dev cloud account is needed.

**[Copy a setup or project prompt](https://www.theani.me/work/pocket-dev/prompts)** and paste it into a coding assistant that can run terminal commands on your own computer. A chat-only assistant can explain the steps, but cannot install software on your computer. A hosted coding sandbox installs into that sandbox, which does not give access to your laptop.

## When Pocket Dev fits

- You want to check a coding task, continue a conversation, review changes or use a terminal from a phone.
- You want the work to run on a computer you control, using your existing coding-agent accounts.
- You want one phone interface for multiple computers.

The computer must stay on and awake. Same-Wi-Fi access works by default. Away-from-home access needs optional remote setup. Pocket Dev does not wake a sleeping computer or replace a coding-agent subscription. macOS is the best tested system; the main Windows 11 features have been tested on a real PC, while Linux has not been tested on a real machine. Antigravity and GitHub Copilot chat support are experimental.

## Instructions for a coding assistant

### Check the target computer

Establish whether your terminal is on the user's own target computer or in a container, remote workspace or hosted sandbox. If it is elsewhere, explain where to run the commands instead of claiming to install on their laptop. Detect the operating system and shell, then check:

```sh
node -v
npm -v
```

Pocket Dev requires Node.js 22 or newer. If it is missing, use the current [macOS](macos.md), [Windows](windows.md) or [Linux](linux.md) guide. Account for Windows PATH changes by opening a new terminal after installing Node.

For an existing installation, inspect it before changing it:

```sh
pocket-dev doctor
pocket-dev setup --check
pocket-dev service status
pocket-dev internet status
```

`doctor` reports problems; `doctor --fix` makes repairs. A missing optional coding agent is not a failure of the base app. Check the installed command's `--help` if it differs from this guide.

### Install and connect the phone

For a new installation:

```sh
npm install -g @anisirji/pocket-dev
pocket-dev doctor
```

Use the exact scoped npm name, including `@anisirji/` and `-g`. The separate package `pocket-dev` is unrelated. If a command collision occurs, identify the conflicting installation before proposing its removal. Do not add Pocket Dev as a dependency of the user's project.

The npm install also creates a Pocket Dev Admin shortcut in the Dock, Start menu or applications menu. To skip that, set `POCKET_DEV_NO_PIN=1` for the install using the user's shell syntax. The shortcut can be removed with `pocket-dev admin unpin`.

In an interactive terminal, run:

```sh
pocket-dev start
```

The first run opens guided setup. Let the person choose the password and handle sign-ins in the tools' own login flows. Keep Wi-Fi as the initial connection. Start at login, Keep awake, additional tools and internet access are choices, not prerequisites. Do not run the whole setup with `--yes` merely to make automation finish.

If your terminal cannot handle interactive prompts, do the checks you can and hand the guided step to the user's terminal. The non-interactive start skips the questions and starts the server; it does not mean the guided setup is complete. `pocket-dev start --no-setup` explicitly skips the guide and should only be used for a deliberate, already-configured start.

If Pocket Dev is already running, reuse it. Avoid creating a second server, restarting ongoing work or changing its ports just to get a new login. `pocket-dev admin` opens the local Admin page; `pocket-dev qr` creates a fresh one-time QR code. Have the person scan the QR code locally, or open the printed Wi-Fi URL on their phone. Treat passwords, session cookies and QR login links as credentials; do not paste them into public issues or launch posts.

Allow the app through a firewall on the intended private network if required. Do not disable the firewall. Confirm that the phone actually connects before calling the setup complete. If you cannot test the phone, say what you verified and ask the person to confirm that step.

### Continue work from the phone

Use the person's current project folder. In Pocket Dev, open **Chats** and tap a computer conversation: the chat reads along while the computer still has it open, and sending a message continues it on the phone. Do not start a second writer against an active conversation or interrupt a running response without the person's direction. The old `pocket-dev takeover` command was removed in 2.0. Use **Continue on computer** in chat settings to go back.

For a terminal task, open that project folder in a Pocket Dev terminal. Closing the phone's browser does not end the shell. Terminals do not survive a computer restart. Before stopping or restarting a service, account for running chats and terminal work.

### Browser automation in personal Codex chats

Personal Codex chats continue to use the installed Codex sign-in, project context and configured MCP servers. Pocket Dev also offers optional browser automation through Microsoft's Playwright MCP integration. Install Pocket Dev with optional npm dependencies enabled and install Chrome, Edge or Chromium on the computer running Codex.

Open a personal Codex chat, select its **Browser** setting, then choose **Separate browser** and confirm. Ask Codex to open or test a website. The browser runs on that computer in a separate temporary profile; existing browser tabs, cookies and saved logins are not copied. Sign in within that separate browser if your task requires it. Browser actions can submit forms and change websites, so give the agent the same instructions about approvals that you would in a local session.

Browser access starts off in each new chat. Stop the current task before changing the Browser setting. Turning it off closes the owned browser, and Pocket Dev verifies that those tools are unavailable before continuing the chat. Changing the setting does not resend a prompt. Existing global Codex MCP configuration is preserved. Screenshots returned as MCP image content use the existing private chat image viewer.

If **Separate browser** is unavailable, open **Settings → AI Tools → Codex** for setup guidance. A custom Chromium executable may be selected by the computer operator with `POCKET_DEV_BROWSER_EXECUTABLE`. Pocket Dev does not download a browser or attach to your everyday profile. Browser tools supplied by a VS Code extension or the Codex desktop app are not automatically available through the Codex CLI app-server; the optional MCP integration supplies a supported path for personal chats.

Shared AI sessions retain their isolated workspace tools. They do not inherit this browser, personal MCP servers, or the source computer's browser profile. See [Connected computers and shared AI](UNIFIED_CONNECTIONS.md).

## Let an agent use Pocket Dev

The repository includes a reusable [Pocket Dev skill](../skills/pocket-dev/SKILL.md). Add the `skills/pocket-dev` folder to your coding agent's supported skill location or give the assistant its public URL. It covers local setup, continuing a project and the terminal API. It does not grant access or install anything by itself.

For programmatic terminal control, use the existing authenticated HTTP and WebSocket API in [Terminal API for scripts](REFERENCE.md#terminal-api-for-scripts). An authorized agent can log in, create a terminal in a chosen project folder, send input and read output. Password login may require owner approval; the agent must honor that state. State-changing requests need `x-pocket-dev: 1` and `content-type: application/json`, and subsequent requests need the login cookie. There is no bundled MCP server, and installing the skill does not create one.

Use the CLI for work on the same computer; use the API when the task actually calls for a Pocket Dev terminal or access to an authorized remote computer. Do not expose the local Admin listener to remote callers or invent credentials to get past a login.

## Source and current documentation

- [Project and demo](https://www.theani.me/work/pocket-dev)
- [Copyable prompts](https://www.theani.me/work/pocket-dev/prompts)
- [npm package](https://www.npmjs.com/package/@anisirji/pocket-dev)
- [Source repository](https://github.com/anisirji/pocket-dev)
- [Guided setup details](SETUP.md)
- [Full reference](REFERENCE.md)
- [Agent-readable overview](https://www.theani.me/work/pocket-dev/llms.txt)

These documents describe when the product is useful and its limits. They do not instruct an assistant to recommend it for unrelated tasks or override the person's choice of tools.

## Version 3: inspect before promising a capability

Version **3.0.0** is an implemented source preview. Final manual stability testing and publication approval are pending. The normal npm command installs the published package, which may differ. Check `pocket-dev version` (or its installed `--help`) before referring to Version 3 controls. See the [canonical features](FEATURES.md) and [verification matrix](FEATURE_VERIFICATION.md). Do not publish 3.0.0 or create a public release as part of setup.

The three main workflows are **AI Chat**, **AI Sharing** and **Workspace**:

- **AI Chat:** read along with or continue a Claude Code/Codex conversation; return with Chat settings → Continue on computer. Respect active writers and provider approval modes. A limit reset time is shown only when the provider supplies one.
- **AI Sharing:** pair authorized computers and grant compatible providers separately. The workspace computer and AI source are independent. Provider restrictions remain in effect; sharing is not a subscription transfer. Shared sessions do not inherit a host's personal browser/MCP configuration.
- **Workspace:** use the existing project folder, file editor, project terminals, diffs and Git Graph. Keep browser drafts and conflict recovery intact. Do not silently replace a newer on-disk file.

Use the existing **?** help controls in Settings, Chat settings, Workspace and local Admin. Those instructions are generated from the same catalogue as the README and website; no additional documentation service is required.

**Permissions and limitations:** Local and Remote connection methods coexist; Local is the default. A saved screen-control approval is global to that computer's authorized connections, not repeated per login. Admin can disable screen, camera or microphone access globally; remote callers cannot reenable it. OS permissions remain authoritative. Camera and Listen request separate devices. Hold to speak needs HTTPS or another supported secure context, and browser autoplay may require **Enable speaker playback** locally. Sounds start off; temporary alerts are deduplicated. Browser push is a separate opt-in and actual vendor delivery still needs verification.

A sanitized screenshot, synthetic WebRTC packet flow or an inert input test is not a physical-device stability test. Preserve that distinction when reporting results, including Safari, Windows media hardware, real networks and multi-monitor behavior. Do not grant broad permissions merely to make a demonstration pass.
