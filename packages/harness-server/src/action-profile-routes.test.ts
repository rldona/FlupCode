import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const TOKEN = "test-token"
let root = ""
let config = ""
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

const profile = () => ({
  tool: "do_publish",
  kind: "browser",
  origin: "https://example.com",
  steps: [{ goto: "{{origin}}/" }],
})

const open = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  const handler = createHarnessHandler(repository, scheduler, { token: TOKEN })
  return handler
}

const call = (
  handler: ReturnType<typeof createHarnessHandler>,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) =>
  handler(
    new Request(`http://x${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.token === undefined ? { authorization: `Bearer ${TOKEN}` } : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-action-profile-routes-"))
  config = join(root, "config")
  mkdirSync(config, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_CONFIG_HOME = join(root, "xdg")
  process.env.OPENCODE_TEST_HOME = join(root, "home")
})

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("the action profile routes", () => {
  test("require the bearer", async () => {
    const handler = open()
    const refused = await call(handler, "/harness/action-profiles", { token: "wrong" })
    expect(refused.status).toBe(403)
  })

  test("list, write and remove a global profile", async () => {
    const handler = open()

    expect((await (await call(handler, "/harness/action-profiles")).json()).data).toEqual([])

    const written = await call(handler, "/harness/action-profiles/publish", {
      method: "PUT",
      body: { scope: "global", profile: profile() },
    })
    expect(written.status).toBe(201)
    expect((await written.json()).data).toMatchObject({ id: "publish", scope: "global" })

    const listed = (await (await call(handler, "/harness/action-profiles")).json()).data
    expect(listed).toMatchObject([{ id: "publish", scope: "global" }])

    const removed = await call(handler, "/harness/action-profiles/publish?scope=global", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((await removed.json()).data).toMatchObject({ removed: true })

    const gone = await call(handler, "/harness/action-profiles/publish?scope=global", { method: "DELETE" })
    expect(gone.status).toBe(404)
  })

  test("a broken profile is refused with 422", async () => {
    const handler = open()
    const refused = await call(handler, "/harness/action-profiles/publish", {
      method: "PUT",
      body: { scope: "global", profile: { tool: "do_x", kind: "api" } },
    })
    expect(refused.status).toBe(422)
    expect((await refused.json()).code).toBe("unsupported_kind")
  })

  test("a project profile is written to the project's .opencode", async () => {
    const handler = open()
    const written = await call(handler, "/harness/action-profiles/local", {
      method: "PUT",
      body: { scope: "project", project: root, directory: root, profile: profile() },
    })
    expect(written.status).toBe(201)
    expect((await written.json()).data.path).toBe(join(root, ".opencode", "opencode.jsonc"))
  })
})
