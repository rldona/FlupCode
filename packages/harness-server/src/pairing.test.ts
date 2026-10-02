import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { PAIRED_TOKEN_TTL, PAIRING_ATTEMPTS, PAIRING_CODE_TTL, createPairing } from "./pairing"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const HOSTED = "https://app.flupcode.com"
const UI_TOKEN = "ui-token-from-the-config-dir"
const PLUGIN_TOKEN = "plugin-token"
const folders: string[] = []
afterAll(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

/** A harness with a UI token, a plugin token and pairing, on a clock the test moves. */
function open() {
  const folder = mkdtempSync(join(tmpdir(), "flupcode-pairing-"))
  folders.push(folder)
  const clock = { now: 1_000_000 }
  const file = join(folder, "paired-tabs.json")
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  const build = () =>
    createHarnessHandler(repository, scheduler, {
      token: UI_TOKEN,
      pluginToken: PLUGIN_TOKEN,
      pairing: createPairing({ file, now: () => clock.now }),
    })
  return { clock, file, repository, handler: build(), restart: build }
}

type Handler = ReturnType<typeof open>["handler"]

const call = (handler: Handler, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  handler(
    new Request(`http://127.0.0.1:4097${path}`, {
      method: init.method ?? "GET",
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

/** What `flupcode pair` does: the UI token, no origin. */
async function code(handler: Handler) {
  const response = await call(handler, "/harness/pair/codes", { method: "POST", headers: { authorization: `Bearer ${UI_TOKEN}` } })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { code: string; expiresAt: number } }).data
}

/** What the tab does with the code the reader typed. */
async function pair(handler: Handler, value: string, origin = HOSTED) {
  const response = await call(handler, "/harness/pair", { method: "POST", headers: { origin }, body: { code: value } })
  const body = (await response.json()) as { data?: { token: string; expiresAt: number }; code?: string }
  const cookie = response.headers.get("set-cookie") ?? ""
  return { response, body, cookie, refresh: /flupcode_pair=([^;]*)/.exec(cookie)?.[1] ?? "" }
}

const refresh = (handler: Handler, value: string, origin = HOSTED) =>
  call(handler, "/harness/pair/refresh", { method: "POST", headers: { origin, cookie: `flupcode_pair=${value}` } })

/** `null` is a caller with no origin at all, like curl. */
const runs = (handler: Handler, token: string | undefined, origin: string | null = HOSTED) =>
  call(handler, "/harness/runs", {
    headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })

describe("an unpaired hosted tab (HE-01)", () => {
  test("reads the health check and a refusal it can show, and nothing else", async () => {
    const { handler, repository } = open()
    const health = await call(handler, "/harness/health", { headers: { origin: HOSTED } })
    expect(health.status).toBe(200)
    expect(health.headers.get("access-control-allow-origin")).toBe(HOSTED)

    const refused = await runs(handler, undefined)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "invalid_token" })
    expect(refused.headers.get("access-control-allow-origin")).toBe(HOSTED)

    // Not even the UI's own token works from the hosted origin: only a paired one does.
    expect((await runs(handler, UI_TOKEN)).status).toBe(403)
    // And a mutation is refused before it runs.
    const created = await call(handler, "/harness/routines", {
      method: "POST",
      headers: { origin: HOSTED, authorization: `Bearer ${UI_TOKEN}` },
      body: { name: "x", prompt: "y", schedule: { type: "manual" } },
    })
    expect(created.status).toBe(403)
    expect(repository.list()).toHaveLength(0)
    repository.close()
  })

  test("an origin that is not FlupCode's web app cannot pair, and still reads nothing", async () => {
    const { handler, repository } = open()
    const { code: value } = await code(handler)
    const attempt = await pair(handler, value, "https://evil.example")
    expect(attempt.response.status).toBe(403)
    expect(attempt.response.headers.get("access-control-allow-origin")).toBeNull()
    // The code was not spent on it.
    expect((await pair(handler, value)).response.status).toBe(200)
    repository.close()
  })
})

describe("pairing codes", () => {
  test("only flupcode, with the UI token and no origin, can ask for one", async () => {
    const { handler, repository } = open()
    const asked = (headers: Record<string, string>) => call(handler, "/harness/pair/codes", { method: "POST", headers })
    expect((await asked({})).status).toBe(403)
    expect((await asked({ authorization: `Bearer ${PLUGIN_TOKEN}` })).status).toBe(403)
    // A page holding the UI token still cannot: a code is typed by a person, never fetched by a page.
    expect((await asked({ authorization: `Bearer ${UI_TOKEN}`, origin: "http://localhost:4444" })).status).toBe(403)
    const issued = await code(handler)
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    repository.close()
  })

  test("a code pairs one tab, once: replaying it fails", async () => {
    const { handler, repository } = open()
    const { code: value } = await code(handler)
    const first = await pair(handler, value.toLowerCase().replace("-", " "))
    expect(first.response.status).toBe(200)
    expect(first.response.headers.get("access-control-allow-origin")).toBe(HOSTED)
    expect(first.response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(first.cookie).toContain("HttpOnly")
    expect(first.cookie).toContain("SameSite=None")
    expect(first.cookie).toContain("Path=/harness/pair")

    const replay = await pair(handler, value)
    expect(replay.response.status).toBe(403)
    expect(replay.body.code).toBe("invalid_code")
    repository.close()
  })

  test("a code expires", async () => {
    const { handler, clock, repository } = open()
    const { code: value } = await code(handler)
    clock.now += PAIRING_CODE_TTL + 1
    expect((await pair(handler, value)).body.code).toBe("invalid_code")
    repository.close()
  })

  test("wrong codes are rate-limited, and while they are a right one is refused too", async () => {
    const { handler, clock, repository } = open()
    const { code: value } = await code(handler)
    for (let attempt = 0; attempt < PAIRING_ATTEMPTS; attempt++)
      expect((await pair(handler, "AAAA-AAAA")).body.code).toBe("invalid_code")
    const limited = await pair(handler, value)
    expect(limited.response.status).toBe(429)
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0)
    clock.now += 61_000
    expect((await pair(handler, value)).response.status).toBe(200)
    repository.close()
  })
})

describe("a paired tab's token", () => {
  test("has the UI's scope, from the origin that paired only", async () => {
    const { handler, repository } = open()
    const { body } = await pair(handler, (await code(handler)).code)
    const token = body.data!.token
    const listed = await runs(handler, token)
    expect(listed.status).toBe(200)
    expect(listed.headers.get("access-control-allow-origin")).toBe(HOSTED)
    // A routine can be created and fired from the tab.
    const created = await call(handler, "/harness/routines", {
      method: "POST",
      headers: { origin: HOSTED, authorization: `Bearer ${token}` },
      body: { name: "Paired", description: "", prompt: "Say hi", schedule: { type: "manual" } },
    })
    expect(created.status).toBe(201)

    // The same token from anywhere else is nothing: another page, or no page at all.
    expect((await runs(handler, token, "http://localhost:5173")).status).toBe(403)
    expect((await runs(handler, token, null)).status).toBe(403)
    // It cannot ask for codes or end pairings: that is the person at the terminal.
    const asked = await call(handler, "/harness/pair/codes", {
      method: "POST",
      headers: { origin: HOSTED, authorization: `Bearer ${token}` },
    })
    expect(asked.status).toBe(403)
    repository.close()
  })

  test("expires, and the refresh cookie gives a new one and a new cookie", async () => {
    const { handler, clock, repository } = open()
    const first = await pair(handler, (await code(handler)).code)
    clock.now += PAIRED_TOKEN_TTL + 1
    expect((await runs(handler, first.body.data!.token)).status).toBe(403)

    const renewed = await refresh(handler, first.refresh)
    expect(renewed.status).toBe(200)
    expect(renewed.headers.get("access-control-allow-credentials")).toBe("true")
    const next = /flupcode_pair=([^;]*)/.exec(renewed.headers.get("set-cookie") ?? "")?.[1]
    expect(next).toBeTruthy()
    expect(next).not.toBe(first.refresh)
    const token = ((await renewed.json()) as { data: { token: string } }).data.token
    expect((await runs(handler, token)).status).toBe(200)

    // The refresh cookie is the origin's too.
    expect((await refresh(handler, next!, "http://localhost:5173")).status).toBe(403)
    repository.close()
  })

  test("a refresh token replayed after it was traded ends the pairing", async () => {
    const { handler, clock, repository } = open()
    const first = await pair(handler, (await code(handler)).code)
    const renewed = await refresh(handler, first.refresh)
    const token = ((await renewed.json()) as { data: { token: string } }).data.token
    // A sibling tab racing the first is let through for a moment...
    expect((await refresh(handler, first.refresh)).status).toBe(200)
    clock.now += 31_000
    // ...but a copy used later is a replay: refused, and every token of that pairing with it.
    const replay = await refresh(handler, first.refresh)
    expect(replay.status).toBe(403)
    expect(await replay.json()).toMatchObject({ code: "not_paired" })
    expect(replay.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await runs(handler, token)).status).toBe(403)
    repository.close()
  })

  test("flupcode can end every pairing", async () => {
    const { handler, repository } = open()
    const tab = await pair(handler, (await code(handler)).code)
    const revoked = await call(handler, "/harness/pair/tabs", {
      method: "DELETE",
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    })
    expect(await revoked.json()).toEqual({ data: { revoked: 1 } })
    expect((await runs(handler, tab.body.data!.token)).status).toBe(403)
    expect((await refresh(handler, tab.refresh)).status).toBe(403)
    repository.close()
  })

  test("a restarted server forgets the token but keeps the pairing, in a private file", async () => {
    const { handler, restart, file, repository } = open()
    const tab = await pair(handler, (await code(handler)).code)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
    const again = restart()
    expect((await runs(again, tab.body.data!.token)).status).toBe(403)
    const renewed = await refresh(again, tab.refresh)
    expect(renewed.status).toBe(200)
    repository.close()
  })

  test("a preflight from the hosted app is answered, with credentials only for pairing", async () => {
    const { handler, repository } = open()
    const preflight = (path: string) =>
      call(handler, path, { method: "OPTIONS", headers: { origin: HOSTED } })
    const pairing = await preflight("/harness/pair")
    expect(pairing.headers.get("access-control-allow-origin")).toBe(HOSTED)
    expect(pairing.headers.get("access-control-allow-credentials")).toBe("true")
    const other = await preflight("/harness/runs")
    expect(other.headers.get("access-control-allow-origin")).toBe(HOSTED)
    expect(other.headers.get("access-control-allow-credentials")).toBeNull()
    repository.close()
  })
})

describe("FLUPCODE_WEB_ORIGINS", () => {
  test("names another place the web app is served from, under the same rules", async () => {
    const previous = process.env.FLUPCODE_WEB_ORIGINS
    process.env.FLUPCODE_WEB_ORIGINS = "http://app.flupcode.test:5555"
    try {
      const { handler, repository } = open()
      const origin = "http://app.flupcode.test:5555"
      expect((await runs(handler, undefined, origin)).status).toBe(403)
      const tab = await pair(handler, (await code(handler)).code, origin)
      expect((await runs(handler, tab.body.data!.token, origin)).status).toBe(200)
      repository.close()
    } finally {
      if (previous === undefined) delete process.env.FLUPCODE_WEB_ORIGINS
      else process.env.FLUPCODE_WEB_ORIGINS = previous
    }
  })
})
