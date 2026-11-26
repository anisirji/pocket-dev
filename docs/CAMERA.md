# Device camera

New global installs and upgrades of Pocket Dev automatically prepare camera support, reusing a working FFmpeg when one is already installed. Open **Settings → Device camera** on your phone. Pocket Dev checks whether camera support is ready. If automatic setup could not finish, tap **Install camera support** to retry. When setup finishes, choose a connected camera and tap **Start camera**. The preview comes from the computer you are controlling. The phone's camera is not used.

While the preview is live, tap **Snapshot** to download the current image as a timestamped JPEG to the device you are viewing from. The preview keeps running. Snapshot is available after the first image arrives and is disabled when the camera stops. Your browser handles the download; on a phone you can find it in Downloads.

**Install camera support** downloads a private FFmpeg helper into Pocket Dev's state folder, under `tools/camera/`. No terminal commands, PATH changes, package manager, administrator access, or Pocket Dev restart are needed. The view shows progress, refreshes the camera list when ready, and offers **Retry installation** if setup fails. Closing the view does not cancel installation; reopening shows its current status. Starting the camera remains a separate action.

Pocket Dev reuses a working FFmpeg from your computer instead of downloading another copy. It checks for the platform's [camera input](https://ffmpeg.org/ffmpeg-devices.html), not just the presence of an executable. For a custom install location, `POCKET_DEV_FFMPEG` can point to an existing executable. The private helper is found again after a restart or Pocket Dev update.

Automatic setup supports Windows x64, macOS Intel and Apple Silicon, and Linux x64, ia32, ARM and ARM64. Other architectures can use a compatible existing FFmpeg, but do not show an install button. The helper comes from a fixed [ffmpeg-static release](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1). Pocket Dev verifies its SHA-256 digest before running it, checks that it supports cameras, and keeps the build's license and source details beside it. Downloads happen during global installation or when you tap the install button, and need internet access on the computer. Several clicks share one installation. Failed downloads are removed and can be retried.

Automatic camera setup never fails the Pocket Dev install. It is skipped for local installs, `npx`, CI, `--ignore-scripts`, an existing `cameraView: false` setting, or `POCKET_DEV_NO_CAMERA_INSTALL=1`. The camera view retains its install button when the helper is missing. Installing the helper does not activate the camera or request camera permission.

When you first start a preview, the computer may ask for camera permission. Allow it on the computer:

- **macOS:** System Settings → Privacy & Security → Camera. Allow the program that runs Pocket Dev, such as Terminal or your service host. Restart that program if macOS asks.
- **Windows:** Settings → Privacy & security → Camera. Allow camera access and access for desktop apps. Run Pocket Dev as your signed-in user.
- **Linux:** Your user needs access to the selected `/dev/videoN` device. Close other camera apps if the device is busy.

Tap **Stop**, **Close**, or go back to end your preview. Hiding the page stops it too; returning requires another tap on **Start camera**. If the phone disconnects without sending Stop, its session expires after 15 seconds. The capture process stops when the last viewer leaves. Several viewers can share the same camera; a different camera can be selected after those previews stop.

The preview is video only, up to 640 pixels wide at about five images per second. Preview images stay in memory on the computer; only snapshots you explicitly download are saved on the viewing device. A physical camera light remains under the operating system's control. Keep using Pocket Dev's existing secure connection for access over the internet.

Camera access and installing camera support require a logged-in device. Project collaborators cannot use either. On a room device, starting a camera or installing support follows that device's permission mode: Read-only refuses it, Plan proposes it, and Ask or Auto requests approval. Stopping your own preview always works. Frames and Stop requests are tied to the device that started the preview.

To disable camera access on the computer, run:

```sh
pocket-dev config set cameraView false
```

This applies without restarting and ends active capture within a second. Re-enable it with `pocket-dev config set cameraView true`.

If no cameras are listed, reconnect the camera and reopen the view. If a preview fails, check camera permission on the computer, close other apps using the camera, and try again. A disconnected or stalled camera stops the preview with an error.
