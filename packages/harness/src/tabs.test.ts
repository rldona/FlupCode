import { describe, expect, test } from "bun:test"
import { closeTab, cycleTab, keepTabs, openTab, tabAfterClose } from "./tabs"

describe("session tabs (H-36)", () => {
  test("opening adds to the end, and an open session keeps its place", () => {
    expect(openTab(["a"], "b")).toEqual(["a", "b"])
    expect(openTab(["a", "b"], "a")).toEqual(["a", "b"])
  })

  test("closing picks the neighbour on the right, or the one on the left at the end", () => {
    expect(tabAfterClose(["a", "b", "c"], "b")).toBe("c")
    expect(tabAfterClose(["a", "b", "c"], "c")).toBe("b")
    expect(tabAfterClose(["a"], "a")).toBeUndefined()
    // Closing something that is not a tab leaves the first as the answer, rather than nothing.
    expect(tabAfterClose(["a", "b"], "ghost")).toBe("a")
  })

  test("cycling wraps in both directions, from nothing and from a tab", () => {
    expect(cycleTab(["a", "b", "c"], "b", 1)).toBe("c")
    expect(cycleTab(["a", "b", "c"], "c", 1)).toBe("a")
    expect(cycleTab(["a", "b", "c"], "a", -1)).toBe("c")
    // No active tab: forward starts at the first, backward at the last.
    expect(cycleTab(["a", "b", "c"], undefined, 1)).toBe("a")
    expect(cycleTab(["a", "b", "c"], undefined, -1)).toBe("c")
    expect(cycleTab([], "a", 1)).toBeUndefined()
  })

  test("a tab whose session is gone is dropped", () => {
    expect(keepTabs(["a", "b", "c"], (id) => id !== "b")).toEqual(["a", "c"])
    expect(closeTab(["a", "b"], "b")).toEqual(["a"])
  })
})
