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
const e2eSession = {
  id: "ses_e2e",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.now() - 60_000, updated: Date.now() - 60_000 },
  title: "Fix the login flow",
  location: { directory: "/work/flupcode" },
}

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
    if (request.url?.startsWith("/api/session?") || request.url === "/api/session")
      return response.end(JSON.stringify({ data: [e2eSession], cursor: {} }))
    if (request.url?.startsWith("/vcs?")) return response.end(JSON.stringify({ branch: "main" }))
    if (request.url?.startsWith("/api/model"))
      return response.end(
        JSON.stringify({
          data: [
            {
              id: "e2e-model",
              providerID: "e2e",
              name: "E2E Model",
              variants: [{ id: "low" }, { id: "high" }, { id: "xhigh" }],
            },
          ],
        }),
      )
    if (request.url?.startsWith("/permission?"))
      return response.end(JSON.stringify([{ id: "per_1", sessionID: e2eSession.id }]))
    // Two prompts so the transcript grows a conversation navigator and flips to its narrow column.
    if (new RegExp(`^/(api/)?session/${e2eSession.id}/message`).test(request.url ?? ""))
      return response.end(
        JSON.stringify({
          data: [
            { id: "msg_e2e_1", type: "user", text: "First prompt", time: { created: Date.now() - 120_000 } },
            { id: "msg_e2e_3", type: "user", text: "Second prompt", time: { created: Date.now() - 60_000 } },
          ],
          cursor: {},
        }),
      )
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

  await expect(page.locator(".fc-topbar .fc-status-remote")).toBeVisible({ timeout: 15_000 })
  await expect(page).not.toHaveURL(/#remote=/)
  // The remote pill replaces the engine's "Connected": one honest indicator opens the panel.
  await expect(page.locator(".fc-topbar .fc-status:not(.fc-status-remote)")).toHaveCount(0)
  await page.locator(".fc-topbar .fc-status-remote").click()
  const panel = page.getByRole("dialog", { name: "Remote control" })
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: "Close" }).first().click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => engineHits.some((url) => url.includes("health"))).toBe(true)
  const hosts = await page.evaluate(() => JSON.parse(localStorage.getItem("flupcode.remoteHosts") ?? "[]"))
  expect(hosts).toMatchObject([{ name: "e2e-host", deviceId: "e2e-device" }])

  await page.locator(".fc-topbar .fc-status-remote").click()
  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(page.locator(".fc-topbar .fc-status-remote")).toHaveCount(0)
  host.stop()
})

