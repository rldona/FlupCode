/**
 * The heuristic fallback inside the learning manager (AH-F01): with no model it stages a proposal
 * through the same claim, redaction, lint and `proposed` staging as a drafted one, and nothing is
 * installed until a person approves it (ADR-0022).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"
import type { AdaptiveConfig } from "../config"
import { resolveAdaptiveConfig } from "../config"
import type { DecisionKind, DecisionRequest, DecisionResult, DecisionSpec, SkillReflectionAnswer } from "../decision"
import { createAdaptiveEgressGuard } from "../egress"
import type { SessionEpisode } from "../episode"
import { createLearnedStore } from "../skills/learned-store"
import { createSkillCurator } from "../skills/curator"
import type { SkillDraft, SkillDrafter } from "./draft"
import type { TraceStep } from "./heuristics"
import type { ReflectionService } from "./manager"
import { createLearningManager } from "./manager"
import { createProposalReview } from "./review"

const NOW = 1_700_000_000_000

let root = ""
let project = ""
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-heuristics-"))
  project = join(root, "project")
  for (const directory of ["home", "config", "xdg"].map((name) => join(root, name)).concat(project)) {
    mkdirSync(directory, { recursive: true })
  }
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "HOME"]) saved[key] = process.env[key]
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  process.env.XDG_CONFIG_HOME = join(root, "xdg")
  process.env.OPENCODE_TEST_HOME = join(root, "home")
  process.env.HOME = join(root, "home")
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

/** Learning on and nothing else: no classifier, no drafting model, no egress consent. */
const noModel = (): AdaptiveConfig =>
  resolveAdaptiveConfig({ block: { learning: { enabled: true, minToolCalls: 5 } }, env: {} })

/** The full model path: Jev classifies with consent and a drafting model is resolved. */
const withModel = (): AdaptiveConfig =>
  resolveAdaptiveConfig({
    block: {
      jev: { enabled: true },
      egress: { projects: [project], kinds: { skillReflection: true } },
      learning: { enabled: true, minToolCalls: 5, model: "prov/small" },
    },
    env: {},
  })

const episode = (over: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id: "episode:session:ses_1",
  sessionID: "ses_1",
  projectID: project,
  objective: "Fix the failing math test",
  toolCalls: 8,
  files: ["src/math.ts"],
  commands: ["bun test src/math.test.ts"],
  failures: [{ summary: "expected 3, received 4", file: "src/math.test.ts", line: 3 }],
  verifications: [],
  outcome: "partial",
  startedAt: 1,
  endedAt: 2,
  evidenceRefs: ["session:ses_1"],
  timeCreated: 2,
  timeUpdated: 2,
  ...over,
})

const redFixGreen = (): TraceStep[] => [
  { tool: "bash", command: "bun test src/math.test.ts", exit: 1, ok: true, paths: [] },
  { tool: "edit", ok: true, paths: [join(project, "src/math.ts")] },
  { tool: "bash", command: "bun test src/math.test.ts", exit: 0, ok: true, paths: [] },
]

