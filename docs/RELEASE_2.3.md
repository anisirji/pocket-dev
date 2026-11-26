# Pocket Dev 2.3.0

Open **More → Workspace → Open folder** for a project editor around Pocket Dev's existing file access, terminals and coding assistants.

- **Explorer:** browse project folders, search filenames, create files and folders, upload files and show hidden entries.
- **Editor:** open files in tabs with local CodeMirror syntax highlighting, line numbers, undo, search and Ctrl/Cmd+S. UTF-8 text files up to 1 MB can be edited. Existing UTF-8 BOM and Windows CRLF line endings are preserved. Supported image and PDF files have previews; other binary or oversized files can be downloaded.
- **Save conflicts:** saves use a content revision and an atomic file replacement. If another app or coding agent changed the file, Save keeps the editor draft and refuses to overwrite the newer content. Existing file modes are retained, and concurrent saves of the same revision cannot both succeed.
- **Project tools:** Terminal, Codex and Claude controls open or reuse terminal sessions in the selected project folder. Codex and Claude use their installed commands. Chats opens the existing Pocket Dev chat interface. Switching panels or leaving Workspace keeps sessions running.
- **Responsive layout:** desktop explorer/editor/terminal panels resize by dragging or keyboard. Phones switch between Files, Editor and Terminal & AI. Folder selection, open files and layout restore on reload; unsaved edits prompt before leaving.
- **Access controls:** the workspace requires an owner/Admin login and uses the existing allowed file roots. The text APIs reject invalid UTF-8, binary data, oversized files and escaping paths. File creation refuses to overwrite an existing file.
- **Windows updater:** updating a standalone copy no longer stops an unrelated service runner. Dedicated Windows CI and native PowerShell runtime tests cover quoted paths, successful installation, failure retries, exit codes and external updater handoff.

Workspace was checked against a real Windows PC with PowerShell, as well as browser tests on macOS and narrow phone layouts. The Windows PC upgraded from 2.1.2 to 2.2.1 through the external update helper on the first attempt, resolving its npm EBUSY/-4082 folder lock. Codex and Claude launch-control tests use harmless fixture commands; they do not invoke paid model requests.

The editor and language support are bundled locally. Opening Workspace requires no VS Code server installation or runtime CDN download. Workspace is an editor interface for Pocket Dev's existing tools; VS Code's extension system and debugger are not included.

On Windows, installations older than 2.1.4 need their first upgrade to run from a separate PowerShell window after Pocket Dev stops. Once upgraded, the external updater handles stopping, installing and restarting. See [Windows update instructions](windows.md#7-update-and-uninstall).

[Workspace guide](GUIDE.md#project-workspace) · [Camera setup](CAMERA.md)
