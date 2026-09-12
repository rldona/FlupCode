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

## F5-3 — Auto-update · P1 · done

Scaffold done (electron-updater). Shipping updates requires electron-builder publish config and signed builds (F5-4).

**Acceptance**
- Update check, download and install with a user-facing prompt.

## F5-4 — Signing / notarization · P1 · blocked

Blocker: requires developer certificates and CI secrets.

macOS, Windows, Linux.

**Acceptance**
- macOS notarized; Windows signed; Linux packages (deb/rpm/AppImage).
- Release artifacts published from CI.

## F5-5 — First-launch onboarding · P2 · done

**Acceptance**
- Pick a directory, configure a provider, start the first session.
