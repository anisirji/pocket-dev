# Feature documentation standard

`docs/feature-catalog.json` is the canonical product-facing inventory. The three hero features are **AI Chat**, **AI Sharing** and **Workspace**. Preserve stable feature IDs across documentation, website and application help.

## One source, generated surfaces

Run from the Pocket Dev repository:

```sh
node scripts/render-feature-docs.mjs
node scripts/render-feature-docs.mjs --check
node scripts/check-feature-docs.mjs
```

The generator updates README, FEATURES, the verification matrix, both agent-readable overviews, the existing help definitions, the local showcase and the GitHub Pages fallback. It has no network request or publishing action. `--check` fails on stale output without writing it.

The official website is the existing `anisirji/portfolio` Vercel project. Synchronize its generated catalogue and byte-identical media explicitly, without adding a runtime service:

```sh
node scripts/render-feature-docs.mjs --website-root=/path/to/portfolio/site
node scripts/render-feature-docs.mjs --check --website-root=/path/to/portfolio/site
```

The website component imports the local generated JSON. Its existing help/docs routes and copyable AI prompts use the same catalogue. Do not create another product site or change DNS. `site/` in this repository is the GitHub Pages fallback, not the official domain.

## Entries and instructions

Each entry contains `id`, canonical name, headline, description, group, guide, details, help key, written instructions, troubleshooting, visual/alt text, media provenance and verification status. Existing help keys retain familiar application labels. Update the catalogue, then regenerate; do not maintain a second copy of feature instructions in the UI.

`agentPrompts` supplies the official website's setup/project prompts. The reusable agent skill and AI setup guide retain access boundaries, account consent, source-preview/published-package distinction and platform caveats.

## Actual UI, honest evidence

Use real application captures on disposable servers and projects. Never include credentials, login QR codes, connection tokens, private files or conversations. Record the exact assertions and qualifications in `docs/media/v3/capture-manifest.json`, including hashes and byte sizes. Generated camera/audio and inert desktop input must be labelled explicitly. A screenshot demonstrates the UI; a GIF cannot prove audible quality, subscription entitlement or physical hardware stability.

Prefer 1280×800 PNG screenshots and short, silent GIFs. Keep each asset below 1.5 MB, use descriptive alt text and intrinsic dimensions, lazy-load lower images and respect reduced-motion preferences. Preserve historical media, release notes and validation records.

## Tutorials and release state

`video: null` omits tutorial links and placeholders. Set it only to an actual, checked YouTube video URL for that feature. Do not substitute a channel or an invented video. Verify the video, content, version and permissions before regenerating.

Keep **3.0.0** unchanged. Implementation is complete; final manual stability testing and owner release approval are pending. Preserve the distinction among implemented, demonstrated, manually verified and published. Website/documentation changes do not authorize an npm publication, GitHub release or a claim that every CI/platform check passed.
