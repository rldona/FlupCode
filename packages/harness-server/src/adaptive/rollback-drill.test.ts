/**
 * Rollback drills (FH-083, ADR-0022 §5): "back to off without residue".
 *
 * Each switch is exercised against the real seam it gates, and the drill asserts a negative that a
 * claim alone cannot: a byte-identical prompt or system array, and no new row, proposal or file. The
 * restore drills prove archive-not-delete — a snapshot goes back through the single writer byte for
 * byte, and an archived folder keeps its `SKILL.md`, sidecar, ledger and `.versions/` so moving it
 * back is lossless. No network and no model: the decision service is the real one, only config-off.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAdaptiveConfig } from "./config"
import { createContextManager } from "./context-manager"
import { createDecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { createLearningManager } from "./learning/manager"
import { createGovernor } from "./providers/governor"
import { createRelevanceService } from "./relevance"
import { createShadowRunner } from "./shadow"
import { createSkillCurator } from "./skills/curator"
import { createLearnedStore, VERSIONS_DIR } from "./skills/learned-store"
import type { RuntimeCapabilities } from "./runtime"
import { renderRunPrompt, runPromptParts } from "../runner"
import { SqliteRoutineRepository } from "../repository"

const NOW = 1_700_000_000_000
/** A fixed key so opaque ids are stable; nothing is written outside the in-memory store. */
const KEY = Buffer.alloc(32, 7)
const PROJECT = "/work/project"

/** Temp project trees the drills create, removed once each test is done with them. */
const temporary: string[] = []
const scratch = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const configFor = (block: unknown = {}) => resolveAdaptiveConfig({ block, env: {} })

/** The real decision path, constructed for every drill; with a feature off it is never reached. */
const harness = (block: unknown = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = configFor(block)
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({ repository, config: () => config, egress, governor, now: () => NOW })
  return { repository, config, egress, service }
}

const legacyCapabilities: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: NOW,
}

const terminalEpisode = (repository: SqliteRoutineRepository, projectID = PROJECT) =>
  repository.createEpisode(
    {
      sessionID: "ses_1",
      projectID,
      objective: "fix the bug",
      toolCalls: 6,
      files: [],
      commands: [],
      failures: [],
      verifications: [],
      outcome: "success",
      startedAt: NOW - 1_000,
      endedAt: NOW,
      evidenceRefs: [],
    },
    NOW,
  )

describe("rollback: a kill switch leaves the prompt and the store as they were", () => {
  test("context.apply=false leaves the run prompt byte-identical, even with a plan that archived", async () => {
    const { repository, config, egress, service } = harness({ context: { apply: false } })
    const manager = createContextManager({
      repository,
      service,
      config: () => config,
      egress,
      opaqueKey: () => KEY,
      now: () => NOW,
    })
    const parts = runPromptParts({ objective: "fix the bug", artifacts: ["@artifact:report"], memory: "- remember" })
    const plan = await manager.plan({ parts, objective: "fix the bug", runID: "run-1", taskID: "task-1", now: NOW })
    expect(plan!.archive.length).toBeGreaterThan(0)

    const untouched = renderRunPrompt(parts)
    const applied = renderRunPrompt(manager.apply({ parts, plan }))
    expect(applied.text).toBe(untouched.text)
    expect(applied.files).toEqual(untouched.files)
    repository.close()
  })

  test("relevance off returns a null line, adds nothing to the system array and writes no decision", async () => {
    const { repository, config, service } = harness()
    const relevance = createRelevanceService({
      service,
      curator: { roster: () => [{ name: "testing", description: "d", learned: false }] },
      runtimeProbe: { capabilities: () => legacyCapabilities },
      config: () => config,
      now: () => NOW,
    })
    const result = await relevance.suggest({ projectID: PROJECT, sessionID: "ses_1", messageID: "msg_1", objective: "fix it" })
    expect(result.line).toBeNull()
    expect(result.reason).toBe("disabled")
    expect(repository.listDecisions()).toHaveLength(0)

    // The plugin only pushes `result.line` when it is a string; a null line leaves the array as it was.
    const system = ["base"]
    const before = [...system]
    if (result.line !== null) system.push(result.line)
    expect(system).toEqual(before)
    repository.close()
  })

  test("the master switch off writes no decision or plan, while the episode is still captured", () => {
    const { repository, config, service } = harness({ enabled: false })
    const context = createContextManager({
      repository,
      service,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      opaqueKey: () => KEY,
      now: () => NOW,
    })
    const shadow = createShadowRunner({ service, repository, config: () => config, context })
    const episode = terminalEpisode(repository)

    expect(shadow.sweep()).toBe(0)
    expect(repository.listDecisions()).toHaveLength(0)
    expect(repository.listPlans()).toHaveLength(0)
    // The episode store is the base harness: it is untouched by the adaptive kill switch.
    expect(repository.getEpisode(episode.id)).toBeDefined()
    expect(repository.listEpisodes()).toHaveLength(1)
    repository.close()
  })

  test("shadow off writes no decision or plan, while the episode is still captured", () => {
    const { repository, config, egress, service } = harness({ shadow: false })
    const context = createContextManager({ repository, service, config: () => config, egress, opaqueKey: () => KEY, now: () => NOW })
    const shadow = createShadowRunner({ service, repository, config: () => config, context })
    const episode = terminalEpisode(repository)

    // `shadow=false` stops the episode decisions and plans, not the base episode store and not the
    // relevance line, which keeps its own flag.
    expect(shadow.sweep()).toBe(0)
    expect(repository.listDecisions()).toHaveLength(0)
    expect(repository.listPlans()).toHaveLength(0)
    expect(repository.getEpisode(episode.id)).toBeDefined()
    repository.close()
  })

  test("learning off writes no job, proposal or learned file, even with a terminal episode", () => {
    const project = scratch("fc-rollback-learn-")
    const { repository, config, egress, service } = harness({ learning: { enabled: false } })
    const store = createLearnedStore({ env: {}, enabled: () => config.learning.enabled })
    const curator = createSkillCurator({ store, enabled: () => config.learning.enabled })
    const learning = createLearningManager({
      repository,
      service,
      config: () => config,
      egress,
      curator,
      drafter: { draft: async () => undefined },
      now: () => NOW,
    })
    terminalEpisode(repository, project)

    expect(learning.sweep()).toBe(0)
    expect(repository.listReflectionJobs()).toHaveLength(0)
    expect(repository.listProposals()).toHaveLength(0)
    // No learned skill was written under the project's scannable root.
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned"))).toBe(false)
    repository.close()
  })
})

