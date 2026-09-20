# @flupcode/relay

The remote control relay (ADR-0010). A desktop connects to it as a **host**, a phone connects as a
**client**, and the relay routes frames between them. Frames are end-to-end encrypted: the relay
cannot read sessions, prompts or files.

## Run locally

```bash
bun run --cwd packages/relay dev
```

It listens on `ws://localhost:8787`. Point the desktop at it with
`FLUPCODE_RELAY_URL=ws://localhost:8787`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listening port |
| `HOST` | `0.0.0.0` | Listening address |
| `RELAY_MAX_CLIENTS_PER_HOST` | `16` | Simultaneous phones per desktop |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `64` | Simultaneous sockets per IP |
| `RELAY_IP_HEADER` | — | Header with the real client IP behind a proxy (e.g. `fly-client-ip`) |

## Deploy

The relay must be served over TLS (`wss://`): phones load the web app over HTTPS and browsers
block insecure WebSockets from secure pages.

### Docker

```bash
docker build -f packages/relay/Dockerfile -t flupcode-relay .
docker run -p 8787:8787 flupcode-relay
```

Put it behind a TLS-terminating proxy that supports WebSockets (Caddy, nginx, Traefik).

### Fly.io

```bash
fly apps create flupcode-relay
packages/relay/script/deploy.sh
fly certs add relay.flupcode.com --app flupcode-relay
```

`deploy.sh` uploads a minimal build context (the relay and the protocol package) and builds the
image on Fly's remote builder, so Docker is not needed locally. Then add the DNS record Fly prints
(a `CNAME` for `relay` to `flupcode-relay.fly.dev`) at the domain registrar. Madrid is not a Fly
region; `fly.toml` uses Paris (`cdg`).

## Endpoints

- `GET /health` — liveness.
- `WS /host?id=<hostId>` — desktop; must answer a signed challenge proving it owns `hostId`.
- `WS /client?host=<hostId>` — phone; closed with `4404` if the host is offline, `4429` over the
  client limit.
