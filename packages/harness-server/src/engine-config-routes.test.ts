import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const TOKEN = "test-token"
const repositories: SqliteRoutineRepository[] = []
let project = ""

/** A handler with the writer bearer, or without one when `token` is empty. */
const open = (token = TOKEN) => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return createHarnessHandler(repository, scheduler, token ? { token } : {})
}

const call = (
  handler: ReturnType<typeof createHarnessHandler>,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) =>
  handler(
    new Request(`http://x${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token ?? TOKEN}` },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "flupcode-engine-config-routes-"))
})

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  rmSync(project, { recursive: true, force: true })
})

test("a folder's config is read and patched through the writer bearer", async () => {
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ permission: { bash: "ask" } }))
  const handler = open()
  const query = `?scope=project&directory=${encodeURIComponent(project)}`

  const read = await call(handler, `/harness/engine-config${query}`)
  expect(await read.json()).toEqual({
    data: { path: join(project, "opencode.json"), config: { permission: { bash: "ask" } } },
  })

  const patched = await call(handler, "/harness/engine-config", {
    method: "PATCH",
    body: { scope: "project", directory: project, patch: { permission: { edit: "deny" } } },
  })
  expect(await patched.json()).toEqual({ data: { path: join(project, "opencode.json"), changed: true } })
  expect(JSON.parse(readFileSync(join(project, "opencode.json"), "utf8"))).toEqual({
    permission: { bash: "ask", edit: "deny" },
  })
})

test("a wrong bearer is refused, and without a configured one the writer does not exist", async () => {
  const body = { scope: "project", directory: project, patch: { share: "manual" } }
  expect((await call(open(), "/harness/engine-config", { method: "PATCH", body, token: "wrong" })).status).toBe(403)
  expect((await call(open(""), "/harness/engine-config", { method: "PATCH", body })).status).toBe(404)
})

test("a project scope without a folder, or a patch that is not an object, is a bad request", async () => {
  const handler = open()
  expect((await call(handler, "/harness/engine-config?scope=project")).status).toBe(400)
  const bad = await call(handler, "/harness/engine-config", { method: "PATCH", body: { scope: "global", patch: [] } })
  expect(bad.status).toBe(400)
})

test("the writer is announced with its bearer", async () => {
  const capabilities = async (handler: ReturnType<typeof createHarnessHandler>) =>
    ((await (await call(handler, "/harness/health")).json()) as { capabilities: string[] }).capabilities
  expect(await capabilities(open())).toContain("engine-config")
  expect(await capabilities(open(""))).not.toContain("engine-config")
})
