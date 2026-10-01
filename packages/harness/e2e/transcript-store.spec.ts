import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_store",
  projectID: "p",
  title: "Streaming",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const history = [{ id: "msg_u", type: "user", text: "Write the helper", time: { created: now } }]

// What the engine sends while a turn runs: the step that opens the answer, its text a slice at a
// time, then its tool from the call to the result.
const data = (fields: object) => ({ sessionID: "ses_store", assistantMessageID: "msg_a", ...fields })
const turn = [
  { type: "session.execution.started", data: { sessionID: "ses_store" } },
  {
    type: "session.step.started",
    data: data({ agent: "build", model: { providerID: "openai", id: "gpt" }, started: now + 1 }),
  },
  { type: "session.text.started", data: data({}) },
  { type: "session.text.delta", data: data({ delta: "Writing " }) },
  { type: "session.text.delta", data: data({ delta: "the " }) },
  { type: "session.text.delta", data: data({ delta: "helper now" }) },
  { type: "session.tool.input.started", data: data({ id: "t_a", name: "write" }) },
  { type: "session.tool.called", data: data({ id: "t_a", input: { filePath: "/work/demo/a.ts" } }) },
  { type: "session.tool.success", data: data({ id: "t_a", content: [{ type: "text", text: "wrote a.ts" }] }) },
].map((event, index) => ({ id: `evt_${index}`, created: now + index, ...event }))

test("a running turn is built from its events, not from refetching the history", async ({ page }) => {
  let historyReads = 0
  // A mocked route cannot hold a stream open, and a stream that closes makes the app reconnect and
  // refetch the history, which is exactly what this test must not rely on: the stream is a real one.
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
      window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_store"))
    })
    await page.route("http://127.0.0.1:9/**", (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
      if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
      if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
      if (url.pathname === "/api/session/ses_store/message") {
        historyReads++
        return route.fulfill({ json: { data: history, cursor: {} } })
      }
      if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
        return route.fulfill({ json: { data: [], cursor: {} } })
      if (url.pathname === "/api/event") return route.continue({ url: eventsUrl })
      return route.fulfill({ status: 404, json: {} })
    })
    await page.goto("/")

    await expect(page.getByText("Write the helper")).toBeVisible()
    await expect.poll(() => streams.length).toBe(1)
    const readsAfterLoad = historyReads
    // The turn starts once the history has landed.
    streams[0]!.write(turn.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))

    // The answer, its deltas and its tool all arrive as events and land in the transcript.
    await expect(page.getByText("Writing the helper now")).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(".fc-toolgroup-line, .fc-tool-header").first()).toBeVisible()

    // And none of it cost a refetch: every event used to schedule a full reload of the history.
    expect(historyReads).toBe(readsAfterLoad)
  } finally {
    events.closeAllConnections()
    events.close()
  }
})

test("the running status line keeps the same air above as the transcript keeps below", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_store"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_store/message")
      return route.fulfill({
        json: {
          data: [
            { id: "msg_u", sessionID: "ses_store", role: "user", type: "user", text: "Hazlo", time: { created: now } },
            // No `completed`, so the turn is still running and the status line is up.
            {
              id: "msg_a",
              sessionID: "ses_store",
              role: "assistant",
              type: "assistant",
              agent: "build",
              model: { providerID: "openai", modelID: "gpt" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now + 1 },
              content: [{ type: "text", text: "Voy." }],
            },
          ],
          cursor: {},
        },
      })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
      return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  await expect(page.locator(".fc-message-pending")).toBeVisible()
  const gaps = await page.evaluate(() => {
    const pending = document.querySelector(".fc-message-pending")!
    const loader = pending.querySelector(".fc-loader") ?? pending
    const transcript = document.querySelector(".fc-transcript")!
    const previous = pending.previousElementSibling as HTMLElement
    return {
      above: loader.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
      below: parseFloat(getComputedStyle(transcript).paddingBottom),
    }
  })
  expect(Math.abs(gaps.above - gaps.below)).toBeLessThan(2)
})
