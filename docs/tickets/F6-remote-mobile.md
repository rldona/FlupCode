# F6 — Remote / mobile

Goal: a native-feeling mobile experience on top of the existing server. See ADR-0007.

## F6-1 — PWA + responsive layout · P1 · done

**Acceptance**
- Harness installs as a PWA.
- Layout adapts down to phone widths (sidebar drawer, composer dock).

## F6-2 — QR pairing + auth · P1 · done

QR of the server URL plus LAN/password instructions. Automated credential embedding would need server support.

**Acceptance**
- Desktop/server shows a QR code; mobile pairs and authenticates.
- Requires `OPENCODE_SERVER_PASSWORD`; documented security posture.

## F6-3 — Push notifications · P2 · done

Web Notifications on permission/question requests while the app is backgrounded, with a settings toggle.

**Acceptance**
- Notifications for turn completion, permissions and errors when backgrounded.

## F6-4 — In-app serve/tunnel management · P2 · done

Remote panel shows the LAN serve command and a Cloudflare tunnel command with copy actions.

**Acceptance**
- Start/stop sharing from the UI; show connection status and address.
