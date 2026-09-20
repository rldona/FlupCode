# F5 — Desktop

Goal: a packaged, signed, auto-updating desktop app reusing the harness renderer.

## F5-1 — `harness-desktop` Electron shell · P1 · done

**Acceptance**
- Electron main boots/attaches to the local server and loads the harness renderer.
- Reuses patterns from `packages/desktop` without editing it.

## F5-2 — Native menus, window state, multi-window · P1 · done

**Acceptance**
- Native menus bound to harness commands.
- Window state restored; multiple windows supported.

## F5-3 — Auto-update · P1 · todo

**Acceptance**
- Update check, download and install with a user-facing prompt.

## F5-4 — Signing / notarization · P1 · todo

macOS, Windows, Linux.

**Acceptance**
- macOS notarized; Windows signed; Linux packages (deb/rpm/AppImage).
- Release artifacts published from CI.

## F5-5 — First-launch onboarding · P2 · todo

**Acceptance**
- Pick a directory, configure a provider, start the first session.
