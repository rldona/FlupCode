import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "./config"
import type { DecisionKind, DecisionRequest, ItemDisposition } from "./decision"
import type { ContextPart } from "./context"
import { classifyRunPrompt } from "./context"
import { createContextManager } from "./context-manager"
import type { ContextManagerDeps, ContextRefinement } from "./context-manager"
import { planID } from "./compaction-plan"
import type { CompactionPlan } from "./compaction-plan"
import { decisionID } from "./decision-record"
import { opaqueItemID } from "./opaque-id"
import { createDecisionService } from "./decision-service"
import type { DecisionService } from "./decision-service"
import { createAdaptiveEgressGuard } from "./egress"
import { createGovernor } from "./providers/governor"
import { DecisionUnavailable } from "./providers/provider"
import type { Prediction, PredictiveModel } from "./predictive/model"
import { deterministicContextItem } from "./scoring"
import { SqliteRoutineRepository } from "../repository"
import type { SessionEpisode } from "../types"

const NOW = 1_700_000_000_000

/** A fixed key so opaque ids are stable in the test and no file is written. */
const KEY = Buffer.alloc(32, 7)

const configFor = (block: unknown = {}) => resolveAdaptiveConfig({ block, env: {} })

const parts: ContextPart[] = [
  { id: "obj", kind: "objective", text: "fix the bug" },
  { id: "mem", kind: "memory", text: "remember to fix the bug quickly" },
  { id: "art", kind: "artifact", text: "unrelated note about lunch" },
  { id: "file", kind: "file", file: { path: "src/bug.ts" } },
]

/** Jev on for one project and one kind: enough for the refinement to be attempted. */
const JEV_BLOCK = {
  jev: { enabled: true },
  egress: { projects: ["/work/project"], kinds: { contextItem: true } },
}

const setup = (block: unknown = {}, external?: PredictiveModel) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const config = configFor(block)
  const egress = createAdaptiveEgressGuard({ config: () => config })
  const governor = createGovernor({ config: () => config.governor, store: repository, now: () => NOW })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress,
    ...(external ? { models: [external], governor } : {}),
    now: () => NOW,
  })
  return { repository, config, egress, service, governor }
}

const managerFor = (
  input: { repository: SqliteRoutineRepository; service: DecisionService; config: ReturnType<typeof configFor>; egress: ReturnType<typeof createAdaptiveEgressGuard> },
  extra: Partial<ContextManagerDeps> = {},
) =>
  createContextManager({
    repository: input.repository,
    service: input.service,
    config: () => input.config,
    egress: input.egress,
    opaqueKey: () => KEY,
    now: () => NOW,
    ...extra,
  })

const planInput = (overrides: Partial<Parameters<ReturnType<typeof managerFor>["plan"]>[0]> = {}) => ({
  parts,
  objective: "fix the bug",
  runID: "run-1",
  taskID: "task-1",
  now: NOW,
  ...overrides,
})

const counting = (service: DecisionService) => {
  let calls = 0
  const wrapped: DecisionService = {
    predict: async <Q extends DecisionKind>(request: DecisionRequest<Q>) => {
      calls += 1
      return service.predict(request)
    },
    decisions: (filter) => service.decisions(filter),
    explain: (id) => service.explain(id),
  }
  return { service: wrapped, calls: () => calls }
}

/**
 * A fake Jev that answers only what it is asked and records the item ids of each request, read from
 * the serialized state it is handed (it never sees the typed request).
 */
const jevProvider = (disposition: ItemDisposition = "keep", confidence = 0.9) => {
  const seen: string[][] = []
  const provider: PredictiveModel & { seen: string[][] } = {
    id: "jev",
    locality: "remote",
    supports: ["contextItem"],
    seen,
    async predict(state, questions): Promise<Prediction> {
      const parsed: { items?: Array<{ id: string }> } = JSON.parse(state.text)
      seen.push((parsed.items ?? []).map((item) => item.id))
      return {
        answers: Object.fromEntries(
          questions.map((question) => [
            question.id,
            { probabilities: { [disposition]: confidence }, choice: disposition, confidence },
          ]),
        ),
        latencyMs: 0,
        usage: { inputTokens: 0, costUsd: 0 },
        model: { id: "jev" },
      }
    },
  }
  return provider
}

