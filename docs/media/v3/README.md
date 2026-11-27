# Pocket Dev 3 demonstration assets

These PNG screenshots and short, silent GIFs show the actual application UI, captured on disposable local servers with a generated project. They replace the illustrative SVG workflows in the current presentation. Historical assets and release records are retained.

No owner project, conversation, camera, desktop capture, password, connection token or login QR is used. The connectivity demonstration shows **share-address** QR codes only. Password fields stay blank. AI output is a scripted protocol fixture, not a new model evaluation or provider account test.

Screen control uses a captured demo Workspace image and an inert input adapter. Camera/audio use generated browser tracks through the actual WebRTC pipeline. Those assets demonstrate the UI and stated assertions without recording private hardware. Notifications count a real sound-synthesis request with browser output muted; GIFs have no audio.

The [capture manifest](capture-manifest.json) records the exact checks, source qualifications, byte sizes and SHA-256 hashes. Final manual stability remains pending for every feature. See the [verification matrix](../../FEATURE_VERIFICATION.md).

## Reproduce

From the repository, using its existing development browser tooling, installed Chrome and an already installed FFmpeg:

```sh
node tools/capture-v3-media.mjs
node scripts/render-feature-docs.mjs
node scripts/render-feature-docs.mjs --check
```

Use `--only=workspace,developer-tools` for selected captures. A screen demo needs the Workspace image first. The tool uses isolated homes, ports, browser profiles, native-command stubs and scripted providers. It does not enable real OS permissions, install tools, send vendor push or open a public tunnel. Missing capture tooling should be reported; it must not be silently installed.

Do not add a feature tutorial until its actual video exists and has been checked. `video: null` produces no tutorial link or placeholder. The older demo GIF remains in `docs/media/pocket-dev-demo.gif` as a historical artifact; it is not a Version 3 verification claim.