describe("rollback: archive is a move, and a version is restorable through the single writer", () => {
  test("restoring a snapshot body through the writer is byte-identical, and the pool keeps its bytes", () => {
    const project = scratch("fc-rollback-store-")
    const store = createLearnedStore({ env: {} })
    const skillDir = join(project, ".opencode", "skills", "flupcode-learned", "fix")
    const pool = join(project, ".opencode", "flupcode-learned-archive", "fix")

    const created = store.write({ projectID: project, name: "fix", description: "Use when fixing", body: "First body." })
    expect(created.ok).toBe(true)
    const firstContent = readFileSync(join(skillDir, "SKILL.md"))

    // A patch snapshots the body it replaces: the snapshot is the v1 file, byte for byte.
    expect(store.write({ projectID: project, name: "fix", description: "Use when fixing", body: "Second body." }).ok).toBe(
      true,
    )
    const versions = readdirSync(join(skillDir, VERSIONS_DIR))
    expect(versions).toHaveLength(1)
    expect(readFileSync(join(skillDir, VERSIONS_DIR, versions[0]!)).equals(firstContent)).toBe(true)

    // Restore the snapshot's body through the single writer: the new SKILL.md is the old one again.
    const restored = store.write({ projectID: project, name: "fix", description: "Use when fixing", body: "First body." })
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(skillDir, "SKILL.md")).equals(firstContent)).toBe(true)
    expect(store.readSidecar(project, "fix")!.version).toBe(3)

    // Archive is a move: the folder leaves `skills/` and lands in the pool with its bytes preserved.
    const liveContent = readFileSync(join(skillDir, "SKILL.md"))
    const snapshotsBeforeArchive = readdirSync(join(skillDir, VERSIONS_DIR)).sort()
    expect(store.archive({ projectID: project, name: "fix", reason: "human-name-collision" }).ok).toBe(true)
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false)
    expect(readFileSync(join(pool, "SKILL.md")).equals(liveContent)).toBe(true)
    expect(JSON.parse(readFileSync(join(pool, ".sidecar.json"), "utf8"))).toMatchObject({ state: "archived" })
    expect(readFileSync(join(pool, ".ledger.jsonl"), "utf8")).toContain('"event":"archived"')
    // The snapshots travel with the move, so reviving is a lossless move back.
    expect(readdirSync(join(pool, VERSIONS_DIR)).sort()).toEqual(snapshotsBeforeArchive)
  })
})
