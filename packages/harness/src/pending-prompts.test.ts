import { describe, expect, test } from "bun:test"
import { pendingPrompts } from "./pending-prompts"

const expand = (text: string) => text
const serverUrl = "http://localhost:4096"

describe("pendingPrompts", () => {
  test("shows prompts that have no real message yet, keyed by session", () => {
    pendingPrompts.add({ id: "msg_a", sessionID: "ses_1", text: "one", files: [] })
    expect(pendingPrompts.forSession("ses_1", [], expand, serverUrl)).toEqual([
      { id: "msg_a", text: "one", files: [], delivery: undefined, sendNow: undefined },
    ])
    expect(pendingPrompts.forSession("ses_2", [], expand, serverUrl)).toEqual([])
    pendingPrompts.remove("msg_a")
  })

  test("drops a prompt once its message arrives", () => {
    pendingPrompts.add({ id: "msg_b", sessionID: "ses_3", text: "two", files: [], delivery: "queue" })
    pendingPrompts.reconcile(new Set(["msg_b"]))
    expect(pendingPrompts.forSession("ses_3", [], expand, serverUrl)).toEqual([])
  })

  // Steering already promotes the prompt at the next boundary of the running turn, so there is
  // nothing to hurry along; only a queued one waits for the session to go idle.
  test("offers send now only for prompts queued behind a running turn", () => {
    pendingPrompts.add({ id: "msg_c", sessionID: "ses_4", text: "three", files: [], delivery: "steer" })
    pendingPrompts.add({ id: "msg_d", sessionID: "ses_4", text: "four", files: [], delivery: "queue" })
    const pending = pendingPrompts.forSession("ses_4", [], expand, serverUrl)
    expect(pending[0]?.sendNow).toBeUndefined()
    expect(typeof pending[1]?.sendNow).toBe("function")
    pendingPrompts.remove("msg_c")
    pendingPrompts.remove("msg_d")
  })

  // 2.x holds queued prompts in the session inbox (V2-41): what it lists is what is waiting.
  test("takes in the prompts a session's inbox holds, and drops the ones it no longer lists", () => {
    pendingPrompts.adopt("ses_5", [
      { id: "msg_e", text: "five", files: [], delivery: "queue" },
      { id: "msg_f", text: "six", files: [], delivery: "steer" },
    ])
    expect(
      pendingPrompts.forSession("ses_5", [], expand, serverUrl).map((entry) => [entry.id, entry.delivery]),
    ).toEqual([
      ["msg_e", "queue"],
      ["msg_f", "steer"],
    ])
    pendingPrompts.adopt("ses_5", [{ id: "msg_f", text: "six", files: [], delivery: "steer" }])
    expect(pendingPrompts.forSession("ses_5", [], expand, serverUrl).map((entry) => entry.id)).toEqual(["msg_f"])
    pendingPrompts.adopt("ses_5", [])
    expect(pendingPrompts.forSession("ses_5", [], expand, serverUrl)).toEqual([])
  })

  test("keeps a prompt sent from here that the inbox does not list yet, and never releases it itself", () => {
    pendingPrompts.add({ id: "msg_g", sessionID: "ses_6", text: "seven", files: [], delivery: "queue", held: true })
    pendingPrompts.adopt("ses_6", [])
    // The engine releases what it holds; releasing it here as well would send it twice.
    pendingPrompts.release("ses_6", expand, serverUrl)
    const pending = pendingPrompts.forSession("ses_6", [], expand, serverUrl)
    expect(pending.map((entry) => [entry.id, entry.delivery])).toEqual([["msg_g", "queue"]])
    expect(typeof pending[0]?.cancel).toBe("function")
    pendingPrompts.remove("msg_g")
  })
})
