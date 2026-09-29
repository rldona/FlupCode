/**
 * The FH-024 seam: the run prompt is assembled from parts, planned best-effort, and filtered only
 * when applying is on.
 *
 * The one thing this test guards above all is byte-identity: with `apply=false`, with the kill
 * switch, or when planning fails, the prompt a task receives is exactly the one it would receive
 * with no context manager at all. Both paths go through the one renderer in `runner.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compose, renderRunPrompt, runPromptParts, TaskRunner } from "../runner"
import { SqliteRoutineRepository } from "../repository"
import type { RunSource } from "../types"
import { resolveAdaptiveConfig } from "./config"
import type { AdaptiveConfig } from "./config"
import { createContextManager } from "./context-manager"
import type { ContextManagerDeps } from "./context-manager"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"

const NOW = 1_700_000_000_000
const KEY = Buffer.alloc(32, 7)

const scratch: string[] = []
afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const manual: RunSource = { type: "manual" }
const open = () => new SqliteRoutineRepository(":memory:")
const configFor = (block: unknown = {}) => resolveAdaptiveConfig({ block, env: {} })

const managerFor = (repository: SqliteRoutineRepository, config: AdaptiveConfig, extra: Partial<ContextManagerDeps> = {}) => {
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const service = createDecisionService({ repository, config: () => config, egress, now: () => NOW })
  return createContextManager({
    repository,
    service,
    config: () => config,
    egress,
    opaqueKey: () => KEY,
    now: () => NOW,
    ...extra,
  })
}

/** An engine that records what each task was told, and answers so a handoff exists for the next. */
const recorder = (sent: Array<{ text: string; files?: Array<{ path: string }> }>) =>
  ({
    createSession: async () => ({ id: `ses_${sent.length}` }),
    prompt: async (input: { text: string; files?: Array<{ path: string }> }) => void sent.push(input),
    waitForIdle: async () => undefined,
    lastAnswer: async () => ({ text: "previous answer", tokens: 10, cost: 0.01 }),
  }) as never

const scratchDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-context-run-"))
  scratch.push(directory)
  return directory
}

/**
 * A run of two tasks over a directory with a memory note, a pack file and an artifact to quote.
 *
 * The objective names the file, so the file is referenced and kept; the memory, the artifact and the
 * handoff are not, so a selection that is on archives them. The directory is shared by the runs this
 * test compares, so the file path is byte-identical too.
 */
const scenario = (repository: SqliteRoutineRepository, directory: string) => {
  mkdirSync(join(directory, "src"), { recursive: true })
  writeFileSync(join(directory, "src", "answers.ts"), "export const answers = 42\n")
  repository.addProjectMemory({ directory, text: "Use the server, not the browser" })
  const artifact = repository.addArtifact({
    kind: "report",
    title: "Run report",
    producer: "harness",
    content: "Everything passed",
    directory,
  })
  repository.savePack({ name: "ctx", refs: ["@src/answers.ts", `@artifact:${artifact.id}`], directory })
  const run = repository.startRun(manual, 1000, directory, { packs: ["ctx"] })
  repository.addTasks(run.id, [
    { name: "one", prompt: "Update src/answers.ts" },
    { name: "two", prompt: "Update src/answers.ts" },
  ])
  return { run, directory }
}

const runWith = async (repository: SqliteRoutineRepository, directory: string, context?: ReturnType<typeof managerFor>) => {
  const { run } = scenario(repository, directory)
  const sent: Array<{ text: string; files?: Array<{ path: string }> }> = []
  await new TaskRunner(repository, recorder(sent), undefined, undefined, context).execute(run, { directory })
  return sent
}

