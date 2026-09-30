import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"
import type { AdaptiveConfig } from "../config"
import { resolveAdaptiveConfig } from "../config"
import { adaptiveConfigView } from "../config-surface"
import type { DecisionKind, DecisionRequest, DecisionResult, DecisionSpec, SkillReflectionAnswer } from "../decision"
import { createAdaptiveEgressGuard } from "../egress"
import type { SessionEpisode } from "../episode"
import type { SkillDrafter } from "./draft"
import type { ReflectionService } from "./manager"
import { createLearningManager } from "./manager"
import type { StoredSkillProposalInput } from "./proposal-record"
import { createProposalReview } from "./review"
import { createLearnedStore } from "../skills/learned-store"
import type { SkillRosterEntry } from "../skills/curator"
import { createSkillCurator } from "../skills/curator"
import { DAY_MS, WEEK_MS, blockingLimit, learningLimitStatus, reachedLimits } from "./limits"

const NOW = 1_700_000_000_000

let root = ""
let project = ""
let other = ""
const repositories: SqliteRoutineRepository[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-limits-"))
  project = join(root, "project")
  other = join(root, "other")
  for (const directory of [project, other]) mkdirSync(directory, { recursive: true })
})

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  rmSync(root, { recursive: true, force: true })
})

const repositoryFor = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return repository
}

const configFor = (learning: Record<string, unknown> = {}): AdaptiveConfig =>
  resolveAdaptiveConfig({
    block: {
      jev: { enabled: true },
      egress: { projects: [project, other], kinds: { skillReflection: true } },
      learning: { enabled: true, minToolCalls: 5, model: "prov/small", ...learning },
    },
    env: {},
  })

const episode = (id: string, over: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id,
  sessionID: "ses_1",
  projectID: project,
  objective: "Fix the failing test",
  toolCalls: 8,
  files: ["src/a.ts"],
  commands: [],
  failures: [],
  verifications: [{ step: "test", ok: true }],
  outcome: "success",
  startedAt: 1,
  endedAt: 2,
  evidenceRefs: [id],
  timeCreated: 2,
  timeUpdated: 2,
  ...over,
})

/** A stored proposal created at `at`, as a past reflection would have left it. */
const seed = (
  repository: SqliteRoutineRepository,
  id: string,
  at: number,
  over: Partial<StoredSkillProposalInput> = {},
) =>
  repository.createProposal(
    {
      id: `proposal:${id}`,
      episodeID: id,
      projectID: project,
      intent: "add",
      name: `skill-${id.replace(/[^a-z0-9]/g, "")}`,
      evidenceRefs: [id],
      status: "rejected",
      reason: "human-rejected",
      ...over,
    },
    at,
  )

const learned = (count: number): SkillRosterEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    name: index === 0 ? "existing-skill" : `learned-${index}`,
    description: "Use when it is needed",
    learned: true,
  }))

const reflectionService = (answer: SkillReflectionAnswer, onCall?: () => void): ReflectionService => ({
  async predict<Q extends DecisionKind>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    onCall?.()
    return {
      kind: request.kind,
      answer: answer as DecisionSpec[Q]["answer"],
      source: "model",
      provider: "fake",
      confidence: 0.9,
      probabilities: { reusable: 0.9 },
      latencyMs: 0,
      degraded: false,
      baseline: { reusable: false, intent: "add" } as DecisionSpec[Q]["answer"],
      baselineRule: "no-reflection",
      inputsHash: "hash",
      decidedAt: NOW,
    }
  },
})

/** A drafter that names each draft after its call, so side-by-side drafts never collide. */
const drafters = (delay?: () => Promise<void>) => {
  let calls = 0
  const drafter: SkillDrafter = {
    async draft() {
      calls += 1
      const call = calls
      await delay?.()
      return {
        name: `drafted-skill-${call}`,
        description: "Use when a test fails and the failing assertion is not obvious",
        body: "## Steps\n" + "Do the minimal thing carefully. ".repeat(10),
      }
    },
  }
  return { drafter, calls: () => calls }
}