const service = (answer: SkillReflectionAnswer = { reusable: true, intent: "add" }, onCall?: () => void): ReflectionService => ({
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

const drafter = (draft?: SkillDraft): SkillDrafter => ({ draft: async () => draft })

const managerFor = (input: {
  repository: SqliteRoutineRepository
  config: AdaptiveConfig
  trace?: TraceStep[]
  service?: ReflectionService
  drafter?: SkillDrafter
  curator?: ReturnType<typeof createSkillCurator>
}) =>
  createLearningManager({
    repository: input.repository,
    service: input.service ?? service(),
    config: () => input.config,
    egress: createAdaptiveEgressGuard({ config: () => input.config }),
    curator: input.curator ?? createSkillCurator({ store: createLearnedStore({ env: {} }) }),
    drafter: input.drafter ?? drafter(),
    trace: () => input.trace ?? [],
    now: () => NOW,
  })

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const learnedPath = (name: string) => join(project, ".opencode", "skills", "flupcode-learned", name, "SKILL.md")

describe("heuristic reflection in the manager (AH-F01)", () => {
  test("without any model, a fix-verify episode stages a heuristic proposal and installs nothing", async () => {
    const repository = repositoryFor()
    let classifications = 0
    const manager = managerFor({
      repository,
      config: noModel(),
      trace: redFixGreen(),
      service: service(undefined, () => (classifications += 1)),
    })
    manager.onEpisodeClosed(episode())
    await settle()

    expect(classifications).toBe(0)
    expect(repository.getReflectionJob("episode:session:ses_1")).toMatchObject({
      status: "done",
      reason: "proposed",
      decisionID: "heuristic:episode:session:ses_1",
    })
    expect(repository.getProposal("proposal:episode:session:ses_1")).toMatchObject({
      status: "proposed",
      intent: "add",
      name: "fix-bun-test-src-math-test-ts",
      modelVersion: "heuristic/fix-verify",
      confidence: 0.8,
      evidenceRefs: ["session:ses_1"],
    })
    expect(existsSync(learnedPath("fix-bun-test-src-math-test-ts"))).toBe(false)
  })

  test("learning on without the classifier's consent never asks the classifier nor drafts remotely", async () => {
    // The settings writer lets learning on without the classifier's consent; the egress guard is
    // what keeps the remote classifier from being asked, per project, at call time.
    const repository = repositoryFor()
    let classifications = 0
    let drafts = 0
    const unconsented = (block: Record<string, unknown>) =>
      resolveAdaptiveConfig({
        block: { jev: { enabled: true }, learning: { enabled: true, minToolCalls: 5, model: "prov/small" }, ...block },
        env: {},
      })
    const configs = [
      // Consent for another kind only.
      unconsented({ egress: { projects: [project], kinds: { completion: true } } }),
      // Consent for the kind, but for another project.
      unconsented({ egress: { projects: [join(root, "elsewhere")], kinds: { skillReflection: true } } }),
      // A remote classifier the config names without any consent row.
      unconsented({ models: { skillReflection: "small-llm" } }),
    ]
    for (const [index, config] of configs.entries()) {
      const manager = managerFor({
        repository,
        config,
        trace: redFixGreen(),
        service: service(undefined, () => (classifications += 1)),
        drafter: {
          draft: async () => {
            drafts += 1
            return undefined
          },
        },
      })
      const id = `episode:session:ses_${index}`
      manager.onEpisodeClosed(episode({ id, sessionID: `ses_${index}`, evidenceRefs: [`session:ses_${index}`] }))
      await settle()
      expect(repository.getReflectionJob(id)?.decisionID ?? repository.getReflectionJob(id)?.reason).toMatch(
        /^heuristic:|^heuristic-duplicate$/,
      )
    }
    expect(classifications).toBe(0)
    expect(drafts).toBe(0)
    // The built-in rules staged the lesson once, for a person to approve.
    expect(repository.getProposal("proposal:episode:session:ses_0")).toMatchObject({
      status: "proposed",
      modelVersion: "heuristic/fix-verify",
    })
  })

  test("the learning caps (AH-F03) hold on the heuristic path too", async () => {
    const repository = repositoryFor()
    const steps = redFixGreen()
    const manager = managerFor({
      repository,
      config: resolveAdaptiveConfig({
        block: { learning: { enabled: true, minToolCalls: 5, limits: { proposalsPerDay: 1 } } },
        env: {},
      }),
      trace: steps,
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:session:ses_1")).toMatchObject({ status: "done", reason: "proposed" })

    steps.splice(
      0,
      steps.length,
      { tool: "bash", command: "bun test src/other.test.ts", exit: 1, ok: true, paths: [] },
      { tool: "edit", ok: true, paths: [join(project, "src/other.ts")] },
      { tool: "bash", command: "bun test src/other.test.ts", exit: 0, ok: true, paths: [] },
    )
    manager.onEpisodeClosed(
      episode({
        id: "episode:session:ses_2",
        sessionID: "ses_2",
        files: ["src/other.ts"],
        commands: ["bun test src/other.test.ts"],
        evidenceRefs: ["session:ses_2"],
      }),
    )
    await settle()

    expect(repository.getReflectionJob("episode:session:ses_2")).toMatchObject({
      status: "skipped",
      reason: "limit:proposals-per-day",
    })
    expect(repository.getProposal("proposal:episode:session:ses_2")).toBeUndefined()
  })

  test("the heuristic proposal installs only through the human approval", async () => {
    const repository = repositoryFor()
    const curator = createSkillCurator({ store: createLearnedStore({ env: {} }) })
    const manager = managerFor({ repository, config: noModel(), trace: redFixGreen(), curator })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(existsSync(learnedPath("fix-bun-test-src-math-test-ts"))).toBe(false)

    expect(
      createProposalReview({ repository, curator, now: () => NOW }).approve("proposal:episode:session:ses_1"),
    ).toMatchObject({ ok: true, changed: true })
    expect(existsSync(learnedPath("fix-bun-test-src-math-test-ts"))).toBe(true)
    expect(repository.getProposal("proposal:episode:session:ses_1")?.status).toBe("promoted")
  })

  test("with no candidate the model path's own skip reason is kept", async () => {
    const repository = repositoryFor()
    const manager = managerFor({ repository, config: noModel() })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:session:ses_1")).toMatchObject({ status: "skipped", reason: "egress-denied" })
    expect(repository.getProposal("proposal:episode:session:ses_1")).toBeUndefined()
  })

  test("the deterministic gate still applies: a below-threshold episode is never classified", async () => {
    const repository = repositoryFor()
    const manager = managerFor({ repository, config: noModel(), trace: redFixGreen() })
    manager.onEpisodeClosed(episode({ toolCalls: 1 }))
    await settle()
    expect(repository.getReflectionJob("episode:session:ses_1")).toMatchObject({ status: "skipped", reason: "below-threshold" })
  })

  test("a lesson already proposed is not staged a second time", async () => {
    const repository = repositoryFor()
    const manager = managerFor({ repository, config: noModel(), trace: redFixGreen() })
    manager.onEpisodeClosed(episode())
    await settle()
    manager.onEpisodeClosed(episode({ id: "episode:session:ses_2", sessionID: "ses_2", evidenceRefs: ["session:ses_2"] }))
    await settle()
    expect(repository.getReflectionJob("episode:session:ses_2")).toMatchObject({ status: "skipped", reason: "heuristic-duplicate" })
    expect(repository.getProposal("proposal:episode:session:ses_2")).toBeUndefined()
  })

  test("a repeated command across sessions of the project is proposed from the stored episodes", async () => {
    const repository = repositoryFor()
    for (const n of [1, 2]) {
      repository.createEpisode(
        {
          id: `episode:session:ses_p${n}`,
          sessionID: `ses_p${n}`,
          projectID: project,
          objective: "Earlier work",
          toolCalls: 8,
          files: ["src/a.rs"],
          commands: ["cargo test --workspace"],
          failures: [],
          verifications: [],
          outcome: "partial",
          startedAt: 0,
          endedAt: 1,
          evidenceRefs: [`session:ses_p${n}`],
        },
        NOW,
      )
    }
    const manager = managerFor({ repository, config: noModel() })
    manager.onEpisodeClosed(episode({ commands: ["cargo test --workspace"], failures: [] }))
    await settle()
    expect(repository.getProposal("proposal:episode:session:ses_1")).toMatchObject({
      status: "proposed",
      name: "run-cargo-test-workspace",
      modelVersion: "heuristic/repeated-command",
      evidenceRefs: ["session:ses_1", "episode:session:ses_p1", "episode:session:ses_p2"],
    })
  })

  test("text that carries a secret is stored redacted and rejected, never proposed", async () => {
    const repository = repositoryFor()
    const manager = managerFor({ repository, config: noModel(), trace: redFixGreen() })
    const secret = `ghp_${"a".repeat(30)}`
    manager.onEpisodeClosed(episode({ failures: [{ summary: `bad token ${secret}`, file: "src/math.test.ts", line: 3 }] }))
    await settle()
    const proposal = repository.getProposal("proposal:episode:session:ses_1")
    expect(proposal).toMatchObject({ status: "rejected", reason: "contains-secrets" })
    expect(proposal?.body).not.toContain(secret)
  })

  test("with a model configured, the model path wins and the heuristic stays out", async () => {
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      config: withModel(),
      trace: redFixGreen(),
      drafter: drafter({
        name: "fix-math",
        description: "Use when the math test fails",
        body: "## Steps\n" + "Fix the math carefully and rerun the test. ".repeat(4),
      }),
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getProposal("proposal:episode:session:ses_1")).toMatchObject({
      name: "fix-math",
      modelVersion: "prov/small",
      decisionID: "skillReflection:episode:session:ses_1",
    })
  })

  test("a classifier that answered not-reusable is never overridden", async () => {
    const repository = repositoryFor()
    const manager = managerFor({
      repository,
      config: withModel(),
      trace: redFixGreen(),
      service: service({ reusable: false, intent: "add" }),
    })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getReflectionJob("episode:session:ses_1")).toMatchObject({ status: "skipped", reason: "not-reusable" })
    expect(repository.getProposal("proposal:episode:session:ses_1")).toBeUndefined()
  })

  test("a failed draft falls back to the heuristic", async () => {
    const repository = repositoryFor()
    const manager = managerFor({ repository, config: withModel(), trace: redFixGreen(), drafter: drafter(undefined) })
    manager.onEpisodeClosed(episode())
    await settle()
    expect(repository.getProposal("proposal:episode:session:ses_1")).toMatchObject({
      status: "proposed",
      modelVersion: "heuristic/fix-verify",
      decisionID: "heuristic:episode:session:ses_1",
    })
  })
})
