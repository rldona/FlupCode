import { describe, expect, test } from "bun:test"
import { messageID } from "./ids"

describe("messageID", () => {
  test("brands ids and keeps them ascending, like the engine's", () => {
    const first = messageID()
    const second = messageID()
    expect(first.startsWith("msg_")).toBe(true)
    expect(first.length).toBe("msg_".length + 26)
    expect(second > first).toBe(true)
  })
})
