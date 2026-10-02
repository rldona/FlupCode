import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * The folders a caller may name, as a real OpenCode 2 engine knows them (TI-11): its projects, a
 * folder opened a moment ago, and the worktrees it made. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/project-roots.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const made: string[] = []
let contract: ContractEngine
let repository: SqliteRoutineRepository
let scheduler: RoutineScheduler
let handler: ReturnType<typeof createHarnessHandler>

beforeAll(async () => {
  if (!run) return
  contract = await startEngine({ modelUrl: model.url })
  repository = new SqliteRoutineRepository(":memory:")
  scheduler = new RoutineScheduler({ repository, engineURL: contract.url, authorization: contract.authorization })
  handler = createHarnessHandler(repository, scheduler)
}, 120_000)

afterAll(async () => {
  repository?.close()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
  await contract?.stop()
  model.stop()
})

const folder = (name: string) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `flupcode-roots-${name}-`)))
  made.push(directory)
  return directory
}

const read = (directory: string, path: string) =>
  handler(new Request(`http://x/harness/files/read?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`))

describe.skipIf(!run)("project roots on an OpenCode 2 engine", () => {
  test("the engine's project reads, the filesystem root does not", async () => {
    writeFileSync(join(contract.project, "a.txt"), "a\n")
    expect((await read(contract.project, "a.txt")).status).toBe(200)
    expect((await read("/", "etc/hosts")).status).toBe(403)
    expect((await read("/etc", "hosts")).status).toBe(403)
  })

  test("a folder is refused until a session opens it, and read straight after", async () => {
    const directory = folder("later")
    writeFileSync(join(directory, "b.txt"), "b\n")
    expect((await read(directory, "b.txt")).status).toBe(403)
    await scheduler.engine.createSession({ directory })
    const after = await read(directory, "b.txt")
    expect(after.status).toBe(200)
    expect(((await after.json()) as { data: { content: string } }).data.content).toBe("b\n")
  })

  test("a worktree the engine made reads like its project", async () => {
    const directory = folder("git")
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: directory })
    git(["init", "-q", "-b", "main"])
    writeFileSync(join(directory, "c.txt"), "c\n")
    git(["add", "-A"])
    git(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "first"])
    await scheduler.engine.createSession({ directory })
    const worktree = await scheduler.engine.createWorktree({ directory, name: "roots" })
    expect(worktree.directory.startsWith(directory)).toBe(false)
    expect((await read(worktree.directory, "c.txt")).status).toBe(200)
  })

  test("a link in a project that points out of it is refused", async () => {
    const outside = folder("outside")
    writeFileSync(join(outside, "secret.txt"), "secret\n")
    symlinkSync(join(outside, "secret.txt"), join(contract.project, "leak.txt"))
    const refused = await read(contract.project, "leak.txt")
    expect(refused.status).toBe(400)
    expect(await refused.text()).not.toContain("secret\n")
  })
})
