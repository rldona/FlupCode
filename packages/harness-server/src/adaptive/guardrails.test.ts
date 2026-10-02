/**
 * The guardrail service (FH-060–063, ADR-0023).
 *
 * The service is the policy point: off touches no ring and writes nothing; off-legacy is inert; below
 * the thresholds only accumulates; a detected loop runs the failure decision hot and
 * `shadow: false`, returns an advisory verdict, and caches the decision so a persistent loop does not
 * re-spend or rewrite.
 */

import { describe, expect, test } from "bun:test"
import { SqliteRoutineRepository } from "../repository"
import type { AdaptiveConfig } from "./config"
import { resolveAdaptiveConfig } from "./config"
import { createAdaptiveEgressGuard } from "./egress"
import { createDecisionService } from "./decision-service"
import { createGuardrailService } from "./guardrails"
import { armFor } from "./holdout"
import type { LoopObservation } from "./guardrails-detector"
import type { RuntimeCapabilities } from "./runtime"

const NOW = 1_700_000_000_000
const PROJECT = "/work/project"

const legacy: RuntimeCapabilities = {
  runtime: "legacy",
  degraded: false,
  canUseLegacyHooks: true,
  canInjectSystemPrompt: true,
  canObserveToolCalls: true,
  canObserveCompaction: true,
  canTransformMessages: true,
  canUseSdkPath: true,
  checkedAt: 0,
}

const v2: RuntimeCapabilities = { ...legacy, runtime: "v2", degraded: true, canObserveToolCalls: false }

const call = (tool: string, argsDigest: string): LoopObservation => ({ kind: "call", tool, argsDigest })
const error = (tool: string, errorDigest: string): LoopObservation => ({ kind: "error", tool, errorDigest })

const stack = (options: { block?: Record<string, unknown>; capabilities?: RuntimeCapabilities; clock?: () => number } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  let block: Record<string, unknown> = options.block ?? { guardrails: { enabled: true } }
  const config = (): AdaptiveConfig => resolveAdaptiveConfig({ block, env: {} })
  const egress = createAdaptiveEgressGuard({ config })
  // One clock for the service and the decision writer, so a row's `updatedAt` is a faithful witness
  // of whether `predict` ran again (the writer upserts on the deterministic id).
  const clock = options.clock ?? (() => NOW)
  const decisions = createDecisionService({ repository, config, egress, now: clock })
  const guardrails = createGuardrailService({
    service: decisions,
    runtimeProbe: { capabilities: () => options.capabilities ?? legacy },
    config,
    now: clock,
  })
  return {
    repository,
    guardrails,
    decisions,
    setBlock: (next: Record<string, unknown>) => {
      block = next
    },
  }
}

const observe = (
  guardrails: ReturnType<typeof stack>["guardrails"],
  observation: LoopObservation,
  sessionID = "ses_1",
) => guardrails.observe({ projectID: PROJECT, sessionID, observation })

describe("the guardrail service gate", () => {
  test("with the feature off it touches no ring and writes no row", async () => {
    const { repository, guardrails, setBlock } = stack({ block: { guardrails: { enabled: false } } })
    expect(await observe(guardrails, call("bash", "a"))).toMatchObject({ verdict: "continue", reason: "disabled" })
    expect(repository.listDecisions()).toHaveLength(0)

    // If the disabled call had touched the ring, the first enabled call would already count two.
    setBlock({ guardrails: { enabled: true } })
    const first = await observe(guardrails, call("bash", "a"))
    expect(first).toMatchObject({ reason: "below-threshold", repeatedCalls: 1 })
    repository.close()
  })

  test("off-legacy it is inert and writes no row", async () => {
    const { repository, guardrails } = stack({ capabilities: v2 })
    expect(await observe(guardrails, call("bash", "a"))).toMatchObject({
      verdict: "continue",
      reason: "runtime-not-legacy",
    })
    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })

  test("an unknown runtime is inert too and writes no row", async () => {
    const { repository, guardrails } = stack({
      capabilities: { ...legacy, runtime: "unknown", degraded: true, canObserveToolCalls: false },
    })
    expect(await observe(guardrails, call("bash", "a"))).toMatchObject({
      verdict: "continue",
      reason: "runtime-not-legacy",
    })
    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })

  test("below the threshold it accumulates without a decision", async () => {
    const { repository, guardrails } = stack()
    expect(await observe(guardrails, call("bash", "a"))).toMatchObject({ reason: "below-threshold", repeatedCalls: 1 })
    expect(await observe(guardrails, call("bash", "a"))).toMatchObject({ reason: "below-threshold", repeatedCalls: 2 })
    expect(repository.listDecisions()).toHaveLength(0)
    repository.close()
  })
})

