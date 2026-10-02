import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { CONTRACT_LINE, startEngine, type Engine as ContractEngine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { Engine } from "./engine"
import { SqliteRoutineRepository } from "./repository"
import { createUsageReconciler } from "./usage-reconciler"

/**
 * The usage reconciler (UL-03) against the pinned OpenCode 2 engine, with no plugin loaded: the ledger
 * is filled from the sessions' transcripts alone and must add up to what the engine says each session
 * cost. The stub model is priced, so every step costs something. It starts an engine, so it only runs
 * when asked, as CI's engine job does:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/usage-reconciler.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
const repositories: SqliteRoutineRepository[] = []
let contract: ContractEngine
let engine: Engine
let client: ReturnType<typeof OpenCode.make>

beforeAll(async () => {
  if (!run) return
  contract = await startEngine({ modelUrl: model.url, price: { input: 3, output: 15 } })
  engine = new Engine(contract.url, contract.authorization)
  client = OpenCode.make({ baseUrl: contract.url, headers: { authorization: contract.authorization } })
}, 120_000)

beforeEach(() => model.reset())

afterAll(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  await contract?.stop()
  model.stop()
})

const open = () => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  return repository
}

/**
 * The session once the work started after `since` is over, and its title too when the engine was
 * asked for one.
 */
const idle = async (sessionID: string, input: { since?: number; titled?: boolean } = {}) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const info = await client.session.get({ sessionID })
    const settled = (info.time.idle ?? 0) > (input.since ?? 0) && (!input.titled || info.title)
    if (settled && !(sessionID in (await client.session.active()))) return info
    await Bun.sleep(200)
  }
  throw new Error(`${sessionID} did not go idle`)
}

const ledgerCost = (repository: SqliteRoutineRepository, sessionID: string) =>
  repository.usageEvents(sessionID).reduce((sum, event) => sum + (event.costUSD ?? 0), 0)

