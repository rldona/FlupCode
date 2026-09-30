/**
 * The learning evaluation: the falsifiable claim of Phase 3b, offline and without a model (ADR-0020).
 *
 * The assertion is selection, not outcome: a learned skill in PROBATION whose description names the
 * objective it should serve is selected by the **deterministic** `skillRelevance` baseline for that
 * objective, and never for one it should not serve (wrong-load zero). Since AH-A04 the loop stops at a
 * staged proposal, so each metric approves it through the human review before it measures selection. The whole loop runs on a temp
 * project — human skills on disk, a fake classifier and a fake drafter, the real curator — so there
 * is no network, no engine and no model. The kill switch is asserted by byte-identity: with learning
 * off, nothing is written and the human tree does not move.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../repository"
import type { AdaptiveConfig } from "./config"
import { resolveAdaptiveConfig } from "./config"
import type { DecisionKind, DecisionRequest, DecisionResult, DecisionSpec, SkillReflectionAnswer } from "./decision"
import { DEFAULT_DECISION_POLICY } from "./decision"
import { deterministicBaseline } from "./providers/deterministic"
import { createAdaptiveEgressGuard } from "./egress"
import type { SessionEpisode } from "./episode"
import type { SkillDraft, SkillDrafter } from "./learning/draft"
import type { ReflectionService } from "./learning/manager"
import { createLearningManager } from "./learning/manager"
import { createProposalReview } from "./learning/review"
import type { SkillRosterEntry } from "./skills/curator"
import { createSkillCurator } from "./skills/curator"
import { createLearnedStore } from "./skills/learned-store"

const NOW = 1_700_000_000_000

type Fixture = {
  name: string
  objective: string
  roster: Array<{ name: string; description: string; learned: boolean }>
  before: string[]
  after: string[]
  wrongLoad: string[]
  lesson: { name: string; description: string; body: string }
}

let root = ""
let home = ""
let configDirectory = ""
let xdg = ""
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-learning-eval-"))
  home = join(root, "home")
  configDirectory = join(root, "config")
  xdg = join(root, "xdg")
  for (const directory of [home, configDirectory, xdg]) mkdirSync(directory, { recursive: true })
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

const fixtureNames = ["fix-failing-parser-test", "rotate-deploy-keys"]
const load = (name: string): Fixture =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "learning", `${name}.json`), "utf8"),
  ) as Fixture

const projectFor = (name: string) => {
  const project = join(root, `project-${name}`)
  mkdirSync(project, { recursive: true })
  return project
}

const humanSkill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the human thing.\n`

const writeHumanSkills = (project: string, entries: Fixture["roster"]) => {
  for (const entry of entries) {
    const path = join(project, ".opencode", "skills", entry.name, "SKILL.md")
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, humanSkill(entry.name, entry.description))
  }
}

const learnedPath = (project: string, name: string) =>
  join(project, ".opencode", "skills", "flupcode-learned", name, "SKILL.md")

const configFor = (project: string, over: Record<string, unknown> = {}): AdaptiveConfig =>
  resolveAdaptiveConfig({
    block: {
      jev: { enabled: true },
      egress: { projects: [project], kinds: { skillReflection: true } },
      learning: { enabled: true, minToolCalls: 5, model: "prov/small" },
      ...over,
    },
    env: {},
  })

const repositoryFor = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return repository
}

const episodeFor = (project: string, id: string, over: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id,
  sessionID: `ses_${id}`,
  projectID: project,
  objective: "Fix the failing parser test",
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

const reflectionService = (input: { answer?: SkillReflectionAnswer; onCall?: () => void }): ReflectionService => ({
  async predict<Q extends DecisionKind>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    input.onCall?.()
    const answer = input.answer ?? { reusable: true, intent: "add" }
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

const drafterFor = (draft: SkillDraft | undefined, onCall?: () => void) => {
  const drafter: SkillDrafter = {
    async draft() {
      onCall?.()
      return draft
    },
  }
  return drafter
}

const curatorFor = () => createSkillCurator({ store: createLearnedStore({ env: {} }) })

const managerFor = (input: {
  config: AdaptiveConfig
  service: ReflectionService
  drafter: SkillDrafter
  curator?: ReturnType<typeof curatorFor>
  repository?: SqliteRoutineRepository
}) =>
  createLearningManager({
    repository: input.repository ?? repositoryFor(),
    service: input.service,
    config: () => input.config,
    egress: createAdaptiveEgressGuard({ config: () => input.config }),
    curator: input.curator ?? curatorFor(),
    drafter: input.drafter,
    now: () => NOW,
  })

const asSkills = (entries: readonly SkillRosterEntry[]) =>
  entries.map(({ name, description, learned }) => ({ name, description, learned }))

const loadFor = (project: string, objective: string, entries: readonly SkillRosterEntry[]): string[] => {
  const baseline = deterministicBaseline({
    kind: "skillRelevance",
    sessionID: "ses",
    projectID: project,
    policy: DEFAULT_DECISION_POLICY,
    state: { sessionID: "ses", objective, skills: asSkills(entries) },
  })
  return baseline.answer.load
}

const sorted = (names: readonly string[]) => [...names].sort()

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The human step (AH-A04): nothing the manager drafted is installed until this approval. */
const approve = (repository: SqliteRoutineRepository, curator: ReturnType<typeof curatorFor>, episodeID: string) => {
  expect(repository.getProposal(`proposal:${episodeID}`)?.status).toBe("proposed")
  expect(createProposalReview({ repository, curator, now: () => NOW }).approve(`proposal:${episodeID}`)).toMatchObject({
    ok: true,
    changed: true,
  })
}

