import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, expect, test } from "@playwright/test"

/**
 * A web app tab pairing with a real harness server (HE-01). The app is opened at a name mapped to
 * 127.0.0.1, so its origin is not a loopback one: the harness treats it as FlupCode's hosted app
 * (`FLUPCODE_WEB_ORIGINS` names it, the way `app.flupcode.com` is named by default) and answers it
 * nothing but pairing until it holds a paired token. The harness is the real one, from source, on
 * temporary folders; the engine is mocked in the page, as everywhere in this suite.
 */
const WEBSITE = "http://app.flupcode.test:4173"

let harness: ChildProcess | undefined
let root = ""
let harnessUrl = ""

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "flupcode-e2e-pairing-"))
  const port = await freePort()
  harnessUrl = `http://127.0.0.1:${port}`
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("FLUPCODE_") && !name.startsWith("XDG_")),
  )
  harness = spawn("bun", ["run", "./src/index.ts"], {
    cwd: fileURLToPath(new URL("../../harness-server", import.meta.url)),
    env: {
      ...env,
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      OPENCODE_CONFIG_DIR: join(root, "opencode"),
      FLUPCODE_CONFIG_DIR: join(root, "flupcode"),
      FLUPCODE_HARNESS_DB: join(root, "harness.sqlite"),
      FLUPCODE_HARNESS_PORT: String(port),
      FLUPCODE_ENGINE_URL: "http://127.0.0.1:9",
      FLUPCODE_BROWSER_DISABLED: "1",
      FLUPCODE_WEB_ORIGINS: WEBSITE,
    },
    stdio: "ignore",
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const healthy = await fetch(`${harnessUrl}/harness/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (healthy) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("the harness server did not start")
})

test.afterAll(() => {
  harness?.kill("SIGTERM")
  rmSync(root, { recursive: true, force: true })
})

/** What `flupcode pair` and the terminal do: the UI's token from the config folder, no origin. */
const asTerminal = (path: string, init: { method: string; body?: unknown }) =>
  fetch(`${harnessUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${readFileSync(join(root, "flupcode", "browser-token"), "utf8").trim()}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

const pairingCode = async () =>
  ((await (await asTerminal("/harness/pair/codes", { method: "POST" })).json()) as { data: { code: string } }).data.code

test("an unpaired tab says what is missing, pairs with one code, and stays paired across a reload", async () => {
  await asTerminal("/harness/routines", {
    method: "POST",
    body: { name: "Nightly check", description: "", prompt: "Look at CI", schedule: { type: "manual" } },
  })
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP app.flupcode.test 127.0.0.1"] })
  const context = await browser.newContext({ permissions: ["local-network-access"] })
  const page = await context.newPage()
  await page.addInitScript((url) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify(url))
  }, harnessUrl)
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  try {
    await page.goto(`${WEBSITE}/`)
    await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

    // Unpaired: the screen says why it is empty and where the code comes from.
    const card = page.locator(".fc-pairing")
    await expect(card).toBeVisible()
    await expect(card).toContainText(/not paired|no está emparejada/)
    await expect(card).toContainText("flupcode pair")
    await expect(card).toContainText(/local network|red local/)

    // A wrong code is refused and said so.
    await card.getByLabel(/Pairing code|Código de emparejamiento/).fill("AAAA-AAAA")
    await card.getByRole("button", { name: /^(Pair|Emparejar)$/ }).click()
    await expect(card.locator(".fc-pairing-error")).toContainText(/wrong, used or expired|incorrecto/)

    // The code `flupcode pair` printed pairs the tab: the card goes, Runs shows what the harness says.
    await card.getByLabel(/Pairing code|Código de emparejamiento/).fill(await pairingCode())
    await card.getByRole("button", { name: /^(Pair|Emparejar)$/ }).click()
    await expect(card).toHaveCount(0)
    await expect(page.locator(".fc-runs-empty")).toBeVisible()

    // The token lived in memory only; the refresh cookie brings it back after a reload.
    await page.reload()
    await page.goto(`${WEBSITE}/routines`)
    await expect(page.locator(".fc-routines-screen")).toContainText("Nightly check")
    await expect(page.locator(".fc-pairing")).toHaveCount(0)
    const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }))
    expect(stored).not.toMatch(/token/i)

    // Unpaired from the terminal: the next load asks for a code again.
    await asTerminal("/harness/pair/tabs", { method: "DELETE" })
    await page.reload()
    await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()
    await expect(page.locator(".fc-pairing")).toBeVisible()
  } finally {
    await browser.close()
  }
})
