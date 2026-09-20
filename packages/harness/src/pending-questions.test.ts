import { describe, expect, test } from "bun:test"
import { questionSessions } from "./pending-questions"

describe("which sessions are waiting on a question answer", () => {
  test("only entries with options to answer count, once each", () => {
    expect(
      questionSessions([
        { sessionID: "a", questions: [{}, {}] },
        { sessionID: "a", questions: [{}] },
        { sessionID: "b", questions: [] },
        { sessionID: "c" },
        { sessionID: "d", questions: "nope" },
      ]),
    ).toEqual(["a"])
  })

  test("nothing pending, or nothing given, is no one", () => {
    expect(questionSessions([])).toEqual([])
    expect(questionSessions(undefined)).toEqual([])
  })
})
