# Device camera

Prepare the camera once before leaving the computer: open **Pocket Dev Admin → This computer → Remote camera → Prepare remote camera**. Allow camera access in the computer browser and choose a persistent permission when available. Setup checks one image, saves a verification timestamp, then stops capture. Admin shows **Camera verified** after a successful check.

After setup, use **Settings → Device camera → Start camera** on your phone from wherever Pocket Dev is reachable. Pocket Dev opens or reuses the computer camera tab automatically; nobody needs to open it manually or approve each preview. The computer browser captures the video and Pocket Dev relays it to the logged-in phone. The computer must be awake, signed in and online. Browser permissions that are temporary, revoked or reset can require setup again.

This uses the same browser camera API on Windows, macOS and Linux. Chrome, Edge, Firefox or Safari must support `getUserMedia` and have permission to use the camera. The capture page runs on the computer's localhost address, so your phone can keep using its existing Pocket Dev address, including Wi-Fi HTTP. No FFmpeg download or extra camera installation is required by default.

Camera launches request background behavior automatically on every platform, with no extra setting. macOS uses its non-activating launcher; Windows requests a window without activation; Linux omits inherited activation tokens and supplies a background startup timestamp. An existing connected capture tab is reused. Browser preferences and desktop focus policies can still select a new tab or show a window, so background launch is best effort. First-time permission prompts, system camera/microphone indicators and the capture tab's Stop controls remain available.

**Stop** on the phone, **Close**, back, or hiding the phone page ends that preview. **Stop camera** in the computer tab stops all viewers. Closing the computer tab or stopping Pocket Dev releases the browser camera. If the tab was closed, the next **Start camera** on the phone reopens it automatically using the browser's existing permission. An open, connected tab is reused.

The first preview uses the computer's default camera. After camera permission is granted, camera names become available in the phone selector. Stop the preview before choosing a different camera. Several devices can view the same camera; previews of another camera wait until existing viewers stop.

**Snapshot** downloads the current preview image as a timestamped JPEG to the viewing device while the live preview keeps running. It is enabled after the first image arrives and disabled when capture stops. The browser handles the download; on a phone look in Downloads.

Camera and microphone requests are separate. Camera setup and a normal video preview request no microphone access. The browser negotiates continuous WebRTC video, targeting 24 frames per second at up to 1280 × 720. Actual resolution and frame rate depend on the camera, browser and connection. If a direct connection cannot be established, Pocket Dev automatically pushes JPEG previews through its existing authenticated connection, up to 640 pixels wide at 15 frames per second. Slow connections skip frames instead of building a stale image queue. Neither path waits for an HTTP request per frame.

**Prepare microphone once** in the same local Admin panel verifies microphone permission without taking a camera image. Choose persistent browser permissions when offered. Camera and microphone approval belongs to this computer's localhost capture origin, covering all authorized remote connections rather than individual phone sessions. Browser or operating-system revocation can still require permission again.

Admin → This computer → Permissions provides independent **Camera** and **Microphone & audio** switches. Disabling one stops affected active streams, closes their direct WebRTC peers, and blocks new starts and relay access. Audio-only sessions can continue when only video is disabled. Reenabling permits a fresh session and never revives an old lease. These switches are available only in local Admin; a remote connection cannot use the permissions API to turn itself back on.

## Camera and audio controls

With the default browser backend, **Camera** and **Listen** are independent. Listen is off when the interface opens. Enabling it asks the computer browser for its microphone permission separately from the camera. Allow that permission on the computer when prompted. Turn Camera off to use an audio-only connection. Changing either control restarts your preview with the selected media; other authorized viewers can continue using the shared camera. The host indicator reports whether its camera and microphone are actually on.

**Hold to speak** requests the phone microphone only when pressed. Allow permission, then hold again if the permission dialog interrupted the press. Audio is transmitted only while held; release, pointer cancellation, lost focus, connection loss and leaving the view mute and stop its track. A permission result arriving after release does not start transmission. Echo cancellation and noise suppression are requested where supported. Closing the interface releases all owned microphone tracks.

Phone microphone access requires HTTPS or another browser-supported secure context. A Wi-Fi HTTP address can still receive video and computer audio. If autoplay is blocked, use **Play computer audio** on the phone or **Enable speaker playback** in the computer capture tab. **Stop camera & audio** on the computer stops all viewers immediately.

On a local HTTP address, the camera page explains the restriction and offers **Use secure connection**. This explicitly switches through the existing one-use login handoff to Pocket Dev's HTTPS address and reopens Camera on the selected computer. It stays on HTTPS instead of returning to the Wi-Fi address. Remote Access must already be available; this action does not enable it or change any Admin permission. If the first microphone permission prompt interrupts a hold, the message says **Microphone allowed. Hold to speak again.** No sound is transmitted after release while permission is pending.

Audio uses the existing authenticated WebRTC signaling. It is not sent through the JPEG relay. When a direct connection fails, video can retain its image fallback while audio stops. The legacy FFmpeg backend remains video-only. No audio or video is recorded automatically.

Video and preview images stay in memory. No video or snapshots are saved on the host computer. Snapshot saves the current video frame or fallback image to the viewing device. A dropped phone session expires after 15 seconds without keepalives. The first preview waits up to 25 seconds for browser permission; if permission is granted after it times out, tap Start camera again.

During camera access, WebRTC uses Cloudflare's public STUN service (`stun:stun.cloudflare.com:3478`) to discover a network route between browsers. STUN does not carry the video. Networks that block direct video use the authenticated JPEG fallback; no TURN subscription is required. Advanced deployments can set `cameraIceServers` in `config.json` to a browser-compatible ICE server array, including their own TURN service, or `[]` to disable public STUN discovery. This applies to new previews.

Camera access requires an active login or explicitly granted computer access. Project collaborators cannot use it. Frames and Stop requests belong to the connection that started its preview. Revoked logins or computer access end their media sessions. The capture tab is restricted to direct loopback connections and a private session token; room peers and internet connections cannot act as the computer camera source.

If camera access is blocked, allow it in the computer browser's site settings for the localhost camera page. The operating system may also need permission for that browser:

- **Windows:** Settings → Privacy & security → Camera. Allow camera access for desktop apps.
- **macOS:** System Settings → Privacy & Security → Camera. Allow the browser used for the camera tab.
- **Linux:** The browser needs access to the connected video device and a signed-in desktop session.

If another app is using the camera, close that app and retry from the phone. A camera tab that was closed is reopened by the next Start camera request. If no browser opens, check the computer's default browser and desktop session.

Disable camera access with `pocket-dev config set cameraView false`; active previews stop without restarting Pocket Dev.

## Legacy FFmpeg capture

The original FFmpeg backend remains available with `pocket-dev config set cameraBackend ffmpeg`, followed by a Pocket Dev restart. Its existing helper detection, private verified download and Install camera support button remain available. Global installs prepare FFmpeg only when this backend is explicitly selected. CI, local installs, `npx`, `--ignore-scripts`, `cameraView: false` and `POCKET_DEV_NO_CAMERA_INSTALL=1` skip that download.

Return to browser capture with `pocket-dev config set cameraBackend browser`, then restart Pocket Dev. This is the default for new installs. On macOS, browser capture avoids the background Node service's missing camera entitlement; the user still grants the browser normal camera permission.