describe("a detected loop", () => {
  test("intervenes and writes one shadow:false failure row", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    const result = await observe(guardrails, call("bash", "a"))

    expect(result).toMatchObject({
      verdict: "intervene",
      reason: "loop",
      repeatedCalls: 3,
      repeatedErrors: 0,
      steps: "unsupported",
      decisionID: "failure:ses_1:bash:a",
      source: "baseline",
      degraded: false,
    })
    expect(result).not.toHaveProperty("risk")
    const rows = repository.listDecisions()
    // The failure row alone: no `toolRisk` companion is asked or written any more (PI-03).
    expect(rows.map((row) => row.kind)).toEqual(["failure"])
    const failure = rows.find((row) => row.kind === "failure")
    expect(failure).toMatchObject({ id: "failure:ses_1:bash:a", shadow: false, kind: "failure" })
    expect(failure?.policy.repeatedCalls).toBe(3)
    expect(failure?.arm).toBe("treatment")
    repository.close()
  })

  test("a control session is decided and audited but never raised or shown", async () => {
    const session = Array.from({ length: 100 }, (_, index) => `ses_${index}`).find(
      (id) => armFor(id, "guardrails", 0.2) === "control",
    )!
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"), session)
    await observe(guardrails, call("bash", "a"), session)
    const result = await observe(guardrails, call("bash", "a"), session)

    expect(result).toMatchObject({ verdict: "continue", reason: "holdout", repeatedCalls: 3 })
    expect(guardrails.status(session)).toBeNull()
    const failure = repository.listDecisions().find((row) => row.kind === "failure")
    expect(failure).toMatchObject({ sessionID: session, shadow: false, arm: "control" })
    repository.close()
  })

  test("a repeated error is keyed by its digest and reasoned as error", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, error("bash", "x"))
    await observe(guardrails, error("bash", "x"))
    const result = await observe(guardrails, error("bash", "x"))

    expect(result).toMatchObject({ verdict: "intervene", reason: "error", decisionID: "failure:ses_1:bash:x" })
    repository.close()
  })

  test("a persistent loop is cached: no second spend and no rewrite, counts stay current", async () => {
    let clock = NOW
    const { repository, guardrails } = stack({ clock: () => clock })
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    // The failure row, written once by the detecting observation.
    expect(repository.listDecisions()).toHaveLength(1)
    const written = repository.listDecisions().find((row) => row.kind === "failure")!

    clock = NOW + 10
    const again = await observe(guardrails, call("bash", "a"))
    expect(again).toMatchObject({ decisionID: "failure:ses_1:bash:a", repeatedCalls: 4, verdict: "intervene" })
    // A cache miss would re-run `predict`, whose upsert on the deterministic id would move the row's
    // `updatedAt` to the newer clock. It did not move: no second spend and no rewrite.
    expect(repository.listDecisions().find((row) => row.kind === "failure")!.updatedAt).toBe(written.updatedAt)
    repository.close()
  })

  test("a changed argument starts a new run and a new decision id", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    const changed = await observe(guardrails, call("bash", "b"))
    expect(changed).toMatchObject({ reason: "below-threshold", repeatedCalls: 1 })
    expect(changed.decisionID).toBeUndefined()
    repository.close()
  })

  test("reads its thresholds from the config", async () => {
    const { repository, guardrails } = stack({ block: { guardrails: { enabled: true, repeatedCalls: 2 } } })
    await observe(guardrails, call("bash", "a"))
    const result = await observe(guardrails, call("bash", "a"))
    expect(result).toMatchObject({ verdict: "intervene", reason: "loop", repeatedCalls: 2 })
    repository.close()
  })

  test("separate sessions keep separate rings", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"), "ses_1")
    await observe(guardrails, call("bash", "a"), "ses_2")
    expect(await observe(guardrails, call("bash", "a"), "ses_2")).toMatchObject({
      repeatedCalls: 2,
      reason: "below-threshold",
    })
    repository.close()
  })

  test("bounds the number of session rings, evicting the oldest", async () => {
    const { repository, guardrails } = stack({ block: { guardrails: { enabled: true, maxSessions: 1 } } })
    await observe(guardrails, call("bash", "a"), "ses_1")
    await observe(guardrails, call("bash", "a"), "ses_1")
    // ses_2 evicts ses_1's ring, so the next ses_1 observation starts a fresh run of one.
    await observe(guardrails, call("bash", "a"), "ses_2")
    expect(await observe(guardrails, call("bash", "a"), "ses_1")).toMatchObject({
      reason: "below-threshold",
      repeatedCalls: 1,
    })
    repository.close()
  })
})