describe("ContextManager.plan (FH-022/023)", () => {
  test("plans every part and persists it under the deterministic id", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput())

    expect(plan!.id).toBe(planID("run-1:task-1"))
    expect(plan!.keep.map((entry) => entry.id)).toEqual(["obj", "mem", "file"])
    expect(plan!.archive.map((entry) => entry.id)).toEqual(["art"])
    expect(plan!.scoreSource).toBe("deterministic")
    expect(plan!.degraded).toBe(false)

    const stored = repository.getPlan(planID("run-1:task-1"))!
    expect(stored.runID).toBe("run-1")
    expect(stored.taskID).toBe("task-1")
    expect(stored.entries.map((entry) => entry.id)).toEqual(["obj", "mem", "art", "file"])
    expect(stored.applied).toBe(false)
    expect(stored.tokensBefore).toBeGreaterThan(0)
    repository.close()
  })

  test("is a no-op when the kill switch is off, and writes nothing", async () => {
    const { repository, ...rest } = setup({ enabled: false })
    const manager = managerFor({ repository, ...rest })
    expect(await manager.plan(planInput())).toBeUndefined()
    expect(repository.listPlans()).toHaveLength(0)
    repository.close()
  })

  test("is a no-op when the context slice is disabled", async () => {
    const { repository, ...rest } = setup({ context: { enabled: false } })
    const manager = managerFor({ repository, ...rest })
    expect(await manager.plan(planInput())).toBeUndefined()
    expect(repository.listPlans()).toHaveLength(0)
    repository.close()
  })

  test("returns undefined when scoring fails entirely, so the caller does nothing", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest }, {
      classify: () => {
        throw new Error("classification boom")
      },
    })
    expect(await manager.plan(planInput())).toBeUndefined()
    repository.close()
  })

  test("stores no content: the plan has ids, scores and reasons only", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest })
    await manager.plan(planInput())
    const serialized = JSON.stringify(repository.listPlans())
    expect(serialized).not.toContain("unrelated note about lunch")
    expect(serialized).not.toContain("fix the bug quickly")
    expect(serialized).not.toContain("src/bug.ts")
    // The objective is a hash, never the text.
    expect(serialized).not.toContain("fix the bug")
    repository.close()
  })

  test("no ambiguous item means zero calls and no decision row", async () => {
    const setupOne = setup()
    const countingService = counting(setupOne.service)
    const manager = managerFor({ ...setupOne, service: countingService.service })
    const noAmbiguity: ContextPart[] = [
      { id: "obj", kind: "objective", text: "fix the bug" },
      { id: "mem", kind: "memory", text: "fix the bug" },
    ]
    const plan = await manager.plan(planInput({ parts: noAmbiguity }))
    expect(countingService.calls()).toBe(0)
    expect(setupOne.repository.listDecisions()).toHaveLength(0)
    expect(plan!.scoreSource).toBe("deterministic")
    setupOne.repository.close()
  })

  test("with Jev on, only the ambiguous items are asked and the answer is merged per item", async () => {
    const jev = jevProvider("keep", 0.9)
    const { repository, ...rest } = setup(JEV_BLOCK, jev)
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput({ projectID: "/work/project" }))

    expect(jev.seen).toEqual([["art"]])
    expect(plan!.scoreSource).toBe("jev")
    expect(plan!.keep.map((entry) => entry.id)).toContain("art")
    expect(plan!.archive).toHaveLength(0)
    // The plan links the decision row the question wrote.
    const stored = repository.getPlan(planID("run-1:task-1"))!
    expect(stored.decisionID).toBe(decisionID("contextItem", "run-1:task-1"))
    expect(repository.getDecision(stored.decisionID!)).toBeDefined()
    repository.close()
  })

  test("a Jev keep that would exceed the budget is archived, never over the ceiling", async () => {
    const jev = jevProvider("keep", 0.9)
    const { repository, ...rest } = setup(
      { ...JEV_BLOCK, context: { budget: { total: 10, perClass: { artifact: 1_000, objective: 1_000 } } } },
      jev,
    )
    const manager = managerFor({ repository, ...rest })
    const big: ContextPart[] = [
      { id: "obj", kind: "objective", text: "fix the bug" },
      { id: "art", kind: "artifact", text: "y".repeat(400) },
    ]
    const plan = await manager.plan(planInput({ parts: big, projectID: "/work/project" }))
    const artifact = plan!.archive.find((entry) => entry.id === "art")!
    expect(artifact.reason).toBe("budget-overflow")
    const keptTokens = plan!.keep.reduce((total, entry) => total + entry.tokens, 0)
    expect(keptTokens).toBeLessThanOrEqual(rest.config.context.budget.total)
    repository.close()
  })

  test("a Jev drop on a kind that is not a low-value payload is degraded to archive", async () => {
    const jev = jevProvider("drop", 0.9)
    const { repository, ...rest } = setup(JEV_BLOCK, jev)
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput({ projectID: "/work/project" }))
    // An artifact is not in `DROPPABLE_CONTEXT_KINDS`, so it can never leave the prompt as a drop.
    expect(plan!.drop.map((entry) => entry.id)).not.toContain("art")
    expect(plan!.archive.map((entry) => entry.id)).toContain("art")
    repository.close()
  })

  test("a low-confidence Jev answer is gated: the baseline is kept and the plan degrades", async () => {
    const jev = jevProvider("keep", 0.1)
    const { repository, ...rest } = setup(JEV_BLOCK, jev)
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput({ projectID: "/work/project" }))

    expect(plan!.scoreSource).toBe("deterministic")
    expect(plan!.degraded).toBe(true)
    expect(plan!.archive.map((entry) => entry.id)).toEqual(["art"])
    expect(repository.getPlan(planID("run-1:task-1"))!.degradedReason).toBe("low-confidence")
    repository.close()
  })

  test("a degraded refinement keeps the deterministic baseline", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest }, { refine: async (): Promise<ContextRefinement | undefined> => undefined })
    const plan = await manager.plan(planInput())
    expect(plan!.scoreSource).toBe("deterministic")
    expect(plan!.degraded).toBe(true)
    expect(plan!.archive.map((entry) => entry.id)).toEqual(["art"])
    repository.close()
  })

  test("the service baseline equals the manager plan byte for byte", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest })
    const withAge: ContextPart[] = [...parts, { id: "old", kind: "file", file: { path: "src/old.ts" }, createdAt: NOW - 3 * 24 * 60 * 60 * 1000 }]
    const objective = "fix the bug"
    await manager.plan(planInput({ parts: withAge, objective }))

    const items = classifyRunPrompt({ parts: withAge, objective })
    const baseline = deterministicContextItem({ objective, items }, NOW).decisions
    const stored = repository.getPlan(planID("run-1:task-1"))!
    expect(stored.entries.map((entry) => ({ id: entry.id, disposition: entry.disposition }))).toEqual(baseline)
    repository.close()
  })

  test("a later plan of the same scope re-admits an item the previous plan archived", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest })
    const aged: ContextPart[] = [
      { id: "obj", kind: "objective", text: "fix src/old.ts" },
      { id: "old", kind: "file", file: { path: "src/old.ts" }, createdAt: NOW - 3 * 24 * 60 * 60 * 1000 },
    ]
    const first = await manager.plan(planInput({ parts: aged, objective: "fix src/old.ts" }))
    expect(first!.archive.map((entry) => entry.id)).toContain("old")
    // The next plan sees the archived mark, and the objective still references it, so it recovers.
    const second = await manager.plan(planInput({ parts: aged, objective: "fix src/old.ts" }))
    expect(second!.keep.map((entry) => entry.id)).toContain("old")
    repository.close()
  })

  test("non-default thresholds reach the service baseline through the contextItem policy", async () => {
    const { repository, ...rest } = setup({ context: { keepThreshold: 0.45 } })
    const items = classifyRunPrompt({ parts, objective: "fix the bug" })
    const request: DecisionRequest<"contextItem"> = {
      kind: "contextItem",
      state: { objective: "fix the bug", items },
      policy: rest.config.decisions.contextItem,
      scopeID: "run-1:task-1",
      now: NOW,
    }
    const result = await rest.service.predict(request)
    // The unreferenced file scores 0.5525: archive by default, keep under the configured 0.45.
    expect(result.answer.decisions.find((entry) => entry.id === "file")!.disposition).toBe("keep")
    repository.close()
  })

  test("the runner's plan takes the hot path and resolves while the batch limiter is saturated", async () => {
    const jev = jevProvider("keep", 0.9)
    const { repository, governor, ...rest } = setup(
      { ...JEV_BLOCK, governor: { limiter: { initial: 1, max: 1, min: 1, restoreEvery: 8 } } },
      jev,
    )
    // Hold the only batch slot with work that never finishes: a plan that queued on the limiter (the
    // batch path) would wait here forever, which is the head-of-line delay ADR-0017 §4 forbids.
    let acquired: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      acquired = resolve
    })
    void governor.runBatch("held", 1, () => {
      acquired()
      return new Promise<void>(() => {})
    })
    await held

    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput({ projectID: "/work/project" }))
    expect(plan!.scoreSource).toBe("jev")
    expect(jev.seen).toEqual([["art"]])
    repository.close()
  })

  test("a Jev that hangs past the timeout degrades to the deterministic baseline", async () => {
    const hanging: PredictiveModel = {
      id: "jev",
      locality: "remote",
      supports: ["contextItem"],
      predict: (_state, _questions, options) =>
        new Promise<Prediction>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DecisionUnavailable("timeout")))
        }),
    }
    const { repository, ...rest } = setup({ ...JEV_BLOCK, decisions: { contextItem: { timeoutMs: 5 } } }, hanging)
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput({ projectID: "/work/project" }))

    expect(plan!.scoreSource).toBe("deterministic")
    expect(plan!.degraded).toBe(true)
    expect(plan!.archive.map((entry) => entry.id)).toContain("art")
    expect(repository.getPlan(planID("run-1:task-1"))!.degradedReason).toBe("timeout")
    repository.close()
  })
})

