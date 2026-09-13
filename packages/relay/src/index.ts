import type { VapidKeys } from "@flupcode/remote"
import { startRelay } from "./relay"

const relay = startRelay({
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? "0.0.0.0",
  maxClientsPerHost: process.env.RELAY_MAX_CLIENTS_PER_HOST
    ? Number(process.env.RELAY_MAX_CLIENTS_PER_HOST)
    : undefined,
  maxConnectionsPerIp: process.env.RELAY_MAX_CONNECTIONS_PER_IP
    ? Number(process.env.RELAY_MAX_CONNECTIONS_PER_IP)
    : undefined,
  ipHeader: process.env.RELAY_IP_HEADER,
  push:
    process.env.RELAY_VAPID_PUBLIC_KEY && process.env.RELAY_VAPID_PRIVATE_KEY
      ? {
          keys: {
            publicKey: process.env.RELAY_VAPID_PUBLIC_KEY,
            privateKey: JSON.parse(process.env.RELAY_VAPID_PRIVATE_KEY) as VapidKeys["privateKey"],
          },
          subject: process.env.RELAY_VAPID_SUBJECT ?? "mailto:hello@flupcode.com",
        }
      : undefined,
  log: (message) => console.log(`[relay] ${message}`),
})

console.log(
  `[relay] listening on ${relay.server.hostname}:${relay.server.port}, push ${process.env.RELAY_VAPID_PUBLIC_KEY ? "on" : "off"}`,
)

const shutdown = () => {
  relay.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
