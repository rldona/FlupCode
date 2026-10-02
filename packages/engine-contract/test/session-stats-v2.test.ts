import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
import { startModel } from "../src/model"

/**
 * The engine's own usage statistics across sessions (UL-09): `GET /api/experimental/session/stats`,
 * which the home dashboard reads for sessions, active days, the streak and the activity per day.
 * Upstream marks the route experimental, so a pin bump that moves or reshapes it fails here.
 */

const run = CONTRACT_LINE === "v2"
const model = startModel()
// The stub answers every call with 10 input and 5 output tokens: $0.01 + $0.01 = $0.02 per call.
const price = { input: 1000, output: 2000 }
const perCall = 0.02
let engine: Engine
let stream: ReturnType<typeof recordEvents>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url, price })
  stream = recordEvents(`${engine.url}/api/event`, engine.authorization)
  await stream.opened
})

beforeEach(() => model.reset())

afterAll(async () => {
  stream?.close()
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("session stats on OpenCode 2", () => {
  test("the route counts sessions, model calls, days and models, and leaves the title call out", async () => {
    const before = await stats()
    expect(Object.keys(before).sort()).toEqual(
      ["activeDays", "activity", "cost", "models", "prompts", "range", "sessions", "steps", "streak", "subagents", "tokens", "tools"].sort(),
    )
    const session = ((await call("POST", "/api/session", {})) as { data: { id: string } }).data.id
    model.push({ type: "text", text: "Done" })
    await call("POST", `/api/session/${session}/prompt`, { text: "Hello" })
    await stream.until((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session)

    const after = await stats()
    expect(after.sessions).toBe(before.sessions + 1)
    expect(after.steps).toBe(before.steps + 1)
    expect(after.activeDays).toBeGreaterThanOrEqual(1)
    expect(after.streak).toBeGreaterThanOrEqual(1)
    expect(after.activity.at(-1)).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), steps: expect.any(Number) })
    expect(after.models).toEqual([
      expect.objectContaining({ model: expect.objectContaining({ id: "stub-model", providerID: "stub" }), steps: after.steps }),
    ])
    // The engine titled the session with a second, billed call: it is in the session's cost and not a
    // step, so the stats leave it out, as the usage ledger does (UL-03). They agree with the ledger.
    const sessionCost = ((await call("GET", `/api/session/${session}`)) as { data: { cost: number } }).data.cost
    expect(after.cost - before.cost).toBeCloseTo(perCall, 10)
    expect(sessionCost).toBeCloseTo(2 * perCall, 10)
  })

  test("a period narrows it, and one that ends before it starts is refused", async () => {
    const later = Date.now() + 60_000
    expect(await stats(`?from=${later}&to=${later + 1000}`)).toMatchObject({ sessions: 0, steps: 0, activity: [], models: [] })
    await expect(stats(`?from=${later}&to=${later - 1000}`)).rejects.toThrow("400")
  })
})

type Stats = {
  sessions: number
  steps: number
  cost: number
  activeDays: number
  streak: number
  activity: Array<{ date: string; steps: number }>
  models: Array<{ model: { id: string; providerID: string }; steps: number }>
}

async function stats(query = "") {
  return ((await call("GET", `/api/experimental/session/stats${query}`)) as { data: Stats }).data
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${engine.url}${path}`, {
    method,
    headers: {
      authorization: engine.authorization,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(engine.project),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<unknown>
}
