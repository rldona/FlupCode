# ADR-0007: Remote and mobile

- **Status:** Accepted (connectivity amended by ADR-0010)
- **Date:** 2026-09-12

## Context

Remote mobile access is often cited as a Claude Code feature OpenCode lacks. In practice OpenCode
already runs as a web server: `opencode web --hostname 0.0.0.0 --mdns` with
`OPENCODE_SERVER_PASSWORD` exposes the UI over the LAN, and `opencode attach` shares sessions.
What is missing is a native-feeling mobile experience, pairing and push — not connectivity itself.

## Decision

- Treat remote/mobile as a final-phase extra (F6), not a prerequisite.
- Build on the existing server: mDNS discovery + password auth + the same HTTP/SSE client.
- Deliver, in order: responsive/PWA layout → QR pairing + auth → push notifications → optional
  tunnel management UI.

## Consequences

- Minimal new backend work; the capability already exists.
- Security matters: any LAN exposure must use authentication and be opt-in.
- The mobile surface is the same `packages/harness` app in a responsive/PWA mode, not a separate
  codebase.
