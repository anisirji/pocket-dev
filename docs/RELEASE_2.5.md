# Pocket Dev 2.5.0

Workspace now combines an activity bar, file explorer, CodeMirror editor, right-side AI conversations and bottom terminals. Each panel collapses and resizes independently; focus layouts and separate Files, Editor, AI and Terminal views keep the interface usable on desktop and phones. Dark is the default, with light and system themes available in Workspace settings.

One authorized project directory supplies the context for new chats, file search and terminals. Switching projects restores their separate editor drafts, tabs, cursor/scroll positions, expanded folders, conversations, terminal selections and layout. Existing processes continue on their host when panels are hidden. Optional auto-save remains off by default.

The shared folder picker uses compact navigation, one location selector, searchable folder rows and a three-dot menu for secondary actions. Recent projects are isolated per workspace computer and validated before reopening. Desktop uses a spacious dialog; phones use a full-screen selector with a fixed action button.

Browser snapshots use IndexedDB with login, device and project isolation. Clean snapshots have a 32 MB budget and seven-day retention; unsaved drafts are protected from eviction. Credential filenames are excluded from persistent file snapshots and automatic preloading. Signing out clears saved workspace data. Previously authorized cached workspaces can recover while their computer is unreachable after the front-door login is validated; a live access refusal clears cached content.

The host sends bounded, sequenced filesystem notifications for the root, expanded directories and open-file parents. Clean files update in place; conflicting drafts stay intact with compare, reload and save-copy actions. Explicit offline saves retry with their original revision and never silently overwrite newer remote changes. Native filesystem notifications, request deduplication, bounded preloading and a virtualized file tree avoid recursive project scans and repeated full-page refreshes.

The existing connected-computer and shared-AI boundaries remain in place. AI-only sharing does not grant filesystem, terminal or computer access. Concurrent file feeds share a per-login resource limit and close when access is revoked.

## Validation scope

- Complete macOS test suite and Chrome browser workflows covering the editor, real PTYs, chat streaming with a fixture CLI, project isolation, draft recovery, offline saves, cached startup, conflicts, file changes, native renames/deletions and cache clearing.
- Responsive checks across 14 phone, landscape, tablet and desktop viewports; light and dark theme inheritance; a 2,100-file directory with bounded rendering.
- Windows CI covers the updater, connections, AI isolation, workspace scheduling/cache state, shared folder picker and native filesystem notifications. This release does not claim a physical Windows or Safari UI run.
- Linux runtime and physical public-internet routing remain outside this release's validation scope.

Rebuild the bundled editor with `npm run build:editor`. Restart Pocket Dev and refresh after updating to load the new backend routes. Existing shared-provider compatibility and platform restrictions are documented in [the connection and sharing guide](UNIFIED_CONNECTIONS.md).
