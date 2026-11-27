# Start with Pocket Dev

For developers and small startup teams. Run Pocket on the computer you want to access. Your phone needs only a supported browser.

## 1. Install

Check `node -v`. Install [Node.js 22+](https://nodejs.org/) if needed. Then run:

```bash
npm install -g @anisirji/pocket-dev
pocket-dev start
```

[Windows](windows.md) · [macOS](macos.md) · [Linux](linux.md) · [Beginner guide](INSTALL_BEGINNERS.md).

## 2. Configure

Follow guided setup; approve only desired tools and permissions. Keep remote access off unless needed. Version 3 adds graphical Admin setup; CLI `pocket-dev setup` remains available.

## 3. Connect

Keep the computer awake and online. Scan the one-time QR code on the same network, or open the displayed address and authenticate. Allow trusted private-network firewall access if prompted. Use `pocket-dev qr` for a fresh code.

## 4. Work

**Chats:** continue an AI conversation. **Connected Computers:** pair a computer, grant specific access and choose the AI source. **Workspace:** open a project once and use editor, files, chat, terminal and Git together.

[Explore features](FEATURES.md) · [Sharing and limits](UNIFIED_CONNECTIONS.md) · [Remote access](GUIDE.md#use-it-away-from-home) · [Troubleshooting](GUIDE.md#troubleshooting). Run `pocket-dev doctor` for diagnostics; use `pocket-dev update` or Admin for updates.

## Test the Version 3 preview

Version **3.0.0** is implemented in source but is not approved for npm publication or a public release. The install command above installs the currently published package. Do not infer that it includes the preview.

For a deliberate source test, use a separate checkout on the computer you intend to test:

```sh
git clone https://github.com/anisirji/pocket-dev.git pocket-dev-preview
cd pocket-dev-preview
npm ci
node bin/pocket-dev.js version
node bin/pocket-dev.js start
```

Inspect any existing server first. Do not start a competing copy on the same ports or replace an installed service while work is active. Preserve the existing config and state. Run only the manual checks you intend to authorize, and keep sign-ins and system permission dialogs under your control.

The documentation visuals use the real application with disposable sample data. They do not certify every device or provider. Read the [verification matrix](FEATURE_VERIFICATION.md) before approving a release.
