import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { resolveAdaptiveConfig } from "./config"
import type { DecisionKind, DecisionRequest, DecisionResult, DecisionSpec } from "./decision"
import { createDecisionService } from "./decision-service"
import type { DecisionService } from "./decision-service"
import { createContextManager } from "./context-manager"
import { createAdaptiveEgressGuard } from "./egress"
import { decisionID } from "./decision-record"
import { planID } from "./compaction-plan"
import { createShadowRunner, SHADOW_KINDS } from "./shadow"
import type { SkillSelection } from "./shadow"
import { createEpisodeCoordinator } from "./coordinator"
import { runEpisodeID } from "./episode"
import { SqliteRoutineRepository } from "../repository"
import type { SessionEpisode } from "../types"

const NOW = 1_700_000_000_000

const SKILLS = [{ name: "testing", description: "write focused tests", learned: false }]

/** A fixed key so opaque ids are stable in the test and no file is written. */
const OPAQUE_KEY = Buffer.alloc(32, 7)

/** An episode pipeline that closes a run exactly like the server does, with a fixed clock. */
const seedRun = (repository: SqliteRoutineRepository) => {
  const run = repository.startRun({ type: "manual" }, NOW, "/work/project")
  const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
  repository.finishTask(task!.id, "success", { output: "done" }, NOW)
  repository.finishRun(run.id, "success", undefined, NOW)
  return run
}

const coordinatorFor = (repository: SqliteRoutineRepository, onEpisodeClosed?: (episode: SessionEpisode) => void) =>
  createEpisodeCoordinator({
    repository,
    now: () => NOW,
    readEpisodeSignals: () => ({ calls: [] }),
    readEpisodeEvents: () => ({ events: [] }),
    ...(onEpisodeClosed ? { onEpisodeClosed } : {}),
  })

const serviceFor = (repository: SqliteRoutineRepository, shadow: boolean) => {
  const config = resolveAdaptiveConfig({ block: { shadow }, env: {} })
  const service = createDecisionService({
    repository,
    config: () => config,
    egress: createAdaptiveEgressGuard({ config: () => config }),
    now: () => NOW,
  })
  return service
}

const shadowFor = (
  repository: SqliteRoutineRepository,
  service: DecisionService,
  shadow: boolean,
  onError?: (cause: unknown) => void,
) => {
  const config = () => resolveAdaptiveConfig({ block: { shadow }, env: {} })
  const context = createContextManager({
    repository,
    service,
    config,
    opaqueKey: () => OPAQUE_KEY,
    now: () => NOW,
  })
  return createShadowRunner({
    service,
    repository,
    config,
    context,
    readSkills: () => SKILLS,
    ...(onError ? { onError } : {}),
  })
}

