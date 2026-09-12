# F6 — Remote / mobile

Goal: a native-feeling mobile experience on top of the existing server. See ADR-0007.

## F6-1 — PWA + responsive layout · P1 · done

**Acceptance**
- Harness installs as a PWA.
- Layout adapts down to phone widths (sidebar drawer, composer dock).

## F6-2 — QR pairing + auth · P1 · todo

**Acceptance**
- Desktop/server shows a QR code; mobile pairs and authenticates.
- Requires `OPENCODE_SERVER_PASSWORD`; documented security posture.

## F6-3 — Push notifications · P2 · todo

**Acceptance**
- Notifications for turn completion, permissions and errors when backgrounded.

## F6-4 — In-app serve/tunnel management · P2 · todo

**Acceptance**
- Start/stop sharing from the UI; show connection status and address.
