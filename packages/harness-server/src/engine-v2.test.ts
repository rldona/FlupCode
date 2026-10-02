import { describe, expect, test } from "bun:test"
import { answerOf } from "./engine-v2"

/**
 * How a turn's transcript reads as an answer (TI-02). The shapes are the ones the pinned engine
 * writes, as `runner.engine.test.ts` and `engine-contract` record them: a step per assistant message,
 * an `error` on a step the provider refused, and an `idle` marker with the turn's outcome.
 */
const user = { type: "user", text: "Do it" }
const step = (fields: Record<string, unknown>) => ({ type: "assistant", content: [], cost: 0, ...fields })
const idle = (outcome: string) => ({ type: "idle", outcome })
const read = (...messages: unknown[]) => answerOf(messages as never)

describe("the answer of a turn", () => {
  test("a step that ended in the provider's error is the turn's failure", () => {
    const refused = step({ error: { type: "provider.auth", message: "Invalid API key provided", status: 401 } })
    expect(read(user, refused, idle("failed"))).toMatchObject({ error: "Invalid API key provided", cost: 0 })
  })

  test("a turn with no step at all failed, even when nothing says why", () => {
    expect(read(user, idle("succeeded")).error).toBe("The engine ended the turn without answering")
  })

  test("an earlier step's error does not fail a turn whose last step answered", () => {
    const answered = step({
      content: [{ type: "text", text: "Done" }],
      tokens: { input: 10, output: 5 },
      cost: 0.002,
    })
    const refused = step({ error: { type: "provider.rate-limit", message: "Slow down", status: 429 }, cost: 0.001 })
    expect(read(user, refused, answered, idle("succeeded"))).toEqual({ text: "Done", tokens: 15, cost: 0.003 })
  })

  test("a failed or interrupted outcome with no step error still fails the turn", () => {
    const quiet = step({ content: [{ type: "text", text: "Partial" }] })
    expect(read(user, quiet, idle("failed")).error).toBe("The engine reported the turn as failed")
    expect(read(user, quiet, idle("interrupted")).error).toBe("The turn was interrupted")
  })

  test("only the last turn counts", () => {
    const refused = step({ error: { type: "provider.auth", message: "Invalid API key provided", status: 401 } })
    const answered = step({ content: [{ type: "text", text: "Fixed" }] })
    expect(read(user, refused, idle("failed"), user, answered, idle("succeeded")).error).toBeUndefined()
  })
})
