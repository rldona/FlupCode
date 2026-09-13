# ADR-0010: Remote control through an end-to-end encrypted relay

- **Status:** Accepted
- **Date:** 2026-09-13
- **Amends:** ADR-0007

## Context

ADR-0007 scoped remote access to "LAN + password": serve the engine on `0.0.0.0`, scan a QR of the
URL, optionally run a tunnel by hand. In practice this does not give a Claude Code–style remote
control:

- The desktop app spawns the engine on `127.0.0.1` without a password, so a phone cannot reach it.
- The hosted web app (`https://app.flupcode.com`, on Vercel) cannot call a plain `http://` LAN
  address (mixed content), so the phone would need a separate local deployment.
- Exposing the engine publicly (tunnels) puts a process that can run shell commands behind HTTP
  Basic auth.

The goal is the Claude Code experience: the session keeps running on the user's machine, the
desktop makes only **outbound** connections, and a phone on any network pairs with a QR and drives
it from the hosted web app.

Vercel does not host long-lived WebSockets, so the relay needs its own host.

## Decision

### Topology

```
 Phone (app.flupcode.com PWA)                 Desktop (Electron main)
   tunnel fetch / WebSocket shim                 remote host
        │  E2E encrypted frames                     │  plain HTTP/SSE/WS on loopback
        ▼                                           ▼
   wss://relay/client?host=ID  ◀── relay ──▶  wss://relay/host?id=ID      opencode serve
                                (routes opaque bytes only)                 127.0.0.1:4096
```

- **`packages/relay` (`@flupcode/relay`)** — a small Bun server shipped as a Docker image. It only
  routes frames between one host socket and its client sockets. It never sees plaintext.
- **`packages/remote` (`@flupcode/remote`)** — runtime-agnostic protocol code (WebCrypto,
  WebSocket, `fetch`): secure channel, tunnel multiplexer, pairing links. Used by the relay (routing
  frames), the desktop main process (host) and the harness (client).
- **Desktop** — owns the host identity, the relay connection, pairing and the list of paired
  devices, and proxies tunnelled traffic to the local engine.
- **Harness** — all engine traffic goes through one swappable transport (`fetch` + WebSocket
  factory). In remote mode that transport is the tunnel.

### Relay protocol (visible to the relay)

- `GET /health` → `200`.
- `WS /host?id=<hostId>` — the relay sends a JSON challenge `{t:"challenge",nonce}`; the host answers
  `{t:"auth",key,signature}` with its ECDSA P-256 public key (raw, base64url) and a signature over
  `"flupcode-relay-v1" || hostId || nonce`. `hostId` must equal `base64url(SHA-256(key))[0..22]`, so
  an id cannot be claimed without its private key. A newer authenticated host socket replaces the
  older one.
- `WS /client?host=<hostId>` — the relay assigns a channel number, tells the host `{t:"open",channel}`
  and forwards bytes both ways. Host→relay binary frames carry a 4-byte big-endian channel prefix;
  client frames carry none. `{t:"close",channel}` flows when either side leaves. If the host is
  offline the client is closed with code `4404`.
- Limits: 1 MiB per frame, a maximum number of clients per host, per-IP connection caps, periodic
  pings.

### Secure channel (end-to-end, not visible to the relay)

WebCrypto only: ECDH P-256, HKDF-SHA-256, HMAC-SHA-256, AES-256-GCM.

1. Client → `hello {mode, id, eph, nonce}` where `mode` is `pair` (id = pairing id) or `device`
   (id = device id).
2. The host looks up the pre-shared key for `id` (pairing secret or device key), generates its own
   ephemeral key and derives, with `transcript = label || mode || id || ephC || nonceC || ephH ||
   nonceH`:
   `HKDF(salt = SHA-256(transcript), ikm = psk || ECDH(ephC, ephH))` → `c2h`, `h2c`,
   `hostConfirm`, `clientConfirm`. It replies `welcome {eph, nonce, proof = HMAC(hostConfirm,
   transcript)}`, or `reject` if the id is unknown.
3. The client verifies the proof and sends `finish {proof = HMAC(clientConfirm, transcript)}`.
4. Every further message is AES-GCM sealed, with a per-direction 64-bit counter as the IV. Frames
   must arrive in order; a gap or failed tag closes the channel.

The PSK authenticates both ends (a relay that swaps keys cannot produce the proofs) and the
ephemeral ECDH gives forward secrecy.

### Pairing

- The desktop creates a one-time pairing (`pairingId`, 32-byte secret, 10-minute expiry) and shows a
  QR for `https://app.flupcode.com/#remote=<base64url JSON {v, relay, host, id, secret, name}>`.
  The fragment never reaches the web server.
- After a `pair` handshake the host enrols the device: it sends `{deviceId, deviceKey}` inside the
  sealed channel and consumes the pairing. Later connections use `device` mode.
- The desktop stores its identity key and device keys under `userData`, encrypted with Electron
  `safeStorage` when available. The phone stores its device record in `localStorage`.
- Devices are listed with their last-seen time and can be revoked, which closes their channels.

### Tunnel (inside the secure channel)

Frames: `[type u8][stream u32][payload]`.

- HTTP: `req-head {method,path,headers}`, `req-body`, `req-end`, `res-head {status,headers}`,
  `res-body`, `res-end`, `abort`. Bodies stream in chunks of up to 64 KiB, so SSE works unchanged.
- WebSocket (PTY): `ws-open {path}`, `ws-opened`, `ws-text`, `ws-binary`, `ws-close {code,reason}`.
- Stream `0` carries control messages (`enrolled`, `ping`).
- The host only forwards origin-relative paths to its configured engine URL, strips hop-by-hop
  headers and adds engine credentials itself.

## Consequences

- Works across networks with no inbound ports, and the relay operator cannot read sessions.
- New operational surface: the relay must be deployed (Docker; Fly.io, Railway or a VPS) and its URL
  configured (`FLUPCODE_RELAY_URL`, default `wss://relay.flupcode.com`). Users can self-host it.
- A paired phone has the same power as the local UI; revocation is the control. Its device key
  lives in the web app's `localStorage`, so an XSS on the app origin could steal it: keep the app's
  Content Security Policy strict and never render untrusted HTML unsanitised.
- WebCrypto needs a secure context: the phone must load the harness over HTTPS (or `localhost`).
- The harness must route every engine call through the transport; raw `fetch`/`WebSocket` to the
  engine is no longer allowed.
- Push notifications while the phone is locked (Web Push) are a separate follow-up.