describe("ContextManager.planEpisode (FH-023)", () => {
  const episode = (overrides: Partial<SessionEpisode> = {}): SessionEpisode => ({
    id: "episode:run:1",
    sessionID: "ses_1",
    projectID: "/work/project",
    objective: "ship the fix",
    toolCalls: 0,
    files: [],
    commands: [],
    failures: [],
    verifications: [],
    outcome: "success",
    startedAt: 1,
    endedAt: 2,
    evidenceRefs: [],
    timeCreated: 1,
    timeUpdated: 2,
    ...overrides,
  })

  test("plans an episode, persists it and asks nothing when there is no ambiguity", async () => {
    const { repository, ...rest } = setup()
    const countingService = counting(rest.service)
    const manager = managerFor({ repository, ...rest, service: countingService.service })
    const plan = await manager.planEpisode(episode(), NOW)
    expect(plan!.id).toBe(planID("episode:run:1"))
    expect(plan!.keep).toHaveLength(0)
    expect(countingService.calls()).toBe(0)
    expect(repository.listDecisions()).toHaveLength(0)
    expect(repository.getPlan(planID("episode:run:1"))!.episodeID).toBe("episode:run:1")
    repository.close()
  })

  test("asks only the ambiguous evidence and links the decision row to the plan", async () => {
    const jev = jevProvider("keep", 0.9)
    const { repository, ...rest } = setup(JEV_BLOCK, jev)
    const manager = managerFor({ repository, ...rest })
    // The file is not named by the objective and carries one anchor, so it lands in the ambiguity
    // band; the error is protected and never asked about.
    const plan = await manager.planEpisode(
      episode({ files: ["src/other.ts"], failures: [{ summary: "the check is red" }] }),
      NOW,
    )
    const fileID = opaqueItemID("file", "src/other.ts", KEY)
    expect(jev.seen).toEqual([[fileID]])
    expect(plan!.scoreSource).toBe("jev")
    expect(plan!.keep.map((entry) => entry.id)).toContain(fileID)
    const stored = repository.getPlan(planID("episode:run:1"))!
    expect(stored.decisionID).toBe(decisionID("contextItem", "episode:run:1"))
    expect(repository.getDecision(stored.decisionID!)).toBeDefined()
    repository.close()
  })

  test("a total failure is a no-op: undefined and nothing written", async () => {
    const { repository, ...rest } = setup()
    // An unreadable key makes the classifier throw; the manager must swallow it and plan nothing.
    const manager = managerFor({ repository, ...rest }, { opaqueKey: () => ({}) as unknown as Buffer })
    expect(await manager.planEpisode(episode({ files: ["src/other.ts"] }), NOW)).toBeUndefined()
    expect(repository.listPlans()).toHaveLength(0)
    repository.close()
  })
})