const managerFor = (input: {
  repository: SqliteRoutineRepository
  config: AdaptiveConfig
  answer?: SkillReflectionAnswer
  drafter: SkillDrafter
  roster?: SkillRosterEntry[]
  onClassify?: () => void
  now?: () => number
}) => {
  const real = createSkillCurator({ store: createLearnedStore({ env: {} }) })
  return createLearningManager({
    repository: input.repository,
    service: reflectionService(input.answer ?? { reusable: true, intent: "add" }, input.onClassify),
    config: () => input.config,
    egress: createAdaptiveEgressGuard({ config: () => input.config }),
    curator: {
      roster: () => input.roster ?? [],
      check: real.check,
      readExisting: () => undefined,
      recompute: real.recompute,
      reconcile: real.reconcile,
    },
    drafter: input.drafter,
    now: input.now ?? (() => NOW),
  })
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("reachedLimits and blockingLimit (AH-F03)", () => {
  const limits = { proposalsPerDay: 2, maxLearnedSkills: 3, patchesPerWeek: 1 }

  test("the day window is rolling and its boundary is exact", () => {
    const repository = repositoryFor()
    seed(repository, "a", NOW - DAY_MS) // exactly one day ago: out
    seed(repository, "b", NOW - DAY_MS + 1) // one millisecond inside: in
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW })).toEqual([])
    seed(repository, "c", NOW - 1)
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW })).toEqual([
      { limit: "proposals-per-day", used: 2, max: 2 },
    ])
    // A millisecond later the older of the two leaves the window.
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW + 1 })).toEqual([])
  })

  test("the week window counts only patches, and its boundary is exact", () => {
    const repository = repositoryFor()
    seed(repository, "old", NOW - WEEK_MS, { intent: "patch", targetSkill: "existing-skill" })
    seed(repository, "add", NOW - 2 * DAY_MS)
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW })).toEqual([])
    seed(repository, "new", NOW - WEEK_MS + 1, { intent: "patch", targetSkill: "existing-skill" })
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW })).toEqual([
      { limit: "patches-per-week", used: 1, max: 1 },
    ])
  })

  test("learned skills count the installed ones plus adds waiting for review", () => {
    const repository = repositoryFor()
    seed(repository, "pending", NOW - 3 * WEEK_MS, { status: "proposed" })
    seed(repository, "pending-patch", NOW - 3 * WEEK_MS, { status: "proposed", intent: "patch", targetSkill: "x" })
    seed(repository, "closed", NOW - 3 * WEEK_MS)
    expect(reachedLimits({ repository, projectID: project, installedSkills: 1, limits, now: NOW })).toEqual([])
    expect(reachedLimits({ repository, projectID: project, installedSkills: 2, limits, now: NOW })).toEqual([
      { limit: "learned-skills", used: 3, max: 3 },
    ])
  })

  test("limits are per project", () => {
    const repository = repositoryFor()
    seed(repository, "a", NOW - 10)
    seed(repository, "b", NOW - 20)
    expect(reachedLimits({ repository, projectID: project, installedSkills: 0, limits, now: NOW })).toHaveLength(1)
    expect(reachedLimits({ repository, projectID: other, installedSkills: 0, limits, now: NOW })).toEqual([])
  })

  test("before the intent is known only a cap on every outcome blocks; after, the intent's own", () => {
    const day = { limit: "proposals-per-day" as const, used: 5, max: 5 }
    const skills = { limit: "learned-skills" as const, used: 20, max: 20 }
    const patches = { limit: "patches-per-week" as const, used: 5, max: 5 }
    expect(blockingLimit([])).toBeUndefined()
    expect(blockingLimit([day])).toBe("proposals-per-day")
    expect(blockingLimit([skills])).toBeUndefined()
    expect(blockingLimit([patches])).toBeUndefined()
    expect(blockingLimit([skills, patches])).toBe("learned-skills")
    expect(blockingLimit([skills], "add")).toBe("learned-skills")
    expect(blockingLimit([skills], "patch")).toBeUndefined()
    expect(blockingLimit([patches], "patch")).toBe("patches-per-week")
    expect(blockingLimit([patches], "add")).toBeUndefined()
    expect(blockingLimit([day], "patch")).toBe("proposals-per-day")
  })
})

