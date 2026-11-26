# Pocket Dev 2.2.0

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
