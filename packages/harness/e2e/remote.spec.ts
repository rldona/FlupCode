import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import {
  acceptChannel,
  createHostIdentity,
  pairingUrl,
  random,
  serveTunnel,
  startRelayHost,
  toBase64Url,
} from "../../remote/src"

const RELAY_PORT = 18_787
const relayUrl = `ws://127.0.0.1:${RELAY_PORT}`

let relay: ChildProcess
let engine: Server
let engineUrl = ""
const engineHits: string[] = []

async function waitForRelay() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const healthy = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)
      .then((response) => response.ok)
      .catch(() => false)
    if (healthy) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("relay did not start")
}

test.beforeAll(async () => {
  relay = spawn("bun", [fileURLToPath(new URL("../../relay/src/index.ts", import.meta.url))], {
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  })
  engine = createServer((request, response) => {
    engineHits.push(request.url ?? "")
    response.setHeader("content-type", "application/json")
    if (request.url?.startsWith("/api/health") || request.url?.startsWith("/global/health"))
      return response.end(JSON.stringify({ healthy: true, version: "e2e" }))
    response.statusCode = 404
    response.end(JSON.stringify({ message: "not found" }))
  })
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve))
  engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`
  await waitForRelay()
})

test.afterAll(() => {
  relay?.kill()
  engine?.close()
})

test("pairs from a link and reaches the engine through the relay", async ({ page, baseURL }) => {
  const pairingId = toBase64Url(random(16))
  const secret = random(32)
  const statuses: string[] = []
  const host = startRelayHost({
    relay: relayUrl,
    identity: await createHostIdentity(),
    onStatus: (status) => statuses.push(status),
    onChannel: (wire) =>
      void acceptChannel(wire, (mode, id) => (mode === "pair" && id === pairingId ? secret : undefined))
        .then((accepted) => {
          const tunnel = serveTunnel(accepted.channel, { target: engineUrl })
          tunnel.sendControl({
            type: "enrolled",
            deviceId: "e2e-device",
            deviceKey: toBase64Url(random(32)),
            hostName: "e2e-host",
          })
        })
        .catch(() => undefined),
  })
  await expect.poll(() => statuses.at(-1)).toBe("online")

  const link = pairingUrl(`${baseURL}/`, {
    v: 1,
    relay: relayUrl,
    host: await host.hostId,
    id: pairingId,
    secret: toBase64Url(secret),
    name: "e2e-host",
  })
  // An unreachable local server makes the first health check fail before pairing.
  await page.addInitScript(() => localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9")))
  await page.goto(link)

  await expect(page.getByRole("button", { name: /Remote: e2e-host/ })).toBeVisible({ timeout: 15_000 })
  await expect(page).not.toHaveURL(/#remote=/)
  await expect(page.locator(".fc-topbar .fc-status:not(.fc-status-remote)")).toHaveText("Connected")
  await expect.poll(() => engineHits.some((url) => url.includes("health"))).toBe(true)
  const hosts = await page.evaluate(() => JSON.parse(localStorage.getItem("flupcode.remoteHosts") ?? "[]"))
  expect(hosts).toMatchObject([{ name: "e2e-host", deviceId: "e2e-device" }])

  await page.getByRole("button", { name: /Remote: e2e-host/ }).click()
  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(page.getByRole("button", { name: /Remote: e2e-host/ })).toHaveCount(0)
  host.stop()
})