describe("the manager honours the caps (AH-F03)", () => {
  test("at the daily cap no job is started: no classification, no draft, the reason on the job", async () => {
    const repository = repositoryFor()
    for (const id of ["a", "b", "c", "d", "e"]) seed(repository, id, NOW - 60_000)
    let classified = 0
    const draft = drafters()
    const manager = managerFor({ repository, config: configFor(), drafter: draft.drafter, onClassify: () => (classified += 1) })
    manager.onEpisodeClosed(episode("episode:run:1"))
    await settle()
    expect(classified).toBe(0)
    expect(draft.calls()).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "limit:proposals-per-day" })
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
  })

  test("the daily cap of one project does not stop another", async () => {
    const repository = repositoryFor()
    for (const id of ["a", "b"]) seed(repository, id, NOW - 60_000)
    const draft = drafters()
    const manager = managerFor({ repository, config: configFor({ limits: { proposalsPerDay: 2 } }), drafter: draft.drafter })
    manager.onEpisodeClosed(episode("episode:run:1"))
    manager.onEpisodeClosed(episode("episode:run:2", { projectID: other }))
    await settle()
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ reason: "limit:proposals-per-day" })
    expect(repository.getReflectionJob("episode:run:2")).toMatchObject({ status: "done", reason: "proposed" })
  })

  test("the window reopens a day later, not a millisecond sooner", async () => {
    const repository = repositoryFor()
    seed(repository, "a", NOW)
    const draft = drafters()
    let clock = NOW + DAY_MS - 1
    const manager = managerFor({
      repository,
      config: configFor({ limits: { proposalsPerDay: 1 } }),
      drafter: draft.drafter,
      now: () => clock,
    })
    manager.onEpisodeClosed(episode("episode:run:1"))
    await settle()
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ reason: "limit:proposals-per-day" })
    clock = NOW + DAY_MS
    manager.onEpisodeClosed(episode("episode:run:2"))
    await settle()
    expect(repository.getReflectionJob("episode:run:2")).toMatchObject({ status: "done", reason: "proposed" })
  })

  test("a project full of skills still patches them, and no new skill is drafted", async () => {
    const repository = repositoryFor()
    const config = configFor({ limits: { maxLearnedSkills: 2 } })
    const adds = drafters()
    managerFor({ repository, config, drafter: adds.drafter, roster: learned(2) }).onEpisodeClosed(episode("episode:run:1"))
    await settle()
    // The classification ran (a patch was still possible); the draft did not.
    expect(adds.calls()).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "limit:learned-skills",
      decisionID: "skillReflection:episode:run:1",
    })

    const patches = drafters()
    managerFor({
      repository,
      config,
      drafter: patches.drafter,
      roster: learned(2),
      answer: { reusable: true, intent: "patch", target: "existing-skill" },
    }).onEpisodeClosed(episode("episode:run:2"))
    await settle()
    expect(repository.getReflectionJob("episode:run:2")).toMatchObject({ status: "done", reason: "proposed" })
    expect(repository.getProposal("proposal:episode:run:2")).toMatchObject({ intent: "patch", status: "proposed" })
  })

  test("the weekly patch cap stops patches only, before the draft", async () => {
    const repository = repositoryFor()
    seed(repository, "p", NOW - 3 * DAY_MS, { intent: "patch", targetSkill: "existing-skill" })
    const config = configFor({ limits: { patchesPerWeek: 1 } })
    const patches = drafters()
    managerFor({
      repository,
      config,
      drafter: patches.drafter,
      roster: learned(1),
      answer: { reusable: true, intent: "patch", target: "existing-skill" },
    }).onEpisodeClosed(episode("episode:run:1"))
    await settle()
    expect(patches.calls()).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "limit:patches-per-week" })

    const adds = drafters()
    managerFor({ repository, config, drafter: adds.drafter, roster: learned(1) }).onEpisodeClosed(episode("episode:run:2"))
    await settle()
    expect(repository.getReflectionJob("episode:run:2")).toMatchObject({ status: "done", reason: "proposed" })
  })

  test("skills and patches both capped: nothing is classified", async () => {
    const repository = repositoryFor()
    seed(repository, "p", NOW - DAY_MS * 2, { intent: "patch", targetSkill: "existing-skill" })
    let classified = 0
    const manager = managerFor({
      repository,
      config: configFor({ limits: { maxLearnedSkills: 1, patchesPerWeek: 1 } }),
      drafter: drafters().drafter,
      roster: learned(1),
      onClassify: () => (classified += 1),
    })
    manager.onEpisodeClosed(episode("episode:run:1"))
    await settle()
    expect(classified).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ reason: "limit:learned-skills" })
  })

  test("reflections running side by side cannot overshoot the daily cap together", async () => {
    const repository = repositoryFor()
    // Every draft yields a macrotask, so all three pass the first count before any proposal exists.
    const draft = drafters(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    const manager = managerFor({ repository, config: configFor({ limits: { proposalsPerDay: 2 } }), drafter: draft.drafter })
    for (const id of ["episode:run:1", "episode:run:2", "episode:run:3"]) manager.onEpisodeClosed(episode(id))
    await settle()
    await settle()
    await settle()
    expect(draft.calls()).toBe(3)
    expect(repository.listProposals({ projectID: project })).toHaveLength(2)
    expect(repository.listReflectionJobs({ projectID: project }).map((job) => job.reason).sort()).toEqual([
      "limit:proposals-per-day",
      "proposed",
      "proposed",
    ])
  })
})