describe("runPromptParts and the one renderer (FH-024)", () => {
  test("renderRunPrompt is byte-identical to the prompt compose always produced", () => {
    expect(
      renderRunPrompt(runPromptParts({ objective: "Do it", handoff: "Previous", artifacts: ["@artifact:report"], memory: "- remember" }))
        .text,
    ).toBe(
      "Project memory:\n- remember\n\nContext packs:\n@artifact:report\n\nPrevious step (complete):\nPrevious\n\nDo it",
    )
    expect(compose({ prompt: "Do it" } as never, "Previous", "@artifact:report", "- remember")).toBe(
      "Project memory:\n- remember\n\nContext packs:\n@artifact:report\n\nPrevious step (complete):\nPrevious\n\nDo it",
    )
  })

  test("carries the handoff, the memory, the artifacts and the files, and truncates a long handoff", () => {
    const long = "x".repeat(4_100)
    const parts = runPromptParts({
      objective: "Do it",
      handoff: long,
      artifacts: ["a", "b"],
      memory: "- one\n- two",
      files: [{ path: "/p/a.ts" }, { path: "/p/b.ts" }],
    })
    const { text, files } = renderRunPrompt(parts)
    expect(text).toContain("Previous step (truncated):")
    expect(text).toContain("x".repeat(4_000))
    expect(text).not.toContain("x".repeat(4_001))
    expect(text).toContain("Project memory:\n- one\n- two")
    expect(text).toContain("Context packs:\na\nb")
    expect(text).toContain("Do it")
    expect(files).toEqual([{ path: "/p/a.ts" }, { path: "/p/b.ts" }])
  })

  test("an objective with no head is rendered alone, as compose did", () => {
    expect(renderRunPrompt(runPromptParts({ objective: "Just do it" })).text).toBe("Just do it")
    expect(compose({ prompt: "Just do it" } as never, undefined)).toBe("Just do it")
  })

  test("an empty artifact ref turns no header on, byte-identically to compose", () => {
    // `compose` guarded its head with truthiness; an empty ref must not become a "Context packs:"
    // header with nothing under it.
    expect(renderRunPrompt(runPromptParts({ objective: "Do it", artifacts: [""] })).text).toBe("Do it")
    expect(compose({ prompt: "Do it" } as never, undefined, "")).toBe("Do it")
  })

  test("a mixed empty and non-empty artifact ref keeps the historical join, byte for byte", () => {
    // `compose` joined the refs first and decided the header on the joined result, so `["", "@x"]`
    // produced a leading blank line. Filtering each part separately would have dropped it.
    const refs = ["", "@artifact:x"]
    expect(renderRunPrompt(runPromptParts({ objective: "Do it", artifacts: refs })).text).toBe(
      `Context packs:\n${refs.join("\n")}\n\nDo it`,
    )
    expect(renderRunPrompt(runPromptParts({ objective: "Do it", artifacts: refs })).text).toBe(
      "Context packs:\n\n@artifact:x\n\nDo it",
    )
  })
})

