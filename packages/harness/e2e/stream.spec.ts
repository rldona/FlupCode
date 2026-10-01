import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_stream",
  projectID: "p",
  title: "Streaming",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const permission = {
  id: "per_1",
  sessionID: "ses_stream",
  action: "bash",
  resources: ["rm -rf build"],
  metadata: { command: "rm -rf build" },
  time: { created: now },
}

test("a reconnection picks up the permission that was asked while the stream was gone", async ({ page }) => {
  // The engine asks for permission after the first stream ends, so the event announcing it is lost:
  // only a resync on reconnection can surface it. Without one the agent waits, blocked and invisible.
  let streams = 0
  const blocked = () => streams > 1

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_stream/message")
      return route.fulfill({
        json: { data: [{ id: "msg_u", type: "user", text: "Clean up", time: { created: now } }], cursor: {} },
      })
    if (url.pathname === "/api/session/ses_stream/permission")
      return route.fulfill({ json: { data: blocked() ? [permission] : [] } })
    if (/^\/api\/session\/[^/]+\/question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/api/event") {
      streams++
      // Every connection ends at once, which is what a dropped stream looks like to the app.
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Clean up")).toBeVisible()
  await expect(page.locator(".fc-dock-permission")).toHaveCount(0)

  // The app reconnects on its own backoff and asks again for what it may have missed.
  await expect(page.getByText("rm -rf build")).toBeVisible({ timeout: 15_000 })
})

test("a reconnection resyncs once the new stream is open, not before it", async ({ page }) => {
  // The permission is asked while the stream is being reopened: after anything read before the
  // stream opened, and before the stream could announce it. Only a resync once the engine says the
  // stream is open (`server.connected`) can surface it, since this stream then stays open and quiet.
  // A mocked route cannot hold a stream open, so the event stream is a real one.
  let streams = 0
  const blocked = () => streams > 1
  const events = createServer((request, response) => {
    streams++
    response.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" })
    // The first connection drops at once; the second opens, says so, and then stays quiet.
    if (streams === 1) return response.end()
    response.write(`data: ${JSON.stringify({ id: "evt_1", type: "server.connected", data: {} })}\n\n`)
    request.on("close", () => response.end())
  })
  await new Promise<void>((resolve) => events.listen(0, "127.0.0.1", resolve))
  const eventsUrl = `http://127.0.0.1:${(events.address() as AddressInfo).port}/api/event`

  try {
    await page.addInitScript(() => {
      window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
      window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
      window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
    })
    await page.route("http://127.0.0.1:9/**", (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
      if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
      if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
      if (url.pathname === "/api/session/ses_stream/message")
        return route.fulfill({
          json: { data: [{ id: "msg_u", type: "user", text: "Clean up", time: { created: now } }], cursor: {} },
        })
      if (url.pathname === "/api/session/ses_stream/permission")
        return route.fulfill({ json: { data: blocked() ? [permission] : [] } })
      if (/^\/api\/session\/[^/]+\/question/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
      if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
      if (url.pathname === "/api/event") return route.continue({ url: eventsUrl })
      return route.fulfill({ status: 404, json: {} })
    })
    await page.goto("/")

    await expect(page.getByText("Clean up")).toBeVisible()
    await expect(page.getByText("rm -rf build")).toBeVisible({ timeout: 15_000 })
    expect(streams).toBe(2)
  } finally {
    events.closeAllConnections()
    events.close()
  }
})

test("a prompt shows as the stream announces it, not only after a reload", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: { ses_stream: { type: "running" } } } })
    if (url.pathname === "/session/status") return route.fulfill({ json: { ses_stream: { type: "busy" } } })
    // The engine's history still has no user message: only the stream announces it, the way it does
    // for a prompt sent from the composer.
    if (url.pathname === "/api/session/ses_stream/message") return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/event") {
      // The engine announces the user message empty and sends its text as a part right after. That
      // order used to leave the prompt blank for the whole turn, shown only once a refetch rebuilt
      // the message from its parts.
      const events = [
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_stream",
            info: { id: "msg_live", sessionID: "ses_stream", role: "user" },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_stream",
            part: { id: "part_live", messageID: "msg_live", sessionID: "ses_stream", type: "text", text: "Live prompt" },
          },
        },
      ]
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    }
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-message-user .fc-message-text")).toContainText("Live prompt")
})

test("the desktop pill admits the app is no longer following the engine", async ({ page }) => {
  let allow = true
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    // The engine status is the desktop app's strip only; the browser does not draw it.
    window.flupcode = { ownsTitleBar: true, platform: "darwin" }
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    // The engine keeps answering the health check: only the stream is gone.
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event") {
      if (allow) {
        allow = false
        return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
      }
      return route.abort()
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-status")).toContainText(/Reconnecting|Reconectando/i, { timeout: 15_000 })
})

test("a folder whose stream died is admitted, even while the global one is healthy", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream"))
    window.flupcode = { ownsTitleBar: true, platform: "darwin" }
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (url.pathname === "/api/session/ses_stream/message")
      return route.fulfill({
        json: { data: [{ id: "m", type: "user", text: "Hola", time: { created: now } }], cursor: {} },
      })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    // The global stream is perfectly healthy and stays open…
    if (url.pathname === "/api/event") return new Promise(() => {})
    // …while the folder's own stream is gone. That folder carries the transcript, so the app is not
    // following the engine, however fine the global stream looks.
    if (url.pathname === "/event") return route.abort()
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.getByText("Hola")).toBeVisible()
  await expect(page.locator(".fc-status")).toContainText(/Reconnecting|Reconectando/i, { timeout: 15_000 })
})

test("the browser draws no engine status pill", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // A healthy engine with the stream open is the pill's "Connected" case, and it is the desktop
  // strip's to draw: in the browser it was a label the reader could do nothing with.
  await expect(page.locator(".fc-topbar .fc-status:not(.fc-status-remote)")).toHaveCount(0)
})
