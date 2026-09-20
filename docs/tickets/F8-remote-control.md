# F8 — Remote control

Goal: drive a desktop session from a phone on any network, through an end-to-end encrypted relay.
See ADR-0010.

## F8-1 — Design: ADR-0010 and tickets · P0 · done

**Acceptance**
- Topology, relay protocol, secure channel, pairing and tunnel framing documented.

## F8-2 — Secure channel (`@flupcode/remote`) · P0 · done

**Acceptance**
- `pair` and `device` handshakes with mutual proofs over ECDH P-256 + PSK.
- AES-GCM sealed frames with ordered counters; tampering, replay and wrong keys are rejected.
- Runs on WebCrypto only (browser, Bun, Electron main); unit tests.

## F8-3 — Tunnel multiplexer (`@flupcode/remote`) · P0 · done

**Acceptance**
- Client `fetch` with streamed request/response bodies and abort.
- Client WebSocket shim (text/binary, close) for the PTY terminal.
- Host side proxies to a configured engine URL with injected credentials and path validation.
- Tests cover SSE streaming, abort and WebSocket echo.

## F8-4 — Relay server (`@flupcode/relay`) · P0 · done

Deployed on Fly.io (Paris) at `wss://relay.flupcode.com`.

**Acceptance**
- `/health`, `/host` with signed challenge, `/client` routing with channel prefixes.
- Frame size, client count and per-IP limits; pings; host replacement; `4404` when offline.
- Dockerfile and a deploy guide; tests with real sockets.

## F8-5 — Desktop host · P0 · doing

Implemented and exercised headlessly (the same host code runs in `script/dev-host.ts` and the
Playwright test). Remaining: manual validation in the packaged Electron app (keychain storage, IPC,
QR pairing with a real phone).

**Acceptance**
- Persistent identity key and paired devices (encrypted with `safeStorage` when available).
- Enable/disable, relay reconnection with backoff, status reporting.
- Create pairing (QR link, expiry), enrol devices, list and revoke them.
- IPC bridge on `window.flupcode.remote`.

## F8-6 — Harness transport · P0 · done

**Acceptance**
- Every engine call (SDK client, SSE, config, permission, PTY HTTP and WebSocket) goes through one
  transport.
- Remote mode swaps the transport for the tunnel without reloading the app.
- The event stream reconnects after drops.

## F8-7 — Remote control UI · P0 · done

**Acceptance**
- Desktop: Remote panel with enable toggle, status, pairing QR with countdown, devices with revoke.
- Phone: opening a pairing link pairs and connects; saved hosts can be reconnected or forgotten; a
  visible indicator shows the remote connection and its state.
- All strings through i18n (English, Spanish).

## F8-8 — Docs and end-to-end test · P1 · done

**Acceptance**
- USAGE and ARCHITECTURE updated; relay deployment documented.
- Automated test: relay + host + tunnel client against a fake engine (`packages/relay/test`,
  `packages/harness/e2e/remote.spec.ts`).

## F8-9 — Web Push while locked · P2 · todo

**Acceptance**
- Permission requests and finished turns notify a paired phone with the app closed.
