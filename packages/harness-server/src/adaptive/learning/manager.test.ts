import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skillReport } from "../../skills"
import { SqliteRoutineRepository } from "../../repository"
import type { AdaptiveConfig } from "../config"
import { resolveAdaptiveConfig } from "../config"
import type { DecisionKind, DecisionRequest, DecisionResult, DecisionSpec, SkillReflectionAnswer } from "../decision"
import { createAdaptiveEgressGuard } from "../egress"
import type { SessionEpisode } from "../episode"
import type { SkillDraft, SkillDraftRequest, SkillDrafter } from "./draft"
import type { SkillProposal } from "./proposal"
import type { ReflectionService } from "./manager"
import { REFLECTION_FAILED_REASON, createLearningManager } from "./manager"
import { handleProposalRequest } from "../learning-routes"
import { createLearnedStore } from "../skills/learned-store"
import { createSkillCurator } from "../skills/curator"

const NOW = 1_700_000_000_000

let root = ""
let home = ""
let configDirectory = ""
let xdg = ""
let project = ""
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-manager-"))
  home = join(root, "home")
  configDirectory = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  for (const directory of [home, configDirectory, xdg, project]) mkdirSync(directory, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = configDirectory
  process.env.XDG_CONFIG_HOME = xdg
  process.env.OPENCODE_TEST_HOME = home
  process.env.HOME = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const repository of repositories.splice(0)) repository.close()
  rmSync(root, { recursive: true, force: true })
})

const repositoryFor = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return repository
}

const store = () => createLearnedStore({ env: {} })
const curator = (created = store()) => createSkillCurator({ store: created })

const configFor = (over: Record<string, unknown> = {}): AdaptiveConfig =>
  resolveAdaptiveConfig({
    block: {
      jev: { enabled: true },
      egress: { projects: [project], kinds: { skillReflection: true } },
      learning: { enabled: true, minToolCalls: 5, model: "prov/small" },
      ...over,
    },
    env: {},
  })

const episode = (over: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id: "episode:run:1",
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
  evidenceRefs: ["episode:run:1"],
  timeCreated: 2,
  timeUpdated: 2,
  ...over,
})

const validDraft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "fix-failing-test",
  description: "Use when a test fails and the failing assertion is not obvious",
  body: "## Steps\n" + "Do the minimal thing carefully. ".repeat(10),
  ...over,
})

/** A learned skill the curator can install directly, for the lifecycle and patch tests. */
const skillProposal = (name: string, over: Partial<SkillProposal> = {}): SkillProposal => ({
  projectID: project,
  episodeID: `episode:run:${name}`,
  intent: "add",
  name,
  description: `Use when ${name} is needed`,
  body: validDraft().body,
  evidenceRefs: [`episode:run:${name}`],
  ...over,
})

const reflectionService = (input: {
  answer?: SkillReflectionAnswer
  fail?: boolean
  onCall?: () => void
  confidence?: number
}): ReflectionService => ({
  async predict<Q extends DecisionKind>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    input.onCall?.()
    if (input.fail) throw new Error("reflection failed")
    const answer = input.answer ?? { reusable: true, intent: "add" }
    const baseline = { reusable: false, intent: "add" } as DecisionSpec[Q]["answer"]
    return {
      kind: request.kind,
      answer: answer as DecisionSpec[Q]["answer"],
      source: "jev",
      provider: "fake",
      confidence: input.confidence ?? 0.9,
      probabilities: { reusable: 0.9 },
      latencyMs: 0,
      degraded: false,
      baseline,
      baselineRule: "no-reflection",
      inputsHash: "hash",
      decidedAt: NOW,
    }
  },
})

const drafters = () => {
  let calls = 0
  const drafter: SkillDrafter = {
    async draft() {
      calls += 1
      return validDraft()
    },
  }
  return { drafter, calls: () => calls }
}