describe("ContextManager.explainPlan (FH-022)", () => {
  test("explains a plan from stored rows alone: the plan, the episode's evidence and the linked decision", async () => {
    const jev = jevProvider("keep", 0.9)
    const { repository, ...rest } = setup(JEV_BLOCK, jev)
    const manager = managerFor({ repository, ...rest })
    const stored = repository.createEpisode({
      sessionID: "ses_1",
      projectID: "/work/project",
      objective: "ship the fix",
      toolCalls: 0,
      files: ["src/other.ts"],
      commands: [],
      failures: [],
      verifications: [],
      outcome: "success",
      startedAt: 1,
      endedAt: 2,
      evidenceRefs: ["session:ses_1", "task:one"],
    })
    await manager.planEpisode(stored, NOW)

    const explanation = manager.explainPlan(planID(stored.id))!
    expect(explanation.evidenceRefs).toEqual(["session:ses_1", "task:one"])
    expect(explanation.decision?.id).toBe(decisionID("contextItem", stored.id))
    expect(explanation.decision?.source).toBe("jev")
    expect(manager.explainPlan(planID("missing"))).toBeUndefined()
    repository.close()
  })
})

describe("ContextManager.apply (FH-022)", () => {
  test("is the identity with no plan or with applying off", async () => {
    const { repository, ...rest } = setup()
    const manager = managerFor({ repository, ...rest })
    expect(manager.apply({ parts, plan: undefined })).toEqual(parts)
    const plan = await manager.plan(planInput({ parts }))
    expect(managerFor({ repository, ...rest }).apply({ parts, plan })).toEqual(parts)
    repository.close()
  })

  test("removes archived parts and keeps the order of the rest", async () => {
    const { repository, ...rest } = setup({ context: { apply: true } })
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput())
    expect(manager.apply({ parts, plan }).map((part) => part.id)).toEqual(["obj", "mem", "file"])
    repository.close()
  })

  test("keeps a part the plan never saw", async () => {
    const { repository, ...rest } = setup({ context: { apply: true } })
    const manager = managerFor({ repository, ...rest })
    const plan = await manager.plan(planInput())
    const stranger: ContextPart = { id: "stranger", kind: "handoff", text: "unplanned" }
    expect(manager.apply({ parts: [...parts, stranger], plan }).map((part) => part.id)).toContain("stranger")
    repository.close()
  })

  test("never removes a protected human instruction even when a corrupt plan says so", async () => {
    const { repository, ...rest } = setup({ context: { apply: true } })
    const manager = managerFor({ repository, ...rest })
    // A plan that did not come from the scorer: it tries to archive the objective and drop the memory.
    const corrupt: CompactionPlan = {
      id: "plan:corrupt",
      keep: [],
      archive: [
        { id: "obj", kind: "objective", score: 0, disposition: "archive", reason: "corrupt", protected: true, tokens: 1 },
      ],
      drop: [
        { id: "mem", kind: "memory", score: 0, disposition: "drop", reason: "corrupt", protected: false, tokens: 1 },
      ],
      scoreSource: "deterministic",
      degraded: false,
      createdAt: NOW,
    }
    expect(manager.apply({ parts, plan: corrupt }).map((part) => part.id)).toEqual(["obj", "mem", "art", "file"])
    repository.close()
  })

  test("normalises an invalid disposition to keep instead of filtering", async () => {
    const { repository, ...rest } = setup({ context: { apply: true } })
    const manager = managerFor({ repository, ...rest })
    // A `keep` disposition that ended up in a removal bucket must not remove anything.
    const corrupt: CompactionPlan = {
      id: "plan:corrupt-disposition",
      keep: [],
      archive: [],
      drop: [
        { id: "art", kind: "artifact", score: 0, disposition: "keep", reason: "corrupt", protected: false, tokens: 1 },
      ],
      scoreSource: "deterministic",
      degraded: false,
      createdAt: NOW,
    }
    expect(manager.apply({ parts, plan: corrupt }).map((part) => part.id)).toEqual(["obj", "mem", "art", "file"])
    repository.close()
  })
})