describe.skipIf(!run)("the usage reconciler on an OpenCode 2 engine", () => {
  test("a session's ledger adds up to the engine's cost, and a second pass changes nothing", async () => {
    const repository = open()
    // A title of its own, so the engine asks the model for none: titles never reach a transcript.
    const { id } = await engine.createSession({ directory: contract.project, title: "Reconciled" })
    model.push(
      { type: "tool", name: "shell", input: { command: "echo reconciled", description: "Echo" } },
      { type: "text", text: "Done" },
    )
    await engine.prompt({ sessionID: id, text: "go" })
    const answered = await idle(id)
    // The stub's summary is not the template 2.x asks for: the compaction fails, and is still paid for.
    model.push({ type: "text", text: "Summary" })
    await client.session.compact({ sessionID: id })
    const info = await idle(id, { since: answered.time.idle })
    expect(info.cost).toBeGreaterThan(0)

    const reconciler = createUsageReconciler({ repository, engine, log: () => {} })
    const first = await reconciler.sweep()
    expect(first.events).toBe(3)
    expect(first.tools).toBe(1)

    const events = repository.usageEvents(id)
    expect(events.map((event) => event.kind).sort()).toEqual(["compaction", "step", "step"])
    expect(ledgerCost(repository, id)).toBeCloseTo(info.cost, 12)
    const tokens = events.reduce((sum, event) => sum + event.tokens.input + event.tokens.output, 0)
    expect(tokens).toBe(info.tokens.input + info.tokens.output)
    // The ids both paths agree on (UL-02): the session, the kind and the engine's message id.
    const steps = events.filter((event) => event.kind === "step")
    for (const step of steps) expect(step.id).toBe(`${id}:step:${step.messageID}`)
    expect(steps[0]).toMatchObject({
      sessionID: id,
      agent: "build",
      providerID: "stub",
      modelID: "stub-model",
      costBasis: "engine-list-price",
      billing: "unknown",
      directory: contract.project,
      engineProjectID: info.projectID,
      finish: "tool-calls",
    })
    expect(events.find((event) => event.kind === "compaction")).toMatchObject({ errorType: "compaction.failed" })
    expect(repository.toolEvents(id)).toEqual([
      expect.objectContaining({ id: expect.stringMatching(new RegExp(`^${id}:tool:`)), tool: "shell", error: false }),
    ])

    // Nothing changed in the engine: the session is not read again, and nothing is stored twice.
    expect(await reconciler.sweep()).toEqual({ sessions: 0, events: 0, tools: 0 })
    // A fresh reconciler (a restart) replays every transcript again: still nothing new.
    repository.db.exec("DELETE FROM usage_reconciled")
    const replay = await createUsageReconciler({ repository, engine, log: () => {} }).sweep()
    expect(replay.events).toBe(0)
    expect(replay.tools).toBe(0)
    expect(repository.usageEvents(id)).toEqual(events)
  })

  test("the title the engine generates is the only cost the ledger misses", async () => {
    const repository = open()
    // No title: the engine asks the model for one, and records it only on the session's total.
    const { id } = await engine.createSession({ directory: contract.project })
    model.push({ type: "text", text: "Done" })
    await engine.prompt({ sessionID: id, text: "go" })
    const info = await idle(id, { titled: true })

    await createUsageReconciler({ repository, engine, log: () => {} }).sweep()
    // The stub answers the title request with 10 input and 5 output tokens, priced as any step.
    const title = (10 * 3 + 5 * 15) / 1_000_000
    expect(info.cost - ledgerCost(repository, id)).toBeCloseTo(title, 12)
  })

  test("a failed step is kept as one, without a cost the engine did not report", async () => {
    const repository = open()
    const { id } = await engine.createSession({ directory: contract.project, title: "Refused" })
    model.push({ type: "error", status: 401, message: "Invalid API key provided" })
    await engine.prompt({ sessionID: id, text: "go" })
    const info = await idle(id)

    await createUsageReconciler({ repository, engine, log: () => {} }).sweep()
    const [failed] = repository.usageEvents(id)
    expect(failed).toMatchObject({ kind: "step_failed", errorType: "provider.auth", costBasis: "unpriced" })
    expect(failed?.id).toBe(`${id}:step_failed:${failed?.messageID}`)
    expect(failed?.costUSD).toBeUndefined()
    expect(ledgerCost(repository, id)).toBeCloseTo(info.cost, 12)
  })

  test("a session still running is left alone, and read on the pass after it goes idle", async () => {
    const repository = open()
    const reconciler = createUsageReconciler({ repository, engine, log: () => {} })
    await reconciler.sweep()
    const { id } = await engine.createSession({ directory: contract.project, title: "Running" })
    model.push({ type: "hang" })
    await engine.prompt({ sessionID: id, text: "go" })
    const deadline = Date.now() + 10_000
    while (!(await engine.isBusy(id)) && Date.now() < deadline) await Bun.sleep(100)

    await reconciler.sweep()
    expect(repository.usageReconciled(id)).toBeUndefined()

    model.push({ type: "text", text: "Done" })
    await engine.interrupt(id)
    const interrupted = await idle(id)
    await engine.prompt({ sessionID: id, text: "again" })
    const info = await idle(id, { since: interrupted.time.idle })
    await reconciler.sweep()
    expect(repository.usageReconciled(id)).toBe(info.time.updated)
    expect(repository.usageEvents(id).some((event) => event.kind === "step")).toBe(true)
  })

  test("a fork's copy of its parent's history is not billed again", async () => {
    const repository = open()
    const { id } = await engine.createSession({ directory: contract.project, title: "Original" })
    model.push({ type: "text", text: "Done" })
    await engine.prompt({ sessionID: id, text: "go" })
    await idle(id)
    const fork = await client.session.fork({ sessionID: id })
    const forked = await client.session.get({ sessionID: fork.id })
    expect(forked.cost).toBe(0)

    await createUsageReconciler({ repository, engine, log: () => {} }).sweep()
    expect(repository.usageEvents(id)).toHaveLength(1)
    expect(repository.usageEvents(fork.id)).toEqual([])
    expect(repository.toolEvents(fork.id)).toEqual([])
  })

  test("a subagent's steps name the session they roll up to", async () => {
    const repository = open()
    const { id: parent } = await engine.createSession({ directory: contract.project, title: "Parent" })
    model.push(
      { type: "tool", name: "subagent", input: { agent: "general", description: "Look", prompt: "Look around" } },
      { type: "text", text: "Looked" },
      { type: "text", text: "Done" },
    )
    await engine.prompt({ sessionID: parent, text: "delegate" })
    await idle(parent)
    const children = (await client.session.list({ parentID: parent })).data
    expect(children).toHaveLength(1)
    const child = children[0]!.id
    await idle(child)

    await createUsageReconciler({ repository, engine, log: () => {} }).sweep()
    expect(repository.usageEvents(child).length).toBeGreaterThan(0)
    for (const event of repository.usageEvents(child))
      expect(event).toMatchObject({ parentSessionID: parent, rootSessionID: parent })
    for (const event of repository.usageEvents(parent)) expect(event).toMatchObject({ rootSessionID: parent })
  })
})