test("an expired pairing link explains the error instead of showing the welcome screen", async ({ page, baseURL }) => {
  const statuses: string[] = []
  const host = startRelayHost({
    relay: relayUrl,
    identity: await createHostIdentity(),
    onStatus: (status) => statuses.push(status),
    // The host knows no pairing, as when the code expired or was already used.
    onChannel: (wire) => void acceptChannel(wire, () => undefined).catch(() => undefined),
  })
  await expect.poll(() => statuses.at(-1)).toBe("online")

  await page.addInitScript(() => localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9")))
  await page.goto(
    pairingUrl(`${baseURL}/`, {
      v: 1,
      relay: relayUrl,
      host: await host.hostId,
      id: toBase64Url(random(16)),
      secret: toBase64Url(random(32)),
      name: "e2e-host",
    }),
  )

  const panel = page.getByRole("dialog", { name: "Remote control" })
  await expect(panel.getByText(/pairing code expired or was already used/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("dialog", { name: /Welcome to FlupCode/ })).toHaveCount(0)

  await panel.getByRole("button", { name: "Close" }).first().click()
  await expect(page.getByRole("dialog", { name: /Welcome to FlupCode/ })).toBeVisible()
  host.stop()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("controlling a computer shows the sessions home and a focused session screen", async ({ page, baseURL }) => {
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
              deviceId: "e2e-phone",
              deviceKey: toBase64Url(random(32)),
              hostName: "e2e-mac",
            })
          })
          .catch(() => undefined),
    })
    await expect.poll(() => statuses.at(-1)).toBe("online")
    await page.addInitScript(() => localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9")))
    await page.goto(
      pairingUrl(`${baseURL}/`, {
        v: 1,
        relay: relayUrl,
        host: await host.hostId,
        id: pairingId,
        secret: toBase64Url(secret),
        name: "e2e-mac",
      }),
    )

    const home = page.locator(".fc-remote-home")
    await expect(home).toBeVisible({ timeout: 15_000 })
    await expect(home.getByRole("heading", { level: 1 })).toHaveText("Code")
    await expect(home.getByRole("button", { name: /e2e-mac/ })).toBeVisible()
    const card = home.getByRole("button", { name: /Fix the login flow/ })
    await expect(card).toContainText("flupcode · main")
    await expect(card.getByRole("img", { name: "Needs your input" })).toBeVisible()
    await expect(page.locator(".fc-sidebar")).toHaveCount(0)

    // The fake engine answers 404 for the transcript: the session screen must still open.
    await card.click()
    await expect(page.locator(".fc-mobile-header")).toContainText("Fix the login flow")
    // The chat shares the dock's column, even in the narrow layout with the chapter rail.
    await expect(page.locator(".fc-transcript-frame")).toHaveClass(/fc-chat-narrow/)
    const body = page.locator(".fc-transcript-body")
    await expect(body).toBeVisible()
    const [bodyLeft, fieldLeft] = await page.evaluate(() => [
      document.querySelector(".fc-transcript-body")!.getBoundingClientRect().left,
      document.querySelector(".fc-mobile-field")!.getBoundingClientRect().left,
    ])
    expect(Math.round(bodyLeft)).toBe(Math.round(fieldLeft))
    // The phone dock: "+" opens attachments and settings as a bottom sheet.
    const dock = page.locator(".fc-mobile-dock")
    await expect(dock.getByPlaceholder("Type / for commands")).toBeVisible()
    await expect(page.locator(".fc-composer")).toHaveCount(0)
    await dock.getByRole("button", { name: "Add context" }).click()
    const sheet = page.getByRole("dialog", { name: "Add context" })
    await expect(sheet.getByRole("button", { name: "Camera" })).toBeVisible()
    await sheet.getByRole("button", { name: "Close" }).click()
    await expect(sheet).toHaveCount(0)
    // Effort sits next to the model, with readable levels, and shows in the model pill.
    await dock.getByRole("button", { name: "Model" }).click()
    const models = page.getByRole("dialog", { name: "Select model" })
    await expect(models.getByRole("button", { name: /E2E Model/ })).toBeVisible()
    await models.getByRole("button", { name: /Effort/ }).click()
    const effort = page.getByRole("dialog", { name: "Effort" })
    await expect(effort.locator(".fc-sheet-option-label")).toHaveText(["Default", "Low", "High", "Extra"])
    await effort.getByRole("button", { name: "High" }).click()
    await expect(dock.getByRole("button", { name: "Model" })).toContainText("E2E ModelHigh")
    await page.getByRole("button", { name: "Back" }).click()
    await expect(home).toBeVisible()

    await home.getByRole("button", { name: "New session" }).click()
    await page
      .getByRole("dialog", { name: "New session" })
      .getByRole("button", { name: /flupcode/ })
      .click()
    await expect(page.locator(".fc-mobile-header")).toContainText("New session")
    await page.goBack()
    await expect(home).toBeVisible()

    // Reopening the app starts on the home, even after a session was open.
    await card.click()
    await expect(page.locator(".fc-mobile-header")).toContainText("Fix the login flow")
    await page.reload()
    await expect(home).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(".fc-mobile-header")).toHaveCount(0)
    host.stop()
  })

  test("turns on notifications, shows pushes and opens their session", async ({ page, context, baseURL }) => {
    const pairingId = toBase64Url(random(16))
    const secret = random(32)
    const deviceKey = random(32)
    const statuses: string[] = []
    const controls: Array<Record<string, unknown>> = []
    const host = startRelayHost({
      relay: relayUrl,
      identity: await createHostIdentity(),
      onStatus: (status) => statuses.push(status),
      onChannel: (wire) =>
        void acceptChannel(wire, (mode, id) =>
          mode === "pair" && id === pairingId
            ? secret
            : mode === "device" && id === "e2e-phone"
              ? deviceKey
              : undefined,
        )
          .then((accepted) => {
            const tunnel = serveTunnel(accepted.channel, { target: engineUrl })
            tunnel.onControl((message) => controls.push(message))
            if (accepted.mode === "pair")
              tunnel.sendControl({
                type: "enrolled",
                deviceId: "e2e-phone",
                deviceKey: toBase64Url(deviceKey),
                hostName: "e2e-mac",
              })
          })
          .catch(() => undefined),
    })
    await expect.poll(() => statuses.at(-1)).toBe("online")
    const hostId = await host.hostId

    // Headless Chromium has no push service: fake the relay key and the browser subscription.
    await context.grantPermissions(["notifications"], { origin: baseURL })
    await page.route("**/push/key", (route) => route.fulfill({ json: { publicKey: toBase64Url(random(65)) } }))
    await page.addInitScript(() => {
      localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
      PushManager.prototype.subscribe = async function (options) {
        return {
          endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
          options,
          toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/e2e", keys: { p256dh: "p", auth: "a" } }),
          unsubscribe: async () => true,
        } as unknown as PushSubscription
      }
      PushManager.prototype.getSubscription = async () => null
      // Headless Chromium reports notifications as denied even when granted.
      Object.defineProperty(Notification, "permission", { get: () => "granted" })
      Notification.requestPermission = async () => "granted"
    })
    await page.goto(
      pairingUrl(`${baseURL}/`, {
        v: 1,
        relay: relayUrl,
        host: hostId,
        id: pairingId,
        secret: toBase64Url(secret),
        name: "e2e-mac",
      }),
    )
    const home = page.locator(".fc-remote-home")
    await expect(home).toBeVisible({ timeout: 15_000 })
    await home.getByRole("button", { name: "Turn on" }).click()
    await expect(home.getByText("Notifications on")).toBeVisible()
    await expect
      .poll(() => controls.find((message) => message.type === "push-subscription"))
      .toMatchObject({
        subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/e2e", keys: { p256dh: "p", auth: "a" } },
      })

    // Deliver a push to the service worker with no window open, as when the phone is locked. Headless
    // Chromium cannot display notifications, so record what the worker asks to show.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    await worker.evaluate(() => {
      const scope = self as unknown as { __shown: unknown[]; registration: ServiceWorkerRegistration }
      scope.__shown = []
      scope.registration.showNotification = async (title, options) => {
        scope.__shown.push({
          title,
          body: options?.body,
          tag: options?.tag,
          url: (options?.data as { url?: string })?.url,
        })
      }
    })
    const cdp = await context.newCDPSession(page)
    const registered = new Promise<string>((resolve) =>
      cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
        const registration = event.registrations.find((entry) => entry.scopeURL === `${baseURL}/`)
        if (registration) resolve(registration.registrationId)
      }),
    )
    await cdp.send("ServiceWorker.enable")
    const registrationId = await registered
    await page.goto("about:blank")
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin: baseURL!,
      registrationId,
      data: JSON.stringify({
        kind: "permission",
        host: hostId,
        hostName: "e2e-mac",
        sessionID: "ses_e2e",
        session: "Fix the login flow",
        detail: "bash: rm -rf dist",
      }),
    })
    await expect
      .poll(() => worker.evaluate(() => (self as unknown as { __shown: unknown[] }).__shown))
      .toEqual([
        {
          title: "Fix the login flow",
          body: "Needs your permission: bash: rm -rf dist",
          tag: `${hostId}:ses_e2e`,
          url: `/?session=ses_e2e&host=${hostId}`,
        },
      ])

    // Tapping it opens /?session=…&host=…, which lands on that session.
    await page.goto(`${baseURL}/?session=ses_e2e&host=${hostId}`)
    await expect(page.locator(".fc-mobile-header")).toContainText("Fix the login flow", { timeout: 15_000 })
    await expect(page).not.toHaveURL(/session=/)
    host.stop()
  })

  test("the welcome screen offers to control a computer first", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9")))
    await page.goto("/")
    const welcome = page.getByRole("dialog", { name: /Welcome to FlupCode/ })
    await expect(welcome.getByRole("button", { name: "Control a computer" })).toBeVisible()
    await expect(welcome.getByRole("button", { name: "Get started" })).toBeHidden()

    await welcome.getByPlaceholder("Your name").fill("Raúl")
    await welcome.getByRole("button", { name: "Control a computer" }).click()
    await expect(welcome).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Remote control" })).toBeVisible()
  })
})