describe("freeze is not off (AH-F03)", () => {
  test("frozen: a qualifying episode is skipped `frozen` without any call", async () => {
    const repository = repositoryFor()
    let classified = 0
    const draft = drafters()
    const manager = managerFor({
      repository,
      config: configFor({ frozen: true }),
      drafter: draft.drafter,
      onClassify: () => (classified += 1),
    })
    manager.onEpisodeClosed(episode("episode:run:1"))
    manager.onEpisodeClosed(episode("episode:run:2", { toolCalls: 1 }))
    await settle()
    expect(classified).toBe(0)
    expect(draft.calls()).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "frozen" })
    // The deterministic gate still speaks first: a quiet episode is quiet whether or not it is frozen.
    expect(repository.getReflectionJob("episode:run:2")).toMatchObject({ status: "skipped", reason: "below-threshold" })
  })

  test("frozen keeps a staged proposal approvable; learning off does not", () => {
    const repository = repositoryFor()
    seed(repository, "staged", NOW - 1, {
      status: "proposed",
      name: "staged-skill",
      description: "Use when a test fails and the failing assertion is not obvious",
      body: "## Steps\n" + "Do the minimal thing carefully. ".repeat(10),
      reason: undefined,
    })
    const approveWith = (config: AdaptiveConfig) =>
      createProposalReview({
        repository,
        curator: createSkillCurator({
          store: createLearnedStore({ env: {}, enabled: () => config.learning.enabled }),
          enabled: () => config.learning.enabled,
        }),
        now: () => NOW,
      }).approve("proposal:staged")
    expect(approveWith(configFor({ enabled: false }))).toMatchObject({ ok: false, code: "disabled" })
    expect(repository.getProposal("proposal:staged")).toMatchObject({ status: "proposed" })
    expect(approveWith(configFor({ frozen: true }))).toMatchObject({ ok: true, changed: true })
  })
})

describe("the settings view reports the caps reached (AH-F03)", () => {
  test("per project, counted live, and nothing while learning is off", () => {
    const repository = repositoryFor()
    for (const id of ["a", "b", "c", "d", "e"]) seed(repository, id, NOW - 60_000)
    repository.createReflectionJob({ episodeID: "episode:run:x", projectID: project, status: "skipped", attempts: 1 }, NOW)
    repository.createReflectionJob({ episodeID: "episode:run:y", projectID: other, status: "done", attempts: 1 }, NOW)
    const status = (config: AdaptiveConfig) =>
      learningLimitStatus({ repository, installedSkills: () => 0, config: config.learning, now: NOW })
    expect(status(configFor())).toEqual([{ projectID: project, limit: "proposals-per-day", used: 5, max: 5 }])
    expect(status(configFor({ enabled: false }))).toEqual([])

    const view = adaptiveConfigView({
      block: {},
      env: {},
      resolved: configFor(),
      runtime: { runtime: "legacy", degraded: false, checkedAt: 0 },
      capabilities: {
        runtime: "legacy",
        degraded: false,
        canUseLegacyHooks: true,
        canInjectSystemPrompt: true,
        canObserveToolCalls: true,
        canObserveCompaction: true,
        canTransformMessages: true,
        canUseSdkPath: true,
        checkedAt: 0,
      },
      usage: { month: "2026-09", tokensSpent: 0, calls: 0, monthlyTokens: 1, hotReserveFraction: 0.2 },
      canWrite: true,
      writer: { path: "/tmp/opencode.jsonc", exists: false },
      learningLimits: status(configFor()),
    })
    expect(view.learningLimits.reached).toEqual([{ projectID: project, limit: "proposals-per-day", used: 5, max: 5 }])
    expect(view.effective.learning.limits).toEqual({ proposalsPerDay: 5, maxLearnedSkills: 20, patchesPerWeek: 5 })
  })
})