describe("TaskRunner context seam (FH-024)", () => {
  test("with a manager but applying off, the prompt is byte-identical to no manager at all", async () => {
    const directory = scratchDirectory()
    const plainRepository = open()
    const plain = await runWith(plainRepository, directory)

    const repository = open()
    const withContext = await runWith(repository, directory, managerFor(repository, configFor()))

    expect(withContext).toEqual(plain)
    // And it is the full assembly, not an empty one.
    expect(withContext[0]!.text).toContain("Project memory:")
    expect(withContext[0]!.text).toContain("Context packs:")
    expect(withContext[0]!.files?.map((file) => file.path)).toHaveLength(1)
    // The second task is the one handed what the first concluded.
    expect(withContext[1]!.text).toContain("Previous step")
    plainRepository.close()
    repository.close()
  })

  test("a handoff past the 4000 cap is truncated byte-identically with the manager off", async () => {
    const directory = scratchDirectory()
    const long = "y".repeat(4_500)
    const runLength = async (repository: SqliteRoutineRepository, context?: ReturnType<typeof managerFor>) => {
      const { run } = scenario(repository, directory)
      const sent: Array<{ text: string; files?: Array<{ path: string }> }> = []
      let created = 0
      const engine = {
        createSession: async () => ({ id: `ses_${++created}` }),
        prompt: async (input: { text: string; files?: Array<{ path: string }> }) => void sent.push(input),
        waitForIdle: async () => undefined,
        lastAnswer: async () => ({ text: long, tokens: 10, cost: 0.01 }),
      } as never
      await new TaskRunner(repository, engine, undefined, undefined, context).execute(run, { directory })
      return sent
    }
    const plainRepository = open()
    const plain = await runLength(plainRepository)

    const repository = open()
    const withContext = await runLength(repository, managerFor(repository, configFor()))

    expect(withContext).toEqual(plain)
    expect(withContext[1]!.text).toContain("Previous step (truncated):")
    expect(withContext[1]!.text).toContain(long.slice(0, 4_000))
    expect(withContext[1]!.text).not.toContain(long.slice(0, 4_001))
    plainRepository.close()
    repository.close()
  })

  test("with applying on, whole parts are removed and the protected memory and file stay", async () => {
    const directory = scratchDirectory()
    const repository = open()
    const sent = await runWith(repository, directory, managerFor(repository, configFor({ context: { apply: true } })))

    // The objective and the memory (both protected) and the referenced file stay; the handoff and
    // the artifact are archived. No reordering, no rewriting.
    expect(sent[0]!.text).toBe("Project memory:\n- Use the server, not the browser\n\nUpdate src/answers.ts")
    expect(sent[0]!.files?.map((file) => file.path)).toEqual([join(directory, "src", "answers.ts")])
    repository.close()
  })

  test("marks the plan applied only when it actually filtered the prompt", async () => {
    const directory = scratchDirectory()
    // Applying on: the artifact is archived, so the plan filtered and must read as applied.
    const appliedRepository = open()
    await runWith(appliedRepository, directory, managerFor(appliedRepository, configFor({ context: { apply: true } })))
    const applied = appliedRepository.listPlans()
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.every((plan) => plan.applied)).toBe(true)

    // Shadow only: nothing is filtered, so every plan stays `applied: false`.
    const shadowRepository = open()
    await runWith(shadowRepository, directory, managerFor(shadowRepository, configFor()))
    const shadowed = shadowRepository.listPlans()
    expect(shadowed.length).toBeGreaterThan(0)
    expect(shadowed.every((plan) => !plan.applied)).toBe(true)
    appliedRepository.close()
    shadowRepository.close()
  })

  test("applying is reversible: the plan can be ignored and the full prompt restored", async () => {
    const directory = scratchDirectory()
    const plainRepository = open()
    const full = await runWith(plainRepository, directory)

    const repository = open()
    const dropped = await runWith(repository, directory, managerFor(repository, configFor({ context: { apply: true } })))
    expect(dropped[0]!.text).not.toBe(full[0]!.text)

    const restoredRepository = open()
    const restored = await runWith(restoredRepository, directory, managerFor(restoredRepository, configFor()))
    expect(restored[0]!.text).toBe(full[0]!.text)
    plainRepository.close()
    repository.close()
    restoredRepository.close()
  })

  test("a scorer failure is a no-op: the run renders exactly as before", async () => {
    const directory = scratchDirectory()
    const repository = open()
    const failing = managerFor(repository, configFor(), {
      classify: () => {
        throw new Error("classification boom")
      },
    })
    const sent = await runWith(repository, directory, failing)
    expect(repository.listPlans()).toHaveLength(0)

    const plainRepository = open()
    const expected = await runWith(plainRepository, directory)
    expect(sent).toEqual(expected)
    plainRepository.close()
    repository.close()
  })

  test("the kill switch is a no-op and writes nothing", async () => {
    const directory = scratchDirectory()
    const repository = open()
    const sent = await runWith(repository, directory, managerFor(repository, configFor({ enabled: false })))
    expect(repository.listPlans()).toHaveLength(0)

    const plainRepository = open()
    const expected = await runWith(plainRepository, directory)
    expect(sent).toEqual(expected)
    plainRepository.close()
    repository.close()
  })
})