const managerFor = (input: {
  repository: SqliteRoutineRepository
  service: ReflectionService
  config: AdaptiveConfig
  drafter: SkillDrafter
  curator?: ReturnType<typeof curator>
  onError?: (cause: unknown) => void
  smallModel?: () => string | undefined
  sweepLimit?: number
}) =>
  createLearningManager({
    repository: input.repository,
    service: input.service,
    config: () => input.config,
    egress: createAdaptiveEgressGuard({ config: () => input.config }),
    curator: input.curator ?? curator(),
    drafter: input.drafter,
    now: () => NOW,
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.smallModel ? { smallModel: input.smallModel } : {}),
    ...(input.sweepLimit !== undefined ? { sweepLimit: input.sweepLimit } : {}),
  })

/** The manager enqueues; a macrotask flushes every microtask the reflection awaits. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("the learning manager (FH-034)", () => {
  test("never blocks the session: it enqueues and returns before any work", () => {
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
    })
    expect(manager.onEpisodeClosed(episode())).toBeUndefined()
    // Nothing has been written synchronously; the reflection is a deferred task.
    expect(repository.getReflectionJob("episode:run:1")).toBeUndefined()
  })

  test("a below-threshold episode is skipped and costs no call", async () => {
    const repository = repositoryFor()
    let classification = 0
    const draft = drafters()
    const manager = managerFor({
      repository,
      service: reflectionService({ onCall: () => (classification += 1) }),
      config: configFor(),
      drafter: draft.drafter,
    })
    manager.onEpisodeClosed(episode({ toolCalls: 1 }))
    await settle()
    expect(classification).toBe(0)
    expect(draft.calls()).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "below-threshold",
    })
  })

  test("learning off is inert: no job and no call", async () => {
    const repository = repositoryFor()
    let classification = 0
    const manager = managerFor({
      repository,
      service: reflectionService({ onCall: () => (classification += 1) }),
      config: configFor({ learning: { enabled: false, minToolCalls: 5, model: "prov/small" } }),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(classification).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toBeUndefined()
  })

  test("the master kill switch stops the reflection too", async () => {
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor({ enabled: false }),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:run:1")).toBeUndefined()
  })

  test("at most one reflection per episode, even on a second close", async () => {
    const repository = repositoryFor()
    let classification = 0
    const manager = managerFor({
      repository,
      service: reflectionService({ onCall: () => (classification += 1) }),
      config: configFor(),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    manager.onEpisodeClosed(episode())
    await settle()
    expect(classification).toBe(1)
    expect(repository.listReflectionJobs()).toHaveLength(1)
    expect(repository.getReflectionJob("episode:run:1")?.status).toBe("done")
  })

  test("promotes a valid proposal into PROBATION and records the proposal", async () => {
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "done",
      reason: "promoted",
      decisionID: "skillReflection:episode:run:1",
      proposalID: "proposal:episode:run:1",
    })
    const proposal = repository.getProposal("proposal:episode:run:1")!
    expect(proposal).toMatchObject({ status: "promoted", intent: "add", name: "fix-failing-test" })
    expect(proposal.bodyHash).toHaveLength(64)
    expect(store().readSidecar(project, "fix-failing-test")).toMatchObject({ state: "probation", version: 1 })
    expect(skillReport(project, project).find((file) => file.name === "fix-failing-test")).toMatchObject({
      loaded: true,
      learned: true,
    })
  })

  test("rejects merge and drop without drafting", async () => {
    const repository = repositoryFor()
    for (const intent of ["merge", "drop"] as const) {
      const draft = drafters()
      const manager = managerFor({
        repository,
        service: reflectionService({ answer: { reusable: true, intent } }),
        config: configFor(),
        drafter: draft.drafter,
      })
      manager.onEpisodeClosed(episode({ id: `episode:run:${intent}` }))
      await settle()
      expect(repository.getReflectionJob(`episode:run:${intent}`)).toMatchObject({
        status: "skipped",
        reason: `unsupported-intent:${intent}`,
      })
      expect(repository.getProposal(`proposal:episode:run:${intent}`)).toBeUndefined()
      expect(draft.calls()).toBe(0)
    }
  })

  test("records a failure and leaves the episode unreflected", async () => {
    const repository = repositoryFor()
    const causes: unknown[] = []
    const manager = managerFor({
      repository,
      service: reflectionService({ fail: true }),
      config: configFor(),
      drafter: drafters().drafter,
      onError: (cause) => causes.push(cause),
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "failed",
      reason: REFLECTION_FAILED_REASON,
    })
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
    expect(causes).toHaveLength(1)
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned"))).toBe(false)
  })

  test("records no-model when none is resolvable, and never drafts", async () => {
    const repository = repositoryFor()
    const draft = drafters()
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor({ learning: { enabled: true, minToolCalls: 5 } }),
      drafter: draft.drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "no-model" })
    expect(draft.calls()).toBe(0)
  })

  test("egress denied is skipped and never classifies", async () => {
    const repository = repositoryFor()
    let classification = 0
    const manager = managerFor({
      repository,
      service: reflectionService({ onCall: () => (classification += 1) }),
      config: configFor({ egress: { projects: [project], kinds: { skillReflection: false } } }),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(classification).toBe(0)
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "egress-denied" })
  })

  test("the kill switch never deletes a skill already written", async () => {
    const created = store()
    const learned = curator(created)
    const written = learned.promote({
      projectID: project,
      episodeID: "episode:run:old",
      intent: "add",
      name: "already-learned",
      description: "Use when something already learned is needed",
      body: "## Steps\n" + "Keep this around. ".repeat(10),
      evidenceRefs: ["episode:run:old"],
    })
    expect(written.ok).toBe(true)
    const path = join(project, ".opencode", "skills", "flupcode-learned", "already-learned", "SKILL.md")
    const before = readFileSync(path, "utf8")

    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor({ learning: { enabled: false, minToolCalls: 5 } }),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(repository.getReflectionJob("episode:run:1")).toBeUndefined()
  })

  test("the sweep reflects a terminal episode that has no job", async () => {
    const repository = repositoryFor()
    repository.createEpisode(
      {
        id: "episode:run:swept",
        sessionID: "ses_swept",
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
        evidenceRefs: ["episode:run:swept"],
      },
      NOW,
    )
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
    })
    expect(manager.sweep()).toBe(1)
    await settle()
    expect(repository.getReflectionJob("episode:run:swept")?.status).toBe("done")
  })
})

/**
 * The refusals that stop short of a draft (FH-031/FH-032/FH-033). Each is recorded as a machine
 * reason on the job and leaves nothing behind: no proposal, no skill, no call past the door it failed.
 */
