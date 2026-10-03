import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { BrowserError } from "./browser-driver"
import { NavigationBlockedError } from "./browser-egress"
import { createBrowserPolicy } from "./browser-policy"
import {
  PREVIEW_HOST_PATH,
  PREVIEW_PROTOCOL,
  createPreview,
  createPreviewCapture,
  previewSocket,
  withPreviewHost,
} from "./browser-preview"
import { PNG, fakeDesktop } from "./browser-preview.fixture"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import { RoutineScheduler } from "./scheduler"
import type { RunSource } from "./types"

/**
 * The desktop preview's driver, routes and verify capture (BU-06).
 *
 * The desktop is stood in for by `fakeDesktop`: it answers the commands the real main process answers
 * (`preview.ts` in harness-desktop), and keeps main's own rule that a page off this machine loads only
 * once it was allowed. Everything above it, the driver, the policy, the routes, the runner, is real.
 */

const UI = "ui-token"
const scratch: string[] = []
const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))
afterAll(() => scratch.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const folder = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(directory)
  return directory
}

function subject() {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const dataDir = folder("flupcode-preview-data-")
  const preview = createPreview({ repository, dataDir, platform: "linux" })
  const desktop = fakeDesktop()
  desktop.attach(preview)
  return { repository, preview, desktop, dataDir, policy: createBrowserPolicy(repository) }
}