describe("a pack's artifact and file refs stay archivable, never dropped (ADR-0022 §4)", () => {
  test("a low-value artifact and file are archived, apply removes them recoverably, explain shows them", async () => {
    const { repository, ...rest } = setup({ context: { apply: true } })
    const manager = managerFor({ repository, ...rest })
    const packParts: ContextPart[] = [
      { id: "obj", kind: "objective", text: "ship the feature" },
      { id: "art", kind: "artifact", text: "a note about lunch" },
      { id: "file", kind: "file", file: { path: "src/unrelated.txt" } },
    ]
    const plan = await manager.plan(planInput({ parts: packParts, objective: "ship the feature" }))

    // Both score below keep but neither is a low-value payload: archived, never dropped, even with
    // applying on. A reference a person put in a pack is never lost silently.
    expect(plan!.drop.map((entry) => entry.id)).toEqual([])
    expect(plan!.archive.map((entry) => entry.id).sort()).toEqual(["art", "file"])
    expect(plan!.keep.map((entry) => entry.id)).toEqual(["obj"])

    // `apply=true` filters them from the prompt but the plan keeps what it archived: recoverable.
    expect(manager.apply({ parts: packParts, plan }).map((part) => part.id)).toEqual(["obj"])

    // What was archived is exposed through the plan/explain read, without a new product API.
    const explanation = manager.explainPlan(planID("run-1:task-1"))!
    expect(
      explanation.entries
        .filter((entry) => entry.disposition === "archive")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["art", "file"])
    repository.close()
  })
})
