import { expect, test } from "bun:test"
import { childSentence } from "./ChildBanner"

/** The banner names which child stopped and why, and whether it is coming back (HE-03). */

test("a restarting child says it is coming back, and why it stopped", () => {
  const sentence = childSentence({
    name: "engine",
    phase: "restarting",
    restarts: 1,
    failure: { reason: "exit", message: "was stopped by SIGKILL", lastLines: [] },
    log: "/tmp/engine.log",
  })
  expect(sentence).toBe("The engine stopped (was stopped by SIGKILL) and is restarting…")
})

test("a child the supervisor gave up on names the reason", () => {
  const sentence = childSentence({
    name: "harness",
    phase: "failed",
    restarts: 5,
    failure: { reason: "exit", message: "exited with code 1; gave up after 5 restarts", lastLines: [] },
    log: "/tmp/harness.log",
  })
  expect(sentence).toBe(
    "The harness server stopped and could not be restarted: exited with code 1; gave up after 5 restarts",
  )
})
