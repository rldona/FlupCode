import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "../src/engine"
import { recordEvents } from "../src/events"
import { startModel } from "../src/model"

/**
 * How the pinned engine adds up what a session cost (UL-04, audit §8.4).
 *
 * The usage ledger rolls a session up with its subagents by summing the session tree. That is only
 * right if the engine's own `SessionInfo.cost` of a parent leaves its children out; if it included
 * them, summing the tree would count every subagent twice. The stub model is priced so every call
 * costs something, and the parent calls the `subagent` tool once.
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

describe.skipIf(!run)("session cost on OpenCode 2", () => {
  test("a parent's cost leaves out its subagent's, and its title call is in it", async () => {
    const parent = ((await call("POST", "/api/session", {})) as { data: SessionInfo }).data.id
    model.push(
      { type: "tool", name: "subagent", input: { agent: "general", description: "child work", prompt: "Do the child work" } },
      { type: "text", text: "Child done" },
      { type: "text", text: "Parent done" },
    )
    await call("POST", `/api/session/${parent}/prompt`, { text: "Delegate it" })
    await stream.until(
      (event) => event.type === "session.execution.succeeded" && event.data.sessionID === parent,
    )

    const sessions = ((await call("GET", "/api/session")) as { data: SessionInfo[] }).data
    const child = sessions.find((session) => session.parentID === parent)
    expect(child).toBeDefined()
    // The child made one call. The parent made two (the tool call, then its answer) and the engine
    // titled it, which is a third call billed to the parent; the child got no title call.
    const childCost = (await get(child!.id)).cost
    const parentCost = (await get(parent)).cost
    expect(childCost).toBeCloseTo(perCall, 10)
    expect(parentCost).toBeCloseTo(3 * perCall, 10)
    // So the session with its subagents is the sum over the tree, with nothing counted twice.
    expect(parentCost + childCost).toBeCloseTo(4 * perCall, 10)
    // A step's cost is reported on the step itself, in the session that made it.
    const steps = stream.events.filter(
      (event) => event.type === "session.step.ended" && [parent, child!.id].includes(event.data.sessionID as string),
    )
    expect(steps.map((event) => [event.data.sessionID === parent ? "parent" : "child", event.data.cost]).sort()).toEqual([
      ["child", perCall],
      ["parent", perCall],
      ["parent", perCall],
    ])
  })
})

type SessionInfo = { id: string; parentID?: string; cost: number }

async function get(sessionID: string) {
  return ((await call("GET", `/api/session/${sessionID}`)) as { data: SessionInfo }).data
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
  expect(response.ok).toBe(true)
  return response.json() as Promise<unknown>
}
