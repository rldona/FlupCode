# ADR-0005: Web vs desktop packaging

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

OpenHarness targets both web and desktop. The desktop app is expected to be the primary Claude
Code–style harness, but packaging and signing add significant cost (Electron, notarization, auto-update).
The web app can be validated quickly in a browser.

## Decision

- **Web first.** Build and validate `packages/harness` as a browser app.
- **Desktop second.** Add `packages/harness-desktop` (Electron) reusing upstream `packages/desktop`
  patterns; it loads the harness renderer and boots/attaches to the local server.
- Keep the two sharing one renderer; desktop adds native capabilities (menus, file dialogs, PTY,
  updates, signing) rather than a second UI.

## Consequences

- Faster iteration and lower risk early; desktop inherits a mature UI.
- F5 covers native menus, auto-update and signing across macOS, Windows and Linux.
- No feature may depend on Electron-only APIs without a web fallback, except genuinely native
  actions (reveal in file manager, native notifications).