describe("the learning manager's refusals", () => {
  test("an inert classification is not a lesson: skipped not-reusable, no draft, no proposal", async () => {
    const repository = repositoryFor()
    const draft = drafters()
    const manager = managerFor({
      repository,
      service: reflectionService({ answer: { reusable: false, intent: "add" } }),
      config: configFor(),
      drafter: draft.drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "not-reusable",
      decisionID: "skillReflection:episode:run:1",
    })
    expect(draft.calls()).toBe(0)
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned"))).toBe(false)
  })

  test("a draft the model could not produce drops the proposal and writes nothing", async () => {
    const repository = repositoryFor()
    const failing: SkillDrafter = {
      async draft() {
        return undefined
      },
    }
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: failing,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "draft-failed",
      decisionID: "skillReflection:episode:run:1",
    })
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned"))).toBe(false)
  })

  test("a patch with no target is refused before any draft", async () => {
    const repository = repositoryFor()
    const draft = drafters()
    const manager = managerFor({
      repository,
      service: reflectionService({ answer: { reusable: true, intent: "patch" } }),
      config: configFor(),
      drafter: draft.drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "skipped", reason: "missing-target" })
    expect(draft.calls()).toBe(0)
    expect(repository.getProposal("proposal:episode:run:1")).toBeUndefined()
  })

  test("a rejected promotion stays reviewable with its reason and never touches the human skill", async () => {
    const repository = repositoryFor()
    const humanPath = join(project, ".opencode", "skills", "fix-failing-test", "SKILL.md")
    mkdirSync(join(humanPath, ".."), { recursive: true })
    writeFileSync(humanPath, "---\nname: fix-failing-test\ndescription: A human skill\n---\n\nDo the human thing.\n")
    const before = readFileSync(humanPath, "utf8")

    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    const proposal = repository.getProposal("proposal:episode:run:1")!
    expect(proposal).toMatchObject({ status: "rejected", reason: "name-collision", name: "fix-failing-test" })
    // The drafted text survives the rejection: the proposal is what a person reviews.
    expect(proposal.body).toBeTruthy()
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({
      status: "skipped",
      reason: "name-collision",
      proposalID: "proposal:episode:run:1",
    })
    expect(readFileSync(humanPath, "utf8")).toBe(before)
  })

  test("the sweep walks only terminal episodes with no job, and is inert when learning is off", () => {
    const repository = repositoryFor()
    const input = {
      sessionID: "ses_swept",
      projectID: project,
      objective: "Fix the failing test",
      toolCalls: 8,
      files: ["src/a.ts"],
      commands: [],
      failures: [],
      verifications: [{ step: "test", ok: true }],
      evidenceRefs: [],
      startedAt: 1,
    }
    // A live episode (no `endedAt`) is never reflected; a terminal one that already has a job is not
    // reflected twice. The job is the durable "already tried", so the sweep converges on zero.
    repository.createEpisode({ ...input, id: "episode:run:live" }, NOW)
    repository.createEpisode({ ...input, id: "episode:run:done", endedAt: 2 }, NOW)
    repository.createReflectionJob({ episodeID: "episode:run:done", projectID: project, status: "done", attempts: 1 }, NOW)

    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
    })
    expect(manager.sweep()).toBe(0)
    expect(repository.getReflectionJob("episode:run:live")).toBeUndefined()

    const inert = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor({ learning: { enabled: false, minToolCalls: 5 } }),
      drafter: drafters().drafter,
    })
    expect(inert.sweep()).toBe(0)
  })
})