describe("the preview as a browser driver (BU-06)", () => {
  test("it drives the desktop's one page: a tab, a snapshot with refs, input by CDP", async () => {
    const { preview, desktop } = subject()
    const driver = preview.driver
    await driver.open({ id: "s1", project: "/work", sessionID: "s1" })
    const list = await driver.tabs.list("s1")
    const tab = list.focusedTabID!
    expect(tab).toMatch(/^tab_[a-f0-9-]{36}$/)
    expect(list.tabs).toEqual([
      { id: tab, url: "http://localhost:5173/", title: "Dev app", loading: false, canGoBack: false, canGoForward: false, generation: 0 },
    ])

    const snapshot = await driver.tabs.snapshot("s1", tab)
    expect(snapshot.content).toContain('- textbox "Email" [ref=e2]')
    expect(snapshot.content).toContain('- button "Send" [ref=e3]')

    await driver.tabs.act("s1", tab, { kind: "type", ref: "e2", text: "me@example.com" })
    expect(desktop.cdp("DOM.focus")).toEqual([{ backendNodeId: 11 }])
    expect(desktop.cdp("Input.dispatchKeyEvent")[0]).toMatchObject({ commands: ["selectAll"], modifiers: 2 })
    expect(desktop.cdp("Input.insertText")).toEqual([{ text: "me@example.com" }])

    await driver.tabs.act("s1", tab, { kind: "click", ref: "e3" })
    // The middle of the element's box, pressed and released there.
    expect(desktop.cdp("Input.dispatchMouseEvent").map((event) => [event.type, event.x, event.y])).toEqual([
      ["mouseMoved", 20, 30],
      ["mousePressed", 20, 30],
      ["mouseReleased", 20, 30],
    ])

    await driver.tabs.act("s1", tab, { kind: "key", key: "Enter" })
    expect(desktop.cdp("Input.dispatchKeyEvent").at(-2)).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" })

    // A field is the only thing typed into, and a ref is only good until the page moves on.
    await expect(driver.tabs.act("s1", tab, { kind: "type", ref: "e3", text: "x" })).rejects.toMatchObject({ code: "not_editable" })
    await driver.tabs.act("s1", tab, { kind: "navigate", url: "http://localhost:5173/next" })
    expect((await driver.tabs.list("s1")).tabs[0]?.generation).toBe(1)
    await expect(driver.tabs.act("s1", tab, { kind: "click", ref: "e3" })).rejects.toMatchObject({ code: "stale_ref" })
    // There is one tab, and it is not the agent's to close.
    await expect(driver.tabs.focus("s1", "tab_other")).rejects.toMatchObject({ code: "tab_unavailable" })
    expect((await driver.tabs.close("s1", tab)).tabs).toHaveLength(1)
  })

  test("a site off this machine is held to the egress guard before main is asked, and allowed to main first", async () => {
    const { preview, desktop } = subject()
    await expect(preview.show("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(NavigationBlockedError)
    await expect(preview.show("http://10.0.0.5:3000/")).rejects.toBeInstanceOf(NavigationBlockedError)
    await expect(preview.show("file:///etc/passwd")).rejects.toBeInstanceOf(NavigationBlockedError)
    expect(desktop.commands.filter((entry) => entry.method === "navigate" || entry.method === "allow")).toEqual([])

    // A public address literal, so the guard needs no DNS.
    await preview.show("http://93.184.215.14/")
    expect(desktop.commands.map((entry) => entry.method)).toEqual(["allow", "navigate"])
    expect(desktop.allowed).toEqual(new Set(["http://93.184.215.14"]))
  })

  test("a screenshot is a file in the harness's folder and an artifact of the session that took it", async () => {
    const { preview, repository, dataDir } = subject()
    await preview.driver.open({ id: "s1", project: "/work", sessionID: "s1" })
    const shot = await preview.driver.tabs.screenshot("s1", (await preview.driver.tabs.list("s1")).focusedTabID!)
    const artifact = repository.getArtifact(shot.artifactId)!
    expect(artifact).toMatchObject({ kind: "screenshot", mime: "image/png", producer: "harness", directory: dataDir, sessionID: "s1", title: "Dev app" })
    expect(existsSync(shot.path)).toBe(true)
    expect(shot.bytes).toBe(PNG.byteLength)
  })

  test("without the desktop there is no preview: nothing opens, and what was waiting fails", async () => {
    const { preview, desktop } = subject()
    await preview.driver.open({ id: "s1", project: "/work" })
    expect(preview.driver.get("s1")).toBeDefined()
    preview.disconnect(desktop.socket)
    expect(preview.connected()).toBe(false)
    expect(preview.driver.get("s1")).toBeUndefined()
    await expect(preview.driver.open({ id: "s2", project: "/work" })).rejects.toMatchObject({ code: "preview_unavailable" })
    await expect(preview.show("http://localhost:3000/")).rejects.toBeInstanceOf(BrowserError)
  })

  test("a second desktop replaces the first", () => {
    const { preview, desktop } = subject()
    const other = fakeDesktop()
    other.attach(preview)
    expect(desktop.socket.closed).toBe(4000)
    // What the replaced one says is not listened to.
    preview.receive(desktop.socket, JSON.stringify({ event: "state", state: { url: "http://localhost:1/", title: "old" } }))
    expect(preview.current()?.url).not.toBe("http://localhost:1/")
  })
})

describe("the person's preview routes (BU-06)", () => {
  const route = (handler: (request: Request) => Promise<Response> | Response, path: string, body?: unknown, token = UI) =>
    handler(
      new Request(`http://127.0.0.1:4097/harness/preview${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  const harness = () => {
    const setup = subject()
    const scheduler = new RoutineScheduler({ repository: setup.repository, engineURL: "http://127.0.0.1:1" })
    const handler = createHarnessHandler(setup.repository, scheduler, {
      token: UI,
      preview: { host: setup.preview, policy: setup.policy },
    })
    return { ...setup, handler }
  }

  test("a page on this machine opens; any other site asks first, through the browser policy", async () => {
    const { handler, desktop, repository } = harness()
    const local = await route(handler, "/navigate", { url: "http://127.0.0.1:3000/" })
    expect(local.status).toBe(200)
    expect(desktop.page.url).toBe("http://127.0.0.1:3000/")
    // Loopback is the preview's own ground: no decision to write down.
    expect(repository.listBrowserAudit({ limit: 10 })).toEqual([])

    const away = await route(handler, "/navigate", { url: "http://93.184.215.14/docs", sessionID: "s1" })
    expect(away.status).toBe(409)
    expect(await away.json()).toMatchObject({
      code: "approval_required",
      approval: {
        origin: "http://93.184.215.14",
        site: "93.184.215.14",
        tier: "navigate",
        options: [
          { value: "once", label: "Allow once" },
          { value: "session", label: "Allow for this session" },
          { value: "always", label: "Always allow to open and read pages on 93.184.215.14" },
          { value: "deny", label: "Deny" },
        ],
      },
    })
    // Asked, and nothing opened.
    expect(desktop.page.url).toBe("http://127.0.0.1:3000/")
    expect(desktop.allowed.size).toBe(0)
    expect(repository.listBrowserAudit({ limit: 10 })[0]).toMatchObject({ kind: "decision", decision: "ask", action: "preview.navigate" })
  })

  test("the person's answer grants what they picked, and the page opens on a yes", async () => {
    const { handler, desktop, policy } = harness()
    const denied = await route(handler, "/answer", { url: "http://93.184.215.14/docs", answer: "deny" })
    expect(denied.status).toBe(403)
    expect(desktop.page.url).toBe("http://localhost:5173/")

    const once = await route(handler, "/answer", { url: "http://93.184.215.14/docs", answer: "once" })
    expect(once.status).toBe(200)
    expect(desktop.page.url).toBe("http://93.184.215.14/docs")
    // Once is not a grant: the next visit asks again.
    expect((await route(handler, "/navigate", { url: "http://93.184.215.14/again" })).status).toBe(409)

    expect((await route(handler, "/answer", { url: "http://93.184.215.14/", answer: "always" })).status).toBe(200)
    expect(policy.grants()).toMatchObject([{ origin: "http://93.184.215.14", tier: "navigate", scope: "always" }])
    const again = await route(handler, "/navigate", { url: "http://93.184.215.14/later" })
    expect(again.status).toBe(200)
    expect(desktop.page.url).toBe("http://93.184.215.14/later")
  })

  test("a blocked site is refused, whatever the answer; the preview needs the app's token", async () => {
    const { handler, desktop } = harness()
    const pay = await route(handler, "/navigate", { url: "https://www.paypal.com/" })
    expect(pay.status).toBe(403)
    expect((await route(handler, "/answer", { url: "https://www.paypal.com/", answer: "always" })).status).toBe(403)
    expect(desktop.allowed.size).toBe(0)
    expect((await route(handler, "/navigate", { url: "http://localhost:3000/" }, "wrong")).status).toBe(403)
    expect((await route(handler, "", undefined, "wrong")).status).toBe(403)
  })

  test("the status says whether the desktop hosts it; a marked-up picture becomes an artifact", async () => {
    const { handler, repository } = harness()
    expect(await (await route(handler, "")).json()).toMatchObject({ data: { connected: true } })
    const stored = await route(handler, "/annotation", {
      image: `data:image/png;base64,${PNG.toString("base64")}`,
      title: "Preview annotation: Dev app",
      sessionID: "s1",
    })
    expect(stored.status).toBe(201)
    const id = ((await stored.json()) as { data: { artifactID: string } }).data.artifactID
    expect(repository.getArtifact(id)).toMatchObject({ kind: "screenshot", sessionID: "s1", title: "Preview annotation: Dev app" })
    expect((await route(handler, "/annotation", { image: "data:text/html;base64,PGgxPg==" })).status).toBe(400)
  })
})

describe("a verify task captures the preview (BU-06)", () => {
  const engine = new Proxy({} as never, {
    get: () => () => {
      throw new Error("a verify task does not reach the engine")
    },
  })
  const manual: RunSource = { type: "manual" }

  const project = (yaml: string) => {
    const directory = folder("flupcode-preview-verify-")
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), yaml)
    return directory
  }

  test("the page the project names is captured into an artifact of the run and the task", async () => {
    const { repository, preview, policy, desktop } = subject()
    const directory = project("verify:\n  test: echo ok\npreview: http://localhost:5173/settings\n")
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "check", prompt: "", kind: "verify" }])
    const capture = createPreviewCapture({ preview, policy })
    await new TaskRunner(repository, engine, undefined, undefined, undefined, undefined, capture).execute(run, { directory })

    const [task] = repository.listTasks(run.id)
    expect(task!.status).toBe("success")
    expect(desktop.page.url).toBe("http://localhost:5173/settings")
    const shot = repository.listArtifacts({ runID: run.id }).find((artifact) => artifact.kind === "screenshot")
    expect(shot).toMatchObject({ taskID: task!.id, mime: "image/png", title: "check — preview of http://localhost:5173/settings" })
    expect(task!.output).toContain(`Preview: captured http://localhost:5173/settings as a screenshot (artifact ${shot!.id}).`)
    // Under the policy and in its audit, with the evidence it left.
    const audit = repository.listBrowserAudit({ runID: run.id })
    expect(audit.map((entry) => [entry.kind, entry.decision ?? entry.outcome])).toEqual(
      expect.arrayContaining([
        ["decision", "allow"],
        ["action", "success"],
      ]),
    )
    expect(audit.find((entry) => entry.kind === "action")?.artifactID).toBe(shot!.id)
  })

  test("a page off this machine, or no desktop, is said in the evidence and changes nothing else", async () => {
    const { repository, preview, policy, desktop } = subject()
    const capture = createPreviewCapture({ preview, policy })
    const away = await capture({ directory: project("preview: https://example.com/\n"), runID: "r", taskID: "t", name: "check" })
    expect(away).toMatchObject({ url: "https://example.com/", skipped: expect.stringContaining("not a page on this machine") })
    expect(await capture({ directory: project("verify:\n  test: echo ok\n"), runID: "r", taskID: "t", name: "check" })).toBeUndefined()

    preview.disconnect(desktop.socket)
    const directory = project("verify:\n  test: echo ok\npreview: http://localhost:5173/\n")
    const run = repository.startRun(manual, 1000)
    repository.addTasks(run.id, [{ name: "check", prompt: "", kind: "verify" }])
    await new TaskRunner(repository, engine, undefined, undefined, undefined, undefined, capture).execute(run, { directory })
    const [task] = repository.listTasks(run.id)
    expect(task!.status).toBe("success")
    expect(task!.output).toContain("Preview: http://localhost:5173/ was not captured: the desktop app's preview is not open.")
  })
})

describe("the desktop's connection (BU-06)", () => {
  test("only the desktop with the app's token becomes the host, over a real WebSocket", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    const preview = createPreview({ repository, dataDir: folder("flupcode-preview-ws-") })
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      websocket: previewSocket(preview),
      fetch: withPreviewHost(preview, UI, () => new Response("handler")),
    })
    const url = `ws://127.0.0.1:${server.port}${PREVIEW_HOST_PATH}`
    try {
      const refused = await fetch(`http://127.0.0.1:${server.port}${PREVIEW_HOST_PATH}`, {
        headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "sec-websocket-protocol": `${PREVIEW_PROTOCOL}, token.wrong` },
      })
      expect(refused.status).toBe(403)
      // A page always says where it is from; the desktop's main process does not.
      const fromPage = await fetch(`http://127.0.0.1:${server.port}${PREVIEW_HOST_PATH}`, {
        headers: { origin: "https://evil.example", upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "sec-websocket-protocol": `${PREVIEW_PROTOCOL}, token.${UI}` },
      })
      expect(fromPage.status).toBe(403)
      expect(await (await fetch(`http://127.0.0.1:${server.port}/harness/health`)).text()).toBe("handler")

      const socket = new WebSocket(url, [PREVIEW_PROTOCOL, `token.${UI}`])
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id: number; method: string }
        if (message.method === "state")
          socket.send(JSON.stringify({ id: message.id, result: { url: "http://localhost:5173/", title: "Over the wire" } }))
      }
      await new Promise((resolve) => socket.addEventListener("open", resolve))
      expect(socket.protocol).toBe(PREVIEW_PROTOCOL)
      for (let tries = 0; !preview.connected() && tries < 100; tries++) await Bun.sleep(10)
      const session = await preview.driver.open({ id: "s1", project: "/work" })
      expect(session.title).toBe("Over the wire")
      socket.close()
      for (let tries = 0; preview.connected() && tries < 100; tries++) await Bun.sleep(10)
      expect(preview.connected()).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
