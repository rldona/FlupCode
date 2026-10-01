import { createServer, type ServerResponse } from "node:http"
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
  let historyReads = 0
  // Once delivered, the prompt is in the engine's history too, as it would be: a later read must not
  // take back what the stream showed. What proves the stream drew it is that no read came in between.
  let delivered = false
  // A stream that closes makes the app reconnect and refetch the history, which would show the prompt
  // without the stream: the stream is a real one that stays open.
  const streams: ServerResponse[] = []
  const events = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" })
    response.write(`data: ${JSON.stringify({ id: "evt_c", type: "server.connected", data: {} })}\n\n`)
    streams.push(response)
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
      if (url.pathname === "/api/session/active")
        return route.fulfill({ json: { data: { ses_stream: { type: "running" } } } })
      // The engine's history still has no user message: only the stream announces it, the way it does
      // for a prompt sent from the composer.
      if (url.pathname === "/api/session/ses_stream/message") {
        historyReads++
        const prompt = { id: "msg_live", sessionID: "ses_stream", type: "user", text: "Live prompt", time: { created: now } }
        return route.fulfill({ json: { data: delivered ? [prompt] : [], cursor: {} } })
      }
      if (url.pathname === "/api/session/ses_stream/inbox") return route.fulfill({ json: { data: [] } })
      if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
        return route.fulfill({ json: { data: [] } })
      if (url.pathname === "/api/event") return route.continue({ url: eventsUrl })
      return route.fulfill({ status: 404, json: {} })
    })
    await page.goto("/")

    await expect.poll(() => historyReads > 0 && streams.length === 1).toBe(true)
    await expect(page.getByText(/No messages yet|Aún no hay mensajes|Sin mensajes/)).toBeVisible()
    const readsBefore = historyReads
    // The engine admits the prompt into the session inbox and delivers it into the transcript at its
    // next safe boundary; the text is only in the admission, so the delivery must find it there.
    const inbox = [
      {
        type: "session.inbox.enqueued",
        data: {
          sessionID: "ses_stream",
          inboxID: "inb_live",
          item: { type: "user", payload: { text: "Live prompt" }, delivery: "steer" },
        },
      },
      { type: "session.inbox.delivered", data: { sessionID: "ses_stream", inboxID: "inb_live" } },
    ]
    delivered = true
    streams[0]!.write(
      inbox
        .map((event, index) => `data: ${JSON.stringify({ id: `evt_${index}`, created: now + index, ...event })}\n\n`)
        .join(""),
    )

    await expect(page.locator(".fc-message-user .fc-message-text")).toContainText("Live prompt")
    expect(historyReads).toBe(readsBefore)
  } finally {
    events.closeAllConnections()
    events.close()
  }
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
