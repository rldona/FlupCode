import { expect, test, type Page } from "@playwright/test"

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const question = {
  id: "que_1",
  sessionID: "ses_q",
  questions: [
    {
      header: "Deploy",
      question: "Where should it go?",
      options: [
        { label: "Staging", description: "Test first" },
        { label: "Production", description: "Ship it" },
      ],
    },
  ],
}

const messages = (now: number) => ({
  data: [
    { id: "msg_u", type: "user", text: "Do it", time: { created: now } },
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      content: [
        { type: "text", id: "p1", text: "Writing the file" },
        {
          type: "tool",
          id: "tool_1",
          name: "write",
          state: {
            status: "completed",
            input: { filePath: "/work/demo/a.ts", content: "export const a = 1\n" },
            content: [{ type: "text", text: "wrote a.ts" }],
            structured: {},
          },
          time: { created: now + 1, completed: now + 2 },
        },
      ],
      finish: "tool-calls",
      time: { created: now + 1, completed: now + 2 },
    },
  ],
  cursor: {},
})

// Each event-stream request is held until the test releases it, so a refetch lands exactly when a
// tool is open or a question answer is half typed instead of racing the setup.
async function openSessionWithEvents(page: Page, events: unknown[][]) {
  const now = Date.now()
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_q"))
  })

  const resolvers: Array<() => void> = []
  const gate = () => {
    const promise = new Promise<void>((resolve) => (resolvers[resolvers.length] = resolve))
    return promise
  }
  const release = async (index: number) => {
    while (!resolvers[index]) await new Promise((resolve) => setTimeout(resolve, 5))
    resolvers[index]()
  }
  let eventCalls = 0

  await page.route("http://127.0.0.1:9/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          data: [
            {
              id: "ses_q",
              projectID: "p",
              title: "Question",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              location: { directory: "/work/demo" },
            },
          ],
          cursor: {},
        },
      })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_q/message") return route.fulfill({ json: messages(now) })
    if (url.pathname === "/api/session/ses_q/question") return route.fulfill({ json: { data: [question] } })
    if (/^\/api\/session\/[^/]+\/permission/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event") {
      const call = eventCalls++
      const batch = events[call]
      if (batch) {
        await gate()
        return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse(batch) })
      }
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    }
    return route.fulfill({ status: 404, json: {} })
  })

  return { release }
}

test("an open tool group stays open when the chat refetches", async ({ page }) => {
  const { release } = await openSessionWithEvents(page, [[{ type: "message.updated", data: { sessionID: "ses_q" } }]])
  await page.goto("/")

  const group = page.locator(".fc-toolgroup-line")
  await expect(group).toBeVisible()
  await group.click()
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await page.locator(".fc-tool-header").click()
  await expect(page.locator(".fc-tool-body")).toBeVisible()

  await release(0)
  await page.waitForTimeout(600)
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".fc-tool-body")).toBeVisible()
})

test("the question free-text answer survives a refetch", async ({ page }) => {
  const { release } = await openSessionWithEvents(page, [
    [{ type: "message.updated", data: { sessionID: "ses_q" } }],
    [{ type: "question.v2.asked", data: { sessionID: "ses_q" } }],
  ])
  await page.goto("/")

  await page.getByRole("button", { name: /Other/ }).click()
  const custom = page.getByPlaceholder("Custom answer")
  await custom.fill("hola")

  // A transcript refetch and a repeated question event both leave the answer untouched.
  await release(0)
  await page.waitForTimeout(600)
  await expect(custom).toHaveValue("hola")

  await release(1)
  await page.waitForTimeout(600)
  await expect(custom).toHaveValue("hola")
})
