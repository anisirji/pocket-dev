# Version 3 feature verification

**Implementation:** complete. **Final manual stability testing:** pending. **npm publication:** authorized by the owner. **Public GitHub release:** not requested.

This presentation refresh captures the actual shipping UI with isolated sample data. Screenshots and GIFs are evidence of the stated UI checks, not proof that every device, account or network is supported. Historical test results remain in [VALIDATION.md](VALIDATION.md); existing [release notes](RELEASE_3.0.md) are preserved.

| Feature | Implemented | Demonstration scope | Final manual stability |
| --- | --- | --- | --- |
| [AI Chat](FEATURES.md#ai-chat) | Yes | Real conversation UI with scripted agent responses. The capture checks the continuation action; native account handoff still needs manual testing. | Pending |
| [AI Sharing](FEATURES.md#ai-sharing) | Yes | Two disposable servers on one Mac exercise pairing, provider grants and AI-only access boundaries. Physical cross-computer use and provider account permissions need manual testing. | Pending |
| [Workspace](FEATURES.md#workspace) | Yes | Actual editor saves, terminal output and Git Graph in a scratch repository. No private project is used. | Pending |
| [Smart Notifications](FEATURES.md#smart-notifications) | Yes | One toast and one sound-synthesis request verified for a repeated event ID. Output was muted; no external vendor push was sent. | Pending |
| [Remote Screen & Control](FEATURES.md#remote-screen--control) | Yes | Real control UI, approval and revocation, with a demo Workspace image and inert input adapter. No owner desktop pixels or OS input are captured. | Pending |
| [Camera & Audio](FEATURES.md#camera--audio) | Yes | Real WebRTC UI and packet flow with generated video/audio. No physical camera, private microphone recording or audible-quality claim. | Pending |
| [Developer Tools](FEATURES.md#developer-tools) | Yes | Real scratch files, PTY output, Git status and graph. No private project or external development port is exposed. | Pending |
| [Computer Management](FEATURES.md#computer-management) | Yes | Existing controls and health interface; platform-dependent readings stay available or unavailable as reported. No power action is executed. | Pending |
| [Connected & Self-hosted](FEATURES.md#connected--self-hosted) | Yes | Local/Remote share-address UI using an isolated tunnel fixture. No login QR, credential or real public tunnel is captured. | Pending |
| [Simple Setup & Help](FEATURES.md#simple-setup--help) | Yes | Actual graphical setup and existing contextual help. No installer, system permission dialog or password change is executed. | Pending |

## Before approving publication

1. Safari compatibility and a real phone on the intended network
2. Windows physical camera, microphone and audible speaker playback
3. Native screen capture/input permissions, multiple monitors and host Stop on each supported target
4. Real provider sign-in, conversation handoff and authorized cross-computer AI with the intended accounts
5. External tunnel connectivity and real vendor browser-push delivery
6. Power controls on the intended hardware after saving work

Review [current GitHub checks](https://github.com/anisirji/pocket-dev/actions) too. The earlier Windows hosted-runner ZIP test returned a file-root refusal even though the selected test passed on the owner’s Windows PC. Treat that runner discrepancy as unresolved until a fresh passing check establishes otherwise. Do not describe all CI as passing.

## Media and release boundaries

- Capture checks and SHA-256 hashes: [capture manifest](media/v3/capture-manifest.json).
- GIFs are silent. A sound-synthesis request or received RTP is not a human speech-quality test.
- Camera frames and desktop input use generated/inert sources in these new assets. No private desktop or camera is recorded.
- No real public tunnel, subscription transfer, vendor push delivery or destructive power action is demonstrated.
- Documentation and website generation never publishes a package. The registry README is updated with the owner-authorized package publication.