describe("learning evaluation (FH-034, ADR-0020 §8)", () => {
  test("metric 1 — the PROBATION skill is selected for the objective it serves", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const project = projectFor(name)
      writeHumanSkills(project, fixture.roster)
      const curator = curatorFor()
      const repository = repositoryFor()

      // Before: nothing learned yet, so the objective recalls nothing.
      expect(sorted(loadFor(project, fixture.objective, curator.roster(project)))).toEqual(sorted(fixture.before))

      const manager = managerFor({
        config: configFor(project),
        service: reflectionService({}),
        drafter: drafterFor(fixture.lesson),
        curator,
        repository,
      })
      manager.onEpisodeClosed(episodeFor(project, `episode:run:${name}`))
      await settle()

      expect(repository.getReflectionJob(`episode:run:${name}`)?.status).toBe("done")
      // Staged, not installed: the roster does not move until a person approves.
      expect(sorted(loadFor(project, fixture.objective, curator.roster(project)))).toEqual(sorted(fixture.before))
      approve(repository, curator, `episode:run:${name}`)
      expect(createLearnedStore({ env: {} }).readSidecar(project, fixture.lesson.name)).toMatchObject({
        state: "probation",
      })
      // After: the learned skill is in the roster and the same baseline selects it.
      expect(sorted(loadFor(project, fixture.objective, curator.roster(project)))).toEqual(sorted(fixture.after))
    }
  })

  test("metric 1b — the same roster and objective select the same load, byte for byte", async () => {
    const fixture = load(fixtureNames[0]!)
    const project = projectFor("determinism")
    writeHumanSkills(project, fixture.roster)
    const curator = curatorFor()
    const repository = repositoryFor()

    const manager = managerFor({
      config: configFor(project),
      service: reflectionService({}),
      drafter: drafterFor(fixture.lesson),
      curator,
      repository,
    })
    manager.onEpisodeClosed(episodeFor(project, "episode:run:determinism"))
    await settle()
    approve(repository, curator, "episode:run:determinism")

    const first = loadFor(project, fixture.objective, curator.roster(project))
    const second = loadFor(project, fixture.objective, curator.roster(project))
    expect(second).toEqual(first)
    expect(first).toContain(fixture.lesson.name)
  })

  test("metric 2 — wrong-load rate is zero over the labelled episodes", async () => {
    for (const name of fixtureNames) {
      const fixture = load(name)
      const project = projectFor(`${name}-wrong`)
      writeHumanSkills(project, fixture.roster)
      const curator = curatorFor()
      const repository = repositoryFor()

      const manager = managerFor({
        config: configFor(project),
        service: reflectionService({}),
        drafter: drafterFor(fixture.lesson),
        curator,
        repository,
      })
      manager.onEpisodeClosed(episodeFor(project, `episode:run:${name}`))
      await settle()
      approve(repository, curator, `episode:run:${name}`)

      const loaded = loadFor(project, fixture.objective, curator.roster(project))
      expect(loaded.filter((candidate) => fixture.wrongLoad.includes(candidate))).toEqual([])
      // The learned skill is the one selected, never a human skill it should not serve.
      expect(loaded).toContain(fixture.lesson.name)
    }
  })

  test("metric 3 — zero reflection calls below the threshold, at most one above", async () => {
    const project = projectFor("threshold")
    writeHumanSkills(project, [{ name: "testing", description: "Write focused tests", learned: false }])
    const repository = repositoryFor()
    let classifications = 0
    let drafts = 0
    const manager = managerFor({
      config: configFor(project),
      service: reflectionService({ onCall: () => (classifications += 1) }),
      drafter: drafterFor(
        { name: "fix-failing-parser-test", description: "Use when a failing parser test needs a fix", body: "## Steps\nFix the failing parser test with the smallest change. ".repeat(3) },
        () => (drafts += 1),
      ),
      repository,
    })

    manager.onEpisodeClosed(episodeFor(project, "episode:run:below", { toolCalls: 1 }))
    await settle()
    expect(classifications).toBe(0)
    expect(drafts).toBe(0)

    manager.onEpisodeClosed(episodeFor(project, "episode:run:above"))
    await settle()
    expect(classifications).toBe(1)
    expect(drafts).toBe(1)
    expect(repository.getReflectionJob("episode:run:above")?.status).toBe("done")
  })

  test("metric 4 — inert and byte-identical with learning off or the master kill switch", async () => {
    const project = projectFor("inert")
    writeHumanSkills(project, [{ name: "testing", description: "Write focused tests", learned: false }])
    const humanPath = join(project, ".opencode", "skills", "testing", "SKILL.md")
    const before = readFileSync(humanPath, "utf8")

    const cases: Array<{ id: string; config: AdaptiveConfig }> = [
      { id: "episode:run:off", config: configFor(project, { learning: { enabled: false, minToolCalls: 5 } }) },
      { id: "episode:run:kill", config: configFor(project, { enabled: false }) },
    ]
    for (const entry of cases) {
      let classifications = 0
      const manager = managerFor({
        config: entry.config,
        service: reflectionService({ onCall: () => (classifications += 1) }),
        drafter: drafterFor(load(fixtureNames[0]!).lesson),
        repository: repositoryFor(),
      })
      manager.onEpisodeClosed(episodeFor(project, entry.id))
      await settle()
      expect(classifications).toBe(0)
      expect(existsSync(learnedPath(project, "fix-failing-parser-test"))).toBe(false)
    }

    expect(readFileSync(humanPath, "utf8")).toBe(before)
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned"))).toBe(false)
  })

  test("trust — a promotion leaves the human tree byte-identical and the learned skill marked", async () => {
    const fixture = load(fixtureNames[0]!)
    const project = projectFor("trust")
    writeHumanSkills(project, fixture.roster)
    const before = new Map(
      fixture.roster.map((entry) => [
        entry.name,
        readFileSync(join(project, ".opencode", "skills", entry.name, "SKILL.md"), "utf8"),
      ]),
    )

    const repository = repositoryFor()
    const curator = curatorFor()
    const manager = managerFor({
      config: configFor(project),
      service: reflectionService({}),
      drafter: drafterFor(fixture.lesson),
      curator,
      repository,
    })
    manager.onEpisodeClosed(episodeFor(project, "episode:run:trust"))
    await settle()
    expect(existsSync(learnedPath(project, fixture.lesson.name))).toBe(false)
    approve(repository, curator, "episode:run:trust")

    for (const entry of fixture.roster) {
      expect(readFileSync(join(project, ".opencode", "skills", entry.name, "SKILL.md"), "utf8")).toBe(before.get(entry.name)!)
    }
    expect(readFileSync(learnedPath(project, fixture.lesson.name), "utf8")).toContain("self-authored: true")
    expect(repository.getProposal(`proposal:episode:run:trust`)?.status).toBe("promoted")
  })
})
