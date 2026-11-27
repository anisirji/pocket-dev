# Pocket Dev 3.0.1

- Pair computers with Show QR and Scan QR from local PC/Mac Admin or the phone's existing Settings. A phone scans for the computer whose Settings it has open.
- Select My computer on both sides to grant computer access. Other connections remain AI-only, subject to existing provider sharing permissions.
- Choose a QR photo or screenshot when browser camera access is unavailable. Manual connection details stay available in an expandable section, with full-width fields.
- Showing QR codes on both computers no longer blocks pairing when neither has other connections. Invalid attempts retain the previous state and identity; existing populated networks are protected.
- Stop the scanner and polling on Back, Close or a hidden page, including during camera startup. Expired QR codes disappear without automatically creating another invitation.

Validated with the full macOS suite (989 passed, three platform-specific skips, zero failures), 26 Chrome browser scripts, and native Windows Edge pairing and Settings checks at phone and desktop sizes. Final manual stability approval, Safari and physical-phone/webcam checks remain pending. [Detailed validation](QR_PAIRING_UI_VALIDATION.md).

No new dependencies or services. Existing platform limitations, provider grants and local Admin access protections remain in effect. Local Admin normally uses http://localhost:7778; phones use the main connection and Settings.
