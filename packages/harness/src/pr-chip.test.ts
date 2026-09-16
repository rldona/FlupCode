import { describe, expect, test } from "bun:test"
import { verdictOf } from "./components/PullRequestChip"

describe("verdictOf", () => {
  test("a run still going wins over one that has already failed", () => {
    // The chip is read as "is it over yet". A red dot beside checks that are still running says the
    // answer is in when it is not.
    expect(verdictOf({ total: 3, passed: 1, failed: 1, running: 1 })).toBe("running")
  })

  test("failed beats passed once everything has finished", () => {
    expect(verdictOf({ total: 4, passed: 3, failed: 1, running: 0 })).toBe("failed")
  })

  test("all green is green", () => {
    expect(verdictOf({ total: 4, passed: 4, failed: 0, running: 0 })).toBe("passed")
  })

  test("a pull request with no checks at all has no verdict to give", () => {
    // Not "passed": nothing has vouched for it.
    expect(verdictOf({ total: 0, passed: 0, failed: 0, running: 0 })).toBe("none")
  })

  test("checks that all skipped have vouched for nothing, so they are not green", () => {
    // Two skipped runs and four green ones must not look the same. Nothing passed here.
    expect(verdictOf({ total: 2, passed: 0, failed: 0, running: 0 })).toBe("none")
  })
})
