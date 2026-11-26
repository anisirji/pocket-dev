# Device camera

Prepare the camera once before leaving the computer: open **Pocket Dev Admin → This computer → Remote camera → Prepare remote camera**. Allow camera access in the computer browser and choose a persistent permission when available. Setup checks one image, saves a verification timestamp, then stops capture. Admin shows **Camera verified** after a successful check.

After setup, use **Settings → Device camera → Start camera** on your phone from wherever Pocket Dev is reachable. Pocket Dev opens or reuses the computer camera tab automatically; nobody needs to open it manually or approve each preview. The computer browser captures the video and Pocket Dev relays it to the logged-in phone. The computer must be awake, signed in and online. Browser permissions that are temporary, revoked or reset can require setup again.

This uses the same browser camera API on Windows, macOS and Linux. Chrome, Edge, Firefox or Safari must support `getUserMedia` and have permission to use the camera. The capture page runs on the computer's localhost address, so your phone can keep using its existing Pocket Dev address, including Wi-Fi HTTP. No FFmpeg download or extra camera installation is required by default.

**Stop** on the phone, **Close**, back, or hiding the phone page ends that preview. **Stop camera** in the computer tab stops all viewers. Closing the computer tab or stopping Pocket Dev releases the browser camera. If the tab was closed, the next **Start camera** on the phone reopens it automatically using the browser's existing permission. An open, connected tab is reused.

The first preview uses the computer's default camera. After camera permission is granted, camera names become available in the phone selector. Stop the preview before choosing a different camera. Several devices can view the same camera; previews of another camera wait until existing viewers stop.

**Snapshot** downloads the current preview image as a timestamped JPEG to the viewing device while the live preview keeps running. It is enabled after the first image arrives and disabled when capture stops. The browser handles the download; on a phone look in Downloads.

Only video is requested. The browser negotiates continuous WebRTC video, targeting 24 frames per second at up to 1280 × 720. Actual resolution and frame rate depend on the camera, browser and connection. If a direct connection cannot be established, Pocket Dev automatically pushes JPEG previews through its existing authenticated connection, up to 640 pixels wide at 15 frames per second. Slow connections skip frames instead of building a stale image queue. Neither path waits for an HTTP request per frame.

Video and preview images stay in memory. No video or snapshots are saved on the host computer. Snapshot saves the current video frame or fallback image to the viewing device. A dropped phone session expires after 15 seconds without keepalives. The first preview waits up to 25 seconds for browser permission; if permission is granted after it times out, tap Start camera again.

During camera access, WebRTC uses Cloudflare's public STUN service (`stun:stun.cloudflare.com:3478`) to discover a network route between browsers. STUN does not carry the video. Networks that block direct video use the authenticated JPEG fallback; no TURN subscription is required. Advanced deployments can set `cameraIceServers` in `config.json` to a browser-compatible ICE server array, including their own TURN service, or `[]` to disable public STUN discovery. This applies to new previews.

Camera access requires a logged-in device. Project collaborators cannot use it. Starting capture follows room permission modes: Read-only refuses, Plan proposes, Ask and Auto request approval, and Bypass allows. Frames and Stop requests belong to the device that started its preview. The capture tab is restricted to direct loopback connections and a private session token; room peers and internet connections cannot act as the computer camera source.

If camera access is blocked, allow it in the computer browser's site settings for the localhost camera page. The operating system may also need permission for that browser:

- **Windows:** Settings → Privacy & security → Camera. Allow camera access for desktop apps.
- **macOS:** System Settings → Privacy & Security → Camera. Allow the browser used for the camera tab.
- **Linux:** The browser needs access to the connected video device and a signed-in desktop session.

If another app is using the camera, close that app and retry from the phone. A camera tab that was closed is reopened by the next Start camera request. If no browser opens, check the computer's default browser and desktop session.

Disable camera access with `pocket-dev config set cameraView false`; active previews stop without restarting Pocket Dev.

## Legacy FFmpeg capture

The original FFmpeg backend remains available with `pocket-dev config set cameraBackend ffmpeg`, followed by a Pocket Dev restart. Its existing helper detection, private verified download and Install camera support button remain available. Global installs prepare FFmpeg only when this backend is explicitly selected. CI, local installs, `npx`, `--ignore-scripts`, `cameraView: false` and `POCKET_DEV_NO_CAMERA_INSTALL=1` skip that download.

Return to browser capture with `pocket-dev config set cameraBackend browser`, then restart Pocket Dev. This is the default for new installs. On macOS, browser capture avoids the background Node service's missing camera entitlement; the user still grants the browser normal camera permission.
