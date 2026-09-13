/**
 * A headless remote control host for development, without Electron. It connects to a relay, prints
 * a pairing link and tunnels paired clients to a local engine. Keys live in memory only.
 *
 *   bun packages/remote/script/dev-host.ts --relay ws://localhost:8787 --app http://localhost:4444/
 */
import { parseArgs } from "node:util"
import {
  acceptChannel,
  createHostIdentity,
  fromBase64Url,
  pairingUrl,
  random,
  serveTunnel,
  startRelayHost,
  toBase64Url,
} from "../src"

const args = parseArgs({
  options: {
    relay: { type: "string", default: "ws://localhost:8787" },
    app: { type: "string", default: "http://localhost:4444/" },
    engine: { type: "string", default: "http://127.0.0.1:4096" },
  },
}).values

const devices = new Map<string, string>()
const pairingId = toBase64Url(random(16))
const secret = random(32)

const host = startRelayHost({
  relay: args.relay,
  identity: await createHostIdentity(),
  onStatus: (status, detail) => console.log(`[host] ${status}${detail ? ` (${detail})` : ""}`),
  onChannel: (wire, channel) =>
    void acceptChannel(wire, (mode, id) => {
      if (mode === "pair") return id === pairingId ? secret : undefined
      const key = devices.get(id)
      return key ? fromBase64Url(key) : undefined
    })
      .then((accepted) => {
        console.log(`[host] channel ${channel} accepted (${accepted.mode})`)
        const tunnel = serveTunnel(accepted.channel, { target: args.engine })
        tunnel.onControl((message) => console.log("[host] control", message))
        if (accepted.mode !== "pair") return
        const deviceId = toBase64Url(random(16))
        const deviceKey = toBase64Url(random(32))
        devices.set(deviceId, deviceKey)
        tunnel.sendControl({ type: "enrolled", deviceId, deviceKey, hostName: "dev-host" })
      })
      .catch((error: unknown) => console.log(`[host] channel ${channel} rejected: ${String(error)}`)),
})

console.log(
  `[host] pairing link:\n${pairingUrl(args.app, { v: 1, relay: args.relay, host: await host.hostId, id: pairingId, secret: toBase64Url(secret), name: "dev-host" })}`,
)
