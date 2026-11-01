import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_attach",
  projectID: "p",
  title: "Extractos",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const message = {
  id: "msg_1",
  type: "assistant",
  time: { created: now },
  agent: "build",
  content: [{ type: "text", text: "Listo" }],
  model: { providerID: "openai", id: "gpt" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

/** A session open in the composer, which is all an attachment needs. */
async function openSession(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_attach"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_attach/message")
      return route.fulfill({ json: { data: [message], cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox|children)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

const pdf = (body: string) => ({
  name: "extracto.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(body),
})

/** RC4-128 with an empty user password: the bank statement case. */
const EMPTY_PASSWORD = Buffer.from(
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGVmNGExNjU0OWI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA0MQo+PgpzdHJlYW0KjbSi/xunlbRvKWUvbZ5sIWFXJ5X6P6tGqXXXNFeIasSg6FwlKOOLIhAKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw0ODcxODUyZTI3ZjIwODYyY2IxZmViYjg2YjMzNWUxM2UwYTg3OWE5NDk0YzJjYTQ4OThkN2M5ZGUyMmQwZTc4PgovVSA8MWI5MzcwZTZkOTNjMDI5MWFhNmEyOGNjZjhhZTAxYjIyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjc3IDAwMDAwIG4gCjAwMDAwMDAzNjggMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA3Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNDY1NjM2MzYzMzczNTY2MzIzMjY1NjYzNjM1NjQzMjY0MzQ2MzM1MzMzODM0NjY2MzY0NjU2MjM1MzEzNjMzPiA8MzQ2NTYzNjM2MzM3MzU2NjMyMzI2NTY2MzYzNTY0MzI2NDM0NjMzNTMzMzgzNDY2NjM2NDY1NjIzNTMxMzYzMz4gXQovRW5jcnlwdCA2IDAgUgo+PgpzdGFydHhyZWYKNTgzCiUlRU9GCg==",
  "base64",
)

/** The same page with the user password "secreto". */
const NEEDS_PASSWORD = Buffer.from(
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGNmN2I2ZGM1OGY+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA0MQo+PgpzdHJlYW0KwsVT2SCKPNpsqHPFfPeiOTMbJctyOaxjDtWAGHF+tKfedjtbaUwdQhEKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDwxM2FiYTgwMjBjZjNlZDBiMTA1MWZiYTBlMTQzMWU3ZmNlYzgyZmUwNjMyNTFhMGE4ODgxNjNiM2VlNDBlNzJkPgovVSA8YTU2ZjZjOTUxYWYxZmU5MWZlMDk5ODgzYWM1MzY5NTUyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjc3IDAwMDAwIG4gCjAwMDAwMDAzNjggMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA3Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNDY1NjM2MzYzMzczNTY2MzIzMjY1NjYzNjM1NjQzMjY0MzQ2MzM1MzMzODM0NjY2MzY0NjU2MjM1MzEzNjMzPiA8MzQ2NTYzNjM2MzM3MzU2NjMyMzI2NTY2MzYzNTY0MzI2NDM0NjMzNTMzMzgzNDY2NjM2NDY1NjIzNTMxMzYzMz4gXQovRW5jcnlwdCA2IDAgUgo+PgpzdGFydHhyZWYKNTgzCiUlRU9GCg==",
  "base64",
)

test("a plain PDF attaches", async ({ page }) => {
  await openSession(page)
  await page.locator(".fc-file-input").setInputFiles(pdf("%PDF-1.4\ntrailer << /Root 1 0 R >>"))
  await expect(page.locator(".fc-dock-attachment")).toHaveCount(1)
})

test("a PDF with an empty user password is unlocked and attached", async ({ page }) => {
  await openSession(page)
  await page.locator(".fc-file-input").setInputFiles({ name: "extracto.pdf", mimeType: "application/pdf", buffer: EMPTY_PASSWORD })

  await expect(page.locator(".fc-dock-attachment")).toHaveCount(1)
  await expect(page.locator(".fc-toast-title")).toContainText(/PDF unlocked|PDF desbloqueado/i)
})

test("a PDF that asks for a password is refused instead of failing the session", async ({ page }) => {
  await openSession(page)
  await page
    .locator(".fc-file-input")
    .setInputFiles({ name: "extracto.pdf", mimeType: "application/pdf", buffer: NEEDS_PASSWORD })

  // It never becomes an attachment: the engine would fail this turn and every later one.
  await expect(page.locator(".fc-dock-attachment")).toHaveCount(0)
  await expect(page.locator(".fc-toast-title")).toContainText(/encrypted PDFs|PDF cifrados/i)
  await expect(page.locator(".fc-toast-description")).toContainText("extracto.pdf")
})