/** The fire-and-forget decisions resolve in a microtask; a macrotask flush is enough. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const normalize = (episode: SessionEpisode, runID: string, taskIDs: string[]): SessionEpisode => ({
  ...episode,
  id: "episode:run:*",
  runID: "*",
  // With no session attached, the episode is filed under the run's own (random) id.
  sessionID: "*",
  evidenceRefs: episode.evidenceRefs.map((ref) => {
    if (ref === `run:${runID}`) return "run:*"
    if (ref.startsWith("task:") && taskIDs.includes(ref.slice("task:".length))) return "task:*"
    return ref
  }),
})

describe("the decision shadow (FH-017)", () => {
  test("on: it records the shadow decisions and the plan, and leaves the episode identical byte for byte", async () => {
    const withShadow = new SqliteRoutineRepository(":memory:")
    const runWith = seedRun(withShadow)
    const shadow = shadowFor(withShadow, serviceFor(withShadow, true), true)
    const episode = coordinatorFor(withShadow, (entry) => shadow.onEpisodeClosed(entry)).captureRun(runWith.id)!
    await flush()

    const decisions = withShadow.listDecisions({ episodeID: episode.id })
    expect(decisions.map((decision) => decision.kind).sort()).toEqual([...SHADOW_KINDS].sort())
    expect(withShadow.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    // The manager delegated by the shadow wrote the plan; the episode carried no evidence, so it is
    // empty and Jev was never asked.
    expect(withShadow.getPlan(planID(episode.id))).toBeDefined()
    expect(withShadow.getPlan(planID(episode.id))!.entries).toHaveLength(0)
    // The episode row the callback saw is the same one that was returned: the shadow wrote nothing
    // to it.
    expect(withShadow.getEpisode(episode.id)).toEqual(episode)

    // An identical run, captured without any shadow, derives the same episode.
    const withoutShadow = new SqliteRoutineRepository(":memory:")
    const runWithout = seedRun(withoutShadow)
    const plain = coordinatorFor(withoutShadow).captureRun(runWithout.id)!
    expect(normalize(episode, runWith.id, withShadow.listTasks(runWith.id).map((task) => task.id))).toEqual(
      normalize(plain, runWithout.id, withoutShadow.listTasks(runWithout.id).map((task) => task.id)),
    )
    expect(withoutShadow.listDecisions()).toHaveLength(0)
    withShadow.close()
    withoutShadow.close()
  })

  test("off: no episode close writes a decision", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const shadow = shadowFor(repository, serviceFor(repository, false), false)
    coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)
    await flush()

    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })

  test("the kill switch stops the shadow: a close records nothing and the episode is still written", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    // `enabled: false` is the kill switch; shadow is left at its default (on), so what stops the
    // decisions is the switch and not the shadow flag.
    const config = resolveAdaptiveConfig({ block: { enabled: false }, env: {} })
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config }),
      now: () => NOW,
    })
    const context = createContextManager({ repository, service, config: () => config, opaqueKey: () => OPAQUE_KEY, now: () => NOW })
    const shadow = createShadowRunner({ service, repository, config: () => config, context, readSkills: () => SKILLS })
    const episode = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)!
    await flush()

    expect(repository.listDecisions()).toHaveLength(0)
    expect(repository.listPlans()).toHaveLength(0)
    // The switch stops decisions, not episodes: the episode row is still written as usual.
    expect(repository.getEpisode(episode.id)).toEqual(episode)
    expect(shadow.sweep()).toBe(0)
    repository.close()
  })

  test("a second close is the same decision and the same plan, not a second one", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const service = serviceFor(repository, true)
    const shadow = shadowFor(repository, service, true)
    const episode = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)!
    await flush()
    expect(repository.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    expect(repository.listPlans()).toHaveLength(1)

    shadow.onEpisodeClosed(episode)
    await flush()
    expect(repository.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    expect(repository.listPlans()).toHaveLength(1)
    repository.close()
  })

  test("a failing decision does not break the close of the episode", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const errors: unknown[] = []
    const failing: DecisionService = {
      predict: async () => {
        throw new Error("shadow boom")
      },
      decisions: () => [],
      explain: () => undefined,
    }
    const shadow = shadowFor(repository, failing, true, (cause) => errors.push(cause))
    const episode = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)!

    expect(episode.id).toBe(runEpisodeID(run.id))
    expect(repository.getEpisode(episode.id)).toEqual(episode)
    await flush()
    expect(errors.length).toBeGreaterThan(0)
    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })

  test("the sweep backstops a terminal episode that was never decided", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const service = serviceFor(repository, true)
    const shadow = shadowFor(repository, service, true)
    // The close callback was lost (a restart): the episode exists, no decision does.
    coordinatorFor(repository).captureRun(run.id)
    expect(repository.listDecisions()).toHaveLength(0)

    expect(shadow.sweep()).toBe(1)
    await flush()
    expect(repository.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    expect(repository.listPlans()).toHaveLength(1)
    expect(shadow.sweep()).toBe(0)
    repository.close()
  })

  test("with the context slice off, the sweep does not re-enqueue for a plan it will never write", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const config = () => resolveAdaptiveConfig({ block: { shadow: true, context: { enabled: false } }, env: {} })
    const service = createDecisionService({
      repository,
      config,
      egress: createAdaptiveEgressGuard({ config }),
      now: () => NOW,
    })
    const context = createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW })
    const shadow = createShadowRunner({ service, repository, config, context, readSkills: () => SKILLS })
    coordinatorFor(repository).captureRun(run.id)

    // The decisions are missing, so the episode is worked once; the plan is off, so it is not.
    expect(shadow.sweep()).toBe(1)
    await flush()
    expect(repository.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    expect(repository.listPlans()).toHaveLength(0)
    // Before the fix the missing plan kept `needsWork` true forever and re-enqueued every sweep.
    expect(shadow.sweep()).toBe(0)
    repository.close()
  })

  test("no raw content reaches the audit: a canary in a command and a failure is nowhere", async () => {
    const CANARY = "SECRETCANARY-abcdefghijklmnop"
    const repository = new SqliteRoutineRepository(":memory:")
    const run = repository.startRun({ type: "manual" }, NOW, "/work/project")
    const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
    repository.finishTask(task!.id, "failed", { error: `edit failed: ${CANARY}` }, NOW)
    repository.finishRun(run.id, "failed", undefined, NOW)

    const config = resolveAdaptiveConfig({ block: { shadow: true }, env: {} })
    // Jev off on purpose: the leak the review found happened with Jev off, too.
    const service = createDecisionService({
      repository,
      config: () => config,
      egress: createAdaptiveEgressGuard({ config: () => config, secrets: () => [CANARY] }),
      now: () => NOW,
    })
    const context = createContextManager({ repository, service, config: () => config, egress: createAdaptiveEgressGuard({ config: () => config, secrets: () => [CANARY] }), opaqueKey: () => OPAQUE_KEY, now: () => NOW })
    const shadow = createShadowRunner({ service, repository, config: () => config, context, readSkills: () => SKILLS })
    const coordinator = createEpisodeCoordinator({
      repository,
      now: () => NOW,
      readEpisodeSignals: () => ({
        calls: [
          {
            tool: "bash",
            ok: false,
            exit: 1,
            command: `curl -H "Authorization: Bearer ${CANARY}" https://example.test`,
            paths: ["src/math.ts"],
          },
        ],
      }),
      readEpisodeEvents: () => ({ events: [{ kind: "tool.error", seq: 1, at: NOW, tool: "edit", message: CANARY }] }),
      onEpisodeClosed: (episode) => shadow.onEpisodeClosed(episode),
    })
    const episode = coordinator.captureRun(run.id)!
    await flush()

    // The episode is local and keeps the canary; the audit must not.
    expect(JSON.stringify(episode)).toContain(CANARY)
    const decisionRows = repository.db
      .query("SELECT answer_json, baseline_answer_json, state_summary_json FROM adaptive_decision")
      .all()
    const planRows = repository.db.query("SELECT items_json FROM adaptive_plan").all()
    for (const row of [...decisionRows, ...planRows]) {
      expect(JSON.stringify(row)).not.toContain(CANARY)
    }

    // The plan's item ids are opaque digests, not the path, command or failure text.
    const plan = repository.getPlan(planID(episode.id))!
    expect(plan.entries.length).toBeGreaterThan(0)
    expect(plan.entries.every((entry) => /^(?:file|command|failure):[0-9a-f]{16}$/.test(entry.id))).toBe(true)
    expect(plan.entries.some((entry) => entry.id.includes("curl"))).toBe(false)
    expect(plan.entries.some((entry) => entry.id.includes("Bearer"))).toBe(false)
    // When the episode had an ambiguous item the manager asked the service, which audited the same
    // opaque ids.
    const contextDecision = repository.getDecision(decisionID("contextItem", episode.id))
    if (contextDecision) {
      const ids = (contextDecision.answer as { decisions: Array<{ id: string }> }).decisions.map((entry) => entry.id)
      expect(ids.every((id) => /^(?:file|command|failure):[0-9a-f]{16}$/.test(id))).toBe(true)
    }
    repository.close()
  })

  test("the close callback only enqueues: no skill read or write on the synchronous path", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    let skillReads = 0
    const service = serviceFor(repository, true)
    const config = () => resolveAdaptiveConfig({ block: { shadow: true }, env: {} })
    const shadow = createShadowRunner({
      service,
      repository,
      config,
      context: createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW }),
      readSkills: () => {
        skillReads += 1
        return SKILLS
      },
    })
    const coordinator = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry))
    coordinator.captureRun(run.id)

    // Synchronously, after the close returns: neither the skill read (FS) nor a write ran.
    expect(skillReads).toBe(0)
    expect(repository.listDecisions()).toHaveLength(0)

    await flush()
    expect(skillReads).toBe(1)
    expect(repository.listDecisions()).toHaveLength(SHADOW_KINDS.length)
    repository.close()
  })

  test("opaque ids are keyed: stable across captures and not the keyless digest", async () => {
    const command = "bun test --filter secret"
    const commandIDsFor = async (key: Buffer): Promise<string[]> => {
      const repository = new SqliteRoutineRepository(":memory:")
      const run = repository.startRun({ type: "manual" }, NOW, "/work/project")
      repository.attachSession(run.id, "ses_key")
      const [task] = repository.addTasks(run.id, [{ name: "build", prompt: "go" }])
      repository.finishTask(task!.id, "success", { output: "done" }, NOW)
      repository.finishRun(run.id, "success", undefined, NOW)
      const config = resolveAdaptiveConfig({ block: { shadow: true }, env: {} })
      const service = createDecisionService({
        repository,
        config: () => config,
        egress: createAdaptiveEgressGuard({ config: () => config }),
        now: () => NOW,
      })
      const context = createContextManager({ repository, service, config: () => config, opaqueKey: () => key, now: () => NOW })
      const shadow = createShadowRunner({ service, repository, config: () => config, context, readSkills: () => [] })
      const coordinator = createEpisodeCoordinator({
        repository,
        now: () => NOW,
        readEpisodeSignals: (sessionID) =>
          sessionID === "ses_key"
            ? { calls: [{ tool: "bash", ok: true, exit: 0, command, paths: [] }] }
            : { calls: [] },
        readEpisodeEvents: () => ({ events: [] }),
        onEpisodeClosed: (episode) => shadow.onEpisodeClosed(episode),
      })
      const episode = coordinator.captureRun(run.id)!
      await flush()
      const plan = repository.getPlan(planID(episode.id))!
      const matches = plan.entries.flatMap((entry) => (entry.id.startsWith("command:") ? [entry.id] : []))
      repository.close()
      return matches
    }

    const first = await commandIDsFor(OPAQUE_KEY)
    const second = await commandIDsFor(OPAQUE_KEY)
    expect(first).toHaveLength(1)
    // Stability: a re-capture of the same value converges on the same id.
    expect(first).toEqual(second)
    // Keyed: the id is not the truncated keyless digest, which would be a dictionary oracle.
    const keyless = `command:${createHash("sha256").update(command).digest("hex").slice(0, 16)}`
    expect(first[0]).not.toBe(keyless)
  })
})

describe("the skillRelevance usage seam (FH-043)", () => {
  /** A stub service so the selection is controlled: the point here is the wiring, not the scorer. */
  const serviceReturning = (load: readonly string[]): DecisionService => ({
    async predict<Q extends DecisionKind>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      const answer = (
        request.kind === "skillRelevance" ? { load: [...load] } : { verdict: "complete" }
      ) as DecisionSpec[Q]["answer"]
      return {
        kind: request.kind,
        answer,
        source: "deterministic",
        provider: "stub",
        latencyMs: 0,
        degraded: false,
        baseline: answer,
        baselineRule: "stub",
        inputsHash: "hash",
        decidedAt: NOW,
      }
    },
    decisions: () => [],
    explain: () => undefined,
  })

  const config = () => resolveAdaptiveConfig({ block: { shadow: true }, env: {} })

  test("a closed episode reports exactly one opportunity with the roster and the selected names", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const selections: SkillSelection[] = []
    const service = serviceReturning(["testing"])
    const shadow = createShadowRunner({
      service,
      repository,
      config,
      context: createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW }),
      readSkills: () => SKILLS,
      trackSelection: (selection) => selections.push(selection),
    })
    coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)
    await flush()

    expect(selections).toEqual([{ projectID: "/work/project", roster: SKILLS, loaded: ["testing"] }])
    repository.close()
  })

  test("the roster is read once per close, shared by the request and the selection", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    let reads = 0
    const service = serviceReturning(["testing"])
    const shadow = createShadowRunner({
      service,
      repository,
      config,
      context: createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW }),
      readSkills: () => {
        reads += 1
        return SKILLS
      },
      trackSelection: () => {},
    })
    coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)
    await flush()

    expect(reads).toBe(1)
    repository.close()
  })

  test("a second close is not a second opportunity", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const selections: SkillSelection[] = []
    // The real service so the first close actually audits the decision the second close must see.
    const service = serviceFor(repository, true)
    const shadow = createShadowRunner({
      service,
      repository,
      config,
      context: createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW }),
      readSkills: () => SKILLS,
      trackSelection: (selection) => selections.push(selection),
    })
    const episode = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)!
    await flush()
    shadow.onEpisodeClosed(episode)
    await flush()

    // The opportunity counter advances once per episode, not once per close.
    expect(repository.countDecisionsForEpisode(episode.id, "skillRelevance")).toBe(1)
    expect(selections).toHaveLength(1)
    repository.close()
  })

  test("a tracker that throws is reported and never reaches the episode", async () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const run = seedRun(repository)
    const errors: unknown[] = []
    const service = serviceReturning(["testing"])
    const shadow = createShadowRunner({
      service,
      repository,
      config,
      context: createContextManager({ repository, service, config, opaqueKey: () => OPAQUE_KEY, now: () => NOW }),
      readSkills: () => SKILLS,
      trackSelection: () => {
        throw new Error("track boom")
      },
      onError: (cause) => errors.push(cause),
    })
    const episode = coordinatorFor(repository, (entry) => shadow.onEpisodeClosed(entry)).captureRun(run.id)!
    await flush()

    expect(episode.id).toBe(runEpisodeID(run.id))
    // The episode row the callback saw is untouched: a tracker failure is not a session failure.
    expect(repository.getEpisode(episode.id)).toEqual(episode)
    expect(errors.some((cause) => cause instanceof Error && cause.message === "track boom")).toBe(true)
    repository.close()
  })
})