describe("the decision cache", () => {
  test("expires after the window, so a later loop is decided again", async () => {
    let clock = NOW
    const { repository, guardrails } = stack({ clock: () => clock })
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    const first = await observe(guardrails, call("bash", "a"))
    expect(first.decisionID).toBe("failure:ses_1:bash:a")

    clock = NOW + 600_001
    const later = await observe(guardrails, call("bash", "a"))
    // The ring's window dropped the old observations, so this is a fresh single observation.
    expect(later).toMatchObject({ reason: "below-threshold", repeatedCalls: 1 })
    repository.close()
  })
})

describe("the read-only status projection", () => {
  test("with the feature off there is nothing live to read", () => {
    const { repository, guardrails } = stack({ block: { guardrails: { enabled: false } } })
    expect(guardrails.status("ses_1")).toBeNull()
    repository.close()
  })

  test("off-legacy there is nothing live to read", () => {
    const { repository, guardrails } = stack({ capabilities: v2 })
    expect(guardrails.status("ses_1")).toBeNull()
    repository.close()
  })

  test("below the threshold it projects nothing", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    expect(guardrails.status("ses_1")).toBeNull()
    repository.close()
  })

  test("a loop projects its counts, tool, id and the last observation", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    expect(guardrails.status("ses_1")).toEqual({
      reason: "loop",
      repeatedCalls: 3,
      repeatedErrors: 0,
      tool: "bash",
      decisionID: "failure:ses_1:bash:a",
      at: NOW,
    })
    repository.close()
  })

  test("a repeated error projects the error reason and its own id", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, error("bash", "x"))
    await observe(guardrails, error("bash", "x"))
    await observe(guardrails, error("bash", "x"))
    expect(guardrails.status("ses_1")).toMatchObject({
      reason: "error",
      repeatedCalls: 0,
      repeatedErrors: 3,
      decisionID: "failure:ses_1:bash:x",
    })
    repository.close()
  })

  test("a broken streak stops projecting, without a new row", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "b"))
    expect(guardrails.status("ses_1")).toBeNull()
    repository.close()
  })

  test("an expired window stops projecting", async () => {
    let clock = NOW
    const { repository, guardrails } = stack({ clock: () => clock })
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    clock = NOW + 600_001
    expect(guardrails.status("ses_1")).toBeNull()
    repository.close()
  })

  test("another session is not projected from this session's ring", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    expect(guardrails.status("ses_2")).toBeNull()
    repository.close()
  })

  test("a loop in another session is not projected for this one", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"), "ses_2")
    await observe(guardrails, call("bash", "a"), "ses_2")
    await observe(guardrails, call("bash", "a"), "ses_2")
    expect(guardrails.status("ses_1")).toBeNull()
    // The loop is still live for the session that owns it: isolation, not suppression.
    expect(guardrails.status("ses_2")).toMatchObject({
      reason: "loop",
      decisionID: "failure:ses_2:bash:a",
    })
    repository.close()
  })

  test("an empty or unknown session id projects nothing", async () => {
    const { repository, guardrails } = stack()
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    await observe(guardrails, call("bash", "a"))
    // Neither an empty id nor one that never fed the ring has a loop to project.
    expect(guardrails.status("")).toBeNull()
    expect(guardrails.status("ses_never_seen")).toBeNull()
    repository.close()
  })
})
