# Pocket Dev 2.2.1

Fixes camera access from background services and replaces the slow image-polling feed with continuous browser video.

- **Browser camera capture:** Windows, macOS and Linux use the computer browser's camera permission. The default installation needs no FFmpeg helper. The legacy FFmpeg backend remains available with `cameraBackend: "ffmpeg"`.
- **Faster live feed:** WebRTC targets 24 FPS, with an automatic pushed-image fallback targeting 15 FPS when direct video cannot connect. Slow connections skip stale frames. A real Mac camera measured 23.9 FPS through Pocket Dev's internet address during validation; results vary by device and network.
- **Remote start after one-time setup:** Admin → This computer → Remote camera → Prepare remote camera verifies browser permission and stops capture. Subsequent phone requests open or reuse the computer camera tab automatically.
- **Snapshots and controls:** JPEG snapshots work during either stream mode. Stop, Close, leaving the phone page, session expiry and computer-side Stop release the viewer or camera as appropriate. The camera header and Close button stay clear of the phone status strip.
- **Access checks:** Viewer streams remain authenticated and owned by the device that starts them. The computer source requires direct loopback access and a private token. Browser and operating-system camera permissions and privacy indicators remain in effect.

Validation covers the full automated test suite, actual-browser video and fallback frame rates, snapshots, reconnects, session lifetimes, permission failures and source authentication. Physical Windows and Linux camera validation is still pending.

[Camera setup](CAMERA.md) · [Setup guide](SETUP.md)

## Pocket Dev 2.2.0

Control your computer's camera from the phone browser, with automatic camera helper setup during global installation.

- **Live preview:** Settings → Device camera lists connected cameras. Choose one and tap Start camera. The video-only preview is up to 640 pixels wide at approximately five frames per second.
- **Snapshots:** Snapshot downloads the current frame as a timestamped JPEG to the device viewing the camera. Preview continues while the image downloads.
- **Automatic setup:** Global installs and upgrades check for a working FFmpeg and reuse it. When missing, Pocket Dev downloads a private helper, verifies its SHA-256 checksum, and checks camera support before using it. No administrator access, package manager, PATH changes, or extra terminal commands are required.
- **Recoverable setup:** A failed helper download does not fail Pocket Dev installation. Settings → Device camera provides an Install camera support button, progress and retry. The helper survives Pocket Dev updates.
- **Session controls:** Stop, Close, back, or hiding the page releases the viewer's camera session. Disconnected sessions expire after 15 seconds; capture stops when the last viewer leaves. No audio is captured and no images are saved on the host computer.
- **Access controls:** Login is required. Project collaborators cannot access cameras or install camera support. Room permission modes apply to starting capture and installing its helper. Frames and Stop requests belong to the device that started the preview.

Automatic helper setup supports Windows x64, macOS Intel and Apple Silicon, and Linux x64, ia32, ARM and ARM64. Camera capture uses DirectShow, AVFoundation or Video4Linux2. Camera permission is still granted through the host operating system when needed.

`POCKET_DEV_NO_CAMERA_INSTALL=1`, CI, local installs, `npx`, `--ignore-scripts`, or an existing `cameraView: false` setting skip automatic helper installation. `pocket-dev config set cameraView false` disables camera access and helper installation from the phone.

Validation includes automated camera/session/access tests, installer reuse and failure tests, npm hook and package-content checks, browser checks for preview and snapshot downloads, and a real helper download in an isolated temporary folder. Physical camera testing on Windows and Linux is still pending.

This release also includes the Windows self-update fix from the local 2.1.4 changes: updating stops Pocket Dev before npm replaces its files, then starts it again.

[Camera setup](CAMERA.md) · [Setup guide](SETUP.md)
