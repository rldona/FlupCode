# F7 — Release

Goal: stable, documented v1.0.

## F7-1 — E2E, accessibility, i18n · P1 · doing

Unit tests for metrics merged, focus-visible styles added, and an i18n layer (English source, Spanish translation, locale switch in Customize) is in place. E2E coverage pending.

**Acceptance**
- E2E coverage for core flows (session, composer, permissions, settings).
- Axe/contrast pass; keyboard-only pass.
- All user-facing strings go through i18n; English complete.

## F7-2 — User documentation · P1 · done

**Acceptance**
- Install, quickstart, concepts, keyboard shortcuts, troubleshooting.

## F7-3 — v1.0 release · P1 · done

Tag `flupcode-v1.0.0` released with the `flupcode-web.zip` asset via `.github/workflows/release.yml`.

**Acceptance**
- Versioned release with notes for web and desktop.
- Upgrade path from beta.