describe("the manager drives the learned-skill lifecycle (FH-042)", () => {
  const numbers = { probationSample: 1, staleAfter: 1, archiveAfter: 1 }

  /** A terminal episode with a job, so the sweep discovers its project without reflecting again. */
  const seedTerminalEpisode = (repo: SqliteRoutineRepository) => {
    repo.createEpisode(
      {
        id: "episode:run:seed",
        sessionID: "ses_seed",
        projectID: project,
        objective: "Seed a project the sweep can see",
        toolCalls: 8,
        files: ["src/a.ts"],
        commands: [],
        failures: [],
        verifications: [{ step: "test", ok: true }],
        outcome: "success",
        startedAt: 1,
        endedAt: 2,
        evidenceRefs: ["episode:run:seed"],
      },
      NOW,
    )
    repo.createReflectionJob({ episodeID: "episode:run:seed", projectID: project, status: "done", attempts: 1 }, NOW)
  }

  test("graduates a used skill and archives an unused one by move, and is inert with learning off", () => {
    const created = store()
    const skills = createSkillCurator({ store: created, config: () => numbers })
    expect(skills.promote(skillProposal("selected-skill")).ok).toBe(true)
    expect(skills.promote(skillProposal("unused-skill")).ok).toBe(true)

    const repository = repositoryFor()
    seedTerminalEpisode(repository)
    const manager = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor(),
      drafter: drafters().drafter,
      curator: skills,
    })

    skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded: ["selected-skill"] })
    manager.sweep()
    expect(store().readSidecar(project, "selected-skill")).toMatchObject({ state: "mature" })
    expect(store().readSidecar(project, "unused-skill")).toMatchObject({ state: "stale" })

    skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded: ["selected-skill"] })
    manager.sweep()
    // Archive is a move: the unused skill left `skills/` for the archive root.
    expect(store().readSidecar(project, "unused-skill")).toBeUndefined()
    expect(existsSync(join(project, ".opencode", "flupcode-learned-archive", "unused-skill", "SKILL.md"))).toBe(true)

    // With learning off the sweep returns before the lifecycle: nothing moves.
    const inert = managerFor({
      repository,
      service: reflectionService({}),
      config: configFor({ learning: { enabled: false, minToolCalls: 5, model: "prov/small" } }),
      drafter: drafters().drafter,
      curator: skills,
    })
    expect(inert.sweep()).toBe(0)
    expect(store().readSidecar(project, "selected-skill")).toMatchObject({ state: "mature" })
  })
})

