// Written help shared by the existing Settings, Workspace and local Admin interfaces.
(() => {
  // BEGIN GENERATED FEATURE GUIDES: node scripts/render-feature-docs.mjs
  const definitions = Object.freeze({
    "workspace": {
      "title": "Workspace",
      "steps": [
        "Choose the computer that owns your project, then open its folder.",
        "Edit files, use the project terminal, and select an AI source independently.",
        "Git badges describe saved changes. Choose Changes to open the existing Git comparison.",
        "Save explicitly or enable auto-save. If a file changes elsewhere, compare it before replacing your draft.",
        "Use the Git action for the existing diff and Git Graph. Project terminals start in the selected folder."
      ],
      "troubleshooting": "Offline drafts stay in this browser. Reconnect to the same computer and project. Conflicts keep your draft until you choose how to resolve them.",
      "video": null
    },
    "screen": {
      "title": "Device screen",
      "steps": [
        "Keep the computer awake and signed in. Allow Screen Recording for the program running Pocket Dev on the Mac.",
        "Use the options menu to choose a supported display or image quality. Snapshot downloads the current image.",
        "Optional Mac input also needs Python 3 and Accessibility permission. Approve screen control once in local Admin; the approval covers all authorized connections to this computer.",
        "Admin can be closed after approval. Stop ends a connection; Admin → Permissions disables access globally and immediately. Reconnecting requires a fresh Control request but no repeated approval while permission remains enabled."
      ],
      "troubleshooting": "Wallpaper without app windows usually means Screen Recording needs permission. Locked screens and macOS authorization dialogs block input. Only one controller is allowed. Native input remains subject to the Mac’s permissions; unsupported computers retain viewing.",
      "video": null
    },
    "camera": {
      "title": "Camera & audio",
      "steps": [
        "Prepare the camera from the computer’s local Admin page if you want video. Camera permission does not grant microphone access.",
        "Choose Camera and Listen independently, then start. Turn Camera off for an audio-only session. Listen asks for the computer microphone separately.",
        "On a supported secure phone address, hold to speak through the computer. Allow your microphone if asked, then hold again. Releasing stops its audio track.",
        "Snapshot saves a video frame to your device. Stop, leave the page or use Stop camera & audio on the computer to end media access."
      ],
      "troubleshooting": "Keep the computer browser open and allow each requested permission. If speaker autoplay is blocked, use Enable speaker playback in the computer tab. Audio requires direct WebRTC; image fallback preserves video only. Phone microphone access needs HTTPS or another supported secure context. Nothing is recorded.",
      "video": null
    },
    "computers": {
      "title": "Connected computers",
      "steps": [
        "Create a one-time connection code on one computer and enter it on the other.",
        "For computers you own, approve computer access explicitly on the target computer.",
        "For AI-only connections, share and authorize each provider separately.",
        "Choose Work on for the project computer, and choose an AI source in the existing provider selector."
      ],
      "troubleshooting": "AI-only connections do not grant files, screen or health readings. CPU and RAM appear only for authorized online computers. Disconnecting or revoking a grant stops affected access.",
      "video": null
    },
    "tools": {
      "title": "AI Tools",
      "steps": [
        "Install the coding agent on the computer where it will run, then use its own sign-in flow.",
        "Open Chats and use the intended project folder and permission mode.",
        "For personal Codex browser automation, choose Browser → Separate browser and confirm.",
        "To share supported AI, enable sharing and authorize the recipient in Connected computers."
      ],
      "troubleshooting": "Browser automation needs optional Playwright MCP support plus Chrome, Edge or Chromium. Shared sessions retain isolated workspace tools and never inherit the provider’s personal browser or MCP access.",
      "video": null
    },
    "security": {
      "title": "Security & Devices",
      "steps": [
        "Review logged-in devices and remove any you do not recognize.",
        "Approve a waiting login only when its code matches the other device.",
        "Use a one-time login QR to connect your own browser.",
        "Change the password or log out other devices when access needs to end."
      ],
      "troubleshooting": "A password login can wait for local approval. Use the computer’s local Admin page to recover access. Revoked devices cannot regain access by reconnecting their sockets.",
      "video": null
    },
    "connection": {
      "title": "Wi-Fi & Internet",
      "steps": [
        "For Wi-Fi access, put the phone and computer on the same reachable network.",
        "Open the Local connection address or scan a fresh login QR privately. Local remains available when Remote Access is enabled.",
        "Configure optional internet access from the computer’s Admin page.",
        "Keep the computer running; Pocket Dev does not wake sleeping hardware.",
        "Use the shared Local and Remote selector to copy or open the intended connection. Sharing an address does not grant a login.",
        "To pair computers, open Connected computers in local Admin or phone Settings. Select My computer only for a computer you own, then Show QR on one and Scan QR on the other. Choose QR photo when the browser cannot use its camera. Both sides must select My computer for computer access; otherwise the connection is AI-only."
      ],
      "troubleshooting": "Check the current address and private-network firewall rules. A Wi-Fi HTTP address supports live alerts, but browser push and phone microphone access require a supported secure context.",
      "video": null
    },
    "service": {
      "title": "Service & Updates",
      "steps": [
        "Configure Start at login from the computer’s local Admin page.",
        "Choose automatic update checks independently of update reminders.",
        "Open Settings → Service & Updates and choose which alerts you want. Sounds start off.",
        "Enable Notification sounds explicitly. A confirmed task outcome creates a temporary alert, not a notification inbox.",
        "Dismiss the toast or let it expire. Repeated delivery of the same event must not replay its sound.",
        "Browser push is a separate opt-in for supported browsers and secure connections; it needs the computer to stay online."
      ],
      "troubleshooting": "Supported terminal hosts preserve shells through a Pocket Dev service reload; a computer reboot still ends them. Save work and check running tasks first. Browser push requires permission, a supported secure context, and an awake, reachable computer. Real vendor delivery needs separate verification.",
      "video": null
    },
    "controls": {
      "title": "Computer controls",
      "steps": [
        "Select the authorized computer you want to inspect.",
        "Use Applications or Device health to inspect its actual supported capabilities.",
        "Open Screen or Camera only when you need a preview.",
        "Review a confirmation carefully before using power controls."
      ],
      "troubleshooting": "Capabilities depend on the computer and its permissions. Unsupported controls remain unavailable, and closing a preview releases its active resources.",
      "video": null
    },
    "setup": {
      "title": "Pocket Dev setup",
      "steps": [
        "Run pocket-dev start on your own computer.",
        "Open its local Admin page and follow the setup and permission guidance.",
        "Install optional AI tools and sign in through their own login flows.",
        "Connect your phone on Wi-Fi and verify the features you intend to use before leaving the computer."
      ],
      "troubleshooting": "Use pocket-dev setup --check or pocket-dev doctor for diagnostics. Keep the existing config and state directories when updating. A missing optional agent does not prevent basic Pocket Dev use.",
      "video": null
    },
    "chat": {
      "title": "AI Chat",
      "steps": [
        "Select the project computer, open Chats and choose a Claude Code or Codex conversation. An already-open conversation can read along before you send.",
        "Send a message to continue here. Respect an active writer and review approvals before allowing an action.",
        "Choose a compatible provider or model in the existing chat controls. Context is passed to the next engine; native tools can differ.",
        "Open Chat settings → Continue on computer to return to the computer. Personal Codex Browser → Separate browser requires explicit consent."
      ],
      "troubleshooting": "Use the provider’s own sign-in on the computer running it. Keep the host awake. Usage limits come from the provider; a reset time appears only when the provider supplies one. Antigravity and Copilot remain experimental.",
      "video": null
    },
    "notifications": {
      "title": "Smart Notifications",
      "steps": [
        "Open Settings → Service & Updates and choose which alerts you want. Sounds start off.",
        "Enable Notification sounds explicitly. A confirmed task outcome creates a temporary alert, not a notification inbox.",
        "Dismiss the toast or let it expire. Repeated delivery of the same event must not replay its sound.",
        "Browser push is a separate opt-in for supported browsers and secure connections; it needs the computer to stay online."
      ],
      "troubleshooting": "For an audible alert, interact with the page and check browser/system sound settings. Background push depends on browser and vendor support. A GIF demonstrates the toast but cannot demonstrate sound.",
      "video": null
    },
    "developer-tools": {
      "title": "Developer Tools",
      "steps": [
        "Choose the project computer and open a terminal in its project folder.",
        "Use Files for uploads, downloads, previews and folder ZIPs within your authorized roots.",
        "Use Git for status, saved-file diffs, Git Graph and supported repository actions.",
        "Open a development port only for the intended task, then close it when finished."
      ],
      "troubleshooting": "Git needs Git installed; native terminals need working PTY support. File and project permissions still apply. Only forward a service you intend to expose.",
      "video": null
    }
  });
  // END GENERATED FEATURE GUIDES
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  let dialog, active, previousFocus, overlay;
  function hide() { if (!dialog?.open) return; active = null; dialog.close(); previousFocus?.focus?.({ preventScroll: true }); }
  function close() { if (overlay) overlay.close('feature-guide'); else if (history.state?.pdFeatureGuide) history.back(); else hide(); }
  function render(id) {
    const definition = definitions[id]; if (!definition) return;
    if (!dialog) {
      dialog = make('dialog', 'pd-guide'); dialog.setAttribute('aria-labelledby', 'featureGuideTitle'); document.body.append(dialog);
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    }
    const head = make('header'), title = make('h2', '', `How to use ${definition.title}`); title.id = 'featureGuideTitle';
    const dismiss = make('button', '', 'Close'); dismiss.type = 'button'; dismiss.onclick = close; head.append(title, dismiss);
    const steps = make('ol'); for (const step of definition.steps) steps.append(make('li', '', step));
    dialog.replaceChildren(head, steps, make('h3', '', 'Not working?'), make('p', '', definition.troubleshooting));
    if (definition.video) {
      const tutorial = make('a', 'pd-guide-video', 'Watch tutorial');
      tutorial.href = definition.video; tutorial.target = '_blank'; tutorial.rel = 'noopener noreferrer';
      dialog.append(tutorial);
    }
    active = id; if (!dialog.open) dialog.showModal(); dismiss.focus();
  }
  function open(id) {
    if (!Object.hasOwn(definitions, id)) return;
    if (dialog?.open) return render(id);
    previousFocus = document.activeElement; overlay = window.pocketDev?.overlays;
    render(id);
    if (overlay) overlay.open('feature-guide', hide);
    else history.pushState({ ...history.state, pdFeatureGuide: id }, '', location.href);
  }
  window.addEventListener('popstate', (event) => { if (!overlay) { if (Object.hasOwn(definitions, event.state?.pdFeatureGuide || '')) render(event.state.pdFeatureGuide); else hide(); } });
  window.PocketGuides = { definitions, open, close, button(id) { const button = make('button', 'pd-guide-button', '?'); button.type = 'button'; button.setAttribute('aria-label', `Help with ${definitions[id]?.title || id}`); button.onclick = () => open(id); return button; } };
})();
