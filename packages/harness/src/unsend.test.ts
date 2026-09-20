import { describe, expect, test } from "bun:test"
import { recoverablePrompt, type UnsendMessage } from "./unsend"

const user = (id: string, text = "do it"): UnsendMessage => ({ type: "user", id, text })
const assistant = (id: string, types: string[] = ["text"]): UnsendMessage => ({
  type: "assistant",
  id,
  content: types.map((type) => ({ type })),
})

describe("taking a sent prompt back", () => {
  test("the last user message alone is recoverable", () => {
    expect(recoverablePrompt([user("u1")], "u1")).toEqual({ text: "do it", deleteIDs: ["u1"] })
  })

  test("streaming text behind it stays recoverable, and is deleted with it", () => {
    expect(recoverablePrompt([user("u1"), assistant("a1"), assistant("a2", ["reasoning"])], "u1")).toEqual({
      text: "do it",
      deleteIDs: ["u1", "a2", "a1"],
    })
  })

  test("the first tool call ends it", () => {
    expect(recoverablePrompt([user("u1"), assistant("a1", ["text", "tool"])], "u1")).toBeUndefined()
    expect(recoverablePrompt([user("u1"), assistant("a1")], "u1")).toBeDefined()
  })

  test("a newer prompt owns recovery, not the older one", () => {
    const messages = [user("u1"), assistant("a1"), user("u2")]
    expect(recoverablePrompt(messages, "u1")).toBeUndefined()
    expect(recoverablePrompt(messages, "u2")).toEqual({ text: "do it", deleteIDs: ["u2"] })
  })

  test("unknown, non-user and empty prompts are not", () => {
    expect(recoverablePrompt([user("u1")], "nope")).toBeUndefined()
    expect(recoverablePrompt([user("u1"), assistant("a1")], "a1")).toBeUndefined()
    expect(recoverablePrompt([user("u1", "  ")], "u1")).toBeUndefined()
    expect(recoverablePrompt(undefined, "u1")).toBeUndefined()
  })
})
