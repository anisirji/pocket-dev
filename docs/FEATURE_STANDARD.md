# Feature documentation standard

- Maintain `docs/feature-catalog.json` as the canonical product-facing inventory. Preserve three core features: AI Chat, AI & Resource Sharing, Workspace. Each entry has an ID, name, headline, one-sentence description, guide, details, visual, alt text and optional video.
- Run `node scripts/render-feature-docs.mjs` from the repository to regenerate README, FEATURES, llms.txt and showcase. Keep website and in-app help aligned with the same IDs and wording; do not introduce a runtime service.
- Use actual, sanitized screenshots or short clips after manual verification. Until then mark diagrams illustrative. Do not fabricate tutorials; null means omit the video link. Keep existing demo and historical release notes.
- Separate implementation, validation and publication status. 3.0.0 is unpublished until the registry confirms it. Preserve actual validation record, platform caveats, provider terms, authorization, local-only default and privacy boundaries.
- Keep notification UX one-time sound/toast, no new notification inbox. Never infer full desktop-control or browser-tool support across platforms. Use explicit consent for sensitive capabilities.
- Use relative links within docs and absolute GitHub raw URLs for npm images; verify both renderers, accessibility and mobile layout. Publish only after owner approval and release checks.