describe("a patch drafts from the current skill (FH-041, ADR-0019 §5)", () => {
  test("the drafter receives the current body and the re-read counts as a view", async () => {
    const created = store()
    const skills = createSkillCurator({ store: created })
    expect(skills.promote(skillProposal("existing-skill")).ok).toBe(true)
    const currentBody = store().read(project, "existing-skill")!.body

    let seen: SkillDraftRequest | undefined
    const drafter: SkillDrafter = {
      async draft(input) {
        seen = input
        return validDraft()
      },
    }
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      service: reflectionService({ answer: { reusable: true, intent: "patch", target: "existing-skill" } }),
      config: configFor(),
      drafter,
      curator: skills,
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(seen?.existing?.body).toBe(currentBody)
    expect(seen?.existing?.description).toBe(skillProposal("existing-skill").description)
    // The re-read is the harness opening the body, which is what 3b counts as a `view`.
    expect(store().readSidecar(project, "existing-skill")).toMatchObject({
      state: "probation",
      version: 2,
      usage: { view: 1, patch: 1 },
    })
    expect(repository.getReflectionJob("episode:run:1")).toMatchObject({ status: "done", reason: "promoted" })
  })
})

describe("a secret in the drafted name or description never reaches the row (FH-033)", () => {
  const secret = `sk-ant-${"A".repeat(24)}`

  test("a description is redacted before the row and the review route", async () => {
    const repository = repositoryFor()
    const drafter: SkillDrafter = {
      async draft() {
        return { name: "safe-skill", description: `Use when ${secret} is configured`, body: validDraft().body }
      },
    }
    const manager = managerFor({ repository, service: reflectionService({}), config: configFor(), drafter })
    manager.onEpisodeClosed(episode())
    await settle()

    const proposal = repository.getProposal("proposal:episode:run:1")!
    expect(proposal.description ?? "").not.toContain(secret)
    expect(proposal.description).toContain("[REDACTED]")

    const response = await handleProposalRequest(
      new Request("http://x/harness/adaptive/proposals/proposal:episode:run:1"),
      ["proposals", "proposal:episode:run:1"],
      repository,
    )
    expect(JSON.stringify(await response.json())).not.toContain(secret)
  })

  test("a secret in the name is redacted before the row", async () => {
    const repository = repositoryFor()
    const drafter: SkillDrafter = {
      async draft() {
        return { name: secret, description: validDraft().description, body: validDraft().body }
      },
    }
    const manager = managerFor({ repository, service: reflectionService({}), config: configFor(), drafter })
    manager.onEpisodeClosed(episode())
    await settle()

    const proposal = repository.getProposal("proposal:episode:run:1")!
    expect(proposal.name ?? "").not.toContain(secret)
    // The redacted name no longer matches the skill shape, so the proposal is refused and reviewable.
    expect(proposal.status).toBe("rejected")
    expect(proposal.reason).toBe("invalid-name")
  })
})
