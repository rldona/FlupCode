import { describe, expect, test } from "bun:test"
import { pendingPrompts } from "./pending-prompts"

const expand = (text: string) => text
const serverUrl = "http://localhost:4096"

describe("pendingPrompts", () => {
  test("shows prompts that have no real message yet, keyed by session", () => {
    pendingPrompts.add({ id: "msg_a", sessionID: "ses_1", text: "one", files: [], queued: false })
    expect(pendingPrompts.forSession("ses_1", [], expand, serverUrl)).toEqual([
      { id: "msg_a", text: "one", files: [], queued: false },
    ])
    expect(pendingPrompts.forSession("ses_2", [], expand, serverUrl)).toEqual([])
    pendingPrompts.remove("msg_a")
  })

  test("drops a prompt once its message arrives", () => {
    pendingPrompts.add({ id: "msg_b", sessionID: "ses_3", text: "two", files: [], queued: true })
    pendingPrompts.reconcile(new Set(["msg_b"]))
    expect(pendingPrompts.forSession("ses_3", [], expand, serverUrl)).toEqual([])
  })

  test("offers send now only for prompts queued behind a running turn", () => {
    pendingPrompts.add({ id: "msg_c", sessionID: "ses_4", text: "three", files: [], queued: false })
    pendingPrompts.add({ id: "msg_d", sessionID: "ses_4", text: "four", files: [], queued: true })
    const pending = pendingPrompts.forSession("ses_4", [], expand, serverUrl)
    expect(pending[0]?.sendNow).toBeUndefined()
    expect(typeof pending[1]?.sendNow).toBe("function")
    pendingPrompts.remove("msg_c")
    pendingPrompts.remove("msg_d")
  })
})
