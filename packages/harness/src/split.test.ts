import { describe, expect, test } from "bun:test"
import { MAX_PANES, closePane, keepExisting, openInSplit, showInFocusedPane } from "./split"

describe("openInSplit", () => {
  test("splits the open session with the new one and focuses it", () => {
    expect(openInSplit({ panes: [], focus: "a" }, "b")).toEqual({ panes: ["a", "b"], focus: "b" })
  })

  test("with nothing open, or the same session, just opens it", () => {
    expect(openInSplit({ panes: [], focus: undefined }, "b")).toEqual({ panes: [], focus: "b" })
    expect(openInSplit({ panes: [], focus: "a" }, "a")).toEqual({ panes: [], focus: "a" })
  })

  test("adds panes, and focuses one that is already open", () => {
    expect(openInSplit({ panes: ["a", "b"], focus: "a" }, "c")).toEqual({ panes: ["a", "b", "c"], focus: "c" })
    expect(openInSplit({ panes: ["a", "b"], focus: "a" }, "b")).toEqual({ panes: ["a", "b"], focus: "b" })
  })

  test("at the limit, replaces the focused pane", () => {
    const panes = Array.from({ length: MAX_PANES }, (_, index) => `s${index}`)
    const next = openInSplit({ panes, focus: "s1" }, "new")
    expect(next.panes).toHaveLength(MAX_PANES)
    expect(next.panes[1]).toBe("new")
    expect(next.focus).toBe("new")
  })
})

describe("showInFocusedPane", () => {
  test("replaces the focused pane", () => {
    expect(showInFocusedPane({ panes: ["a", "b"], focus: "b" }, "c")).toEqual({ panes: ["a", "c"], focus: "c" })
  })

  test("focuses a session already in a pane, and does nothing special when not split", () => {
    expect(showInFocusedPane({ panes: ["a", "b"], focus: "b" }, "a")).toEqual({ panes: ["a", "b"], focus: "a" })
    expect(showInFocusedPane({ panes: [], focus: "a" }, "c")).toEqual({ panes: [], focus: "c" })
  })
})

describe("closePane", () => {
  test("closing down to one pane leaves split view on the other session", () => {
    expect(closePane({ panes: ["a", "b"], focus: "b" }, "b")).toEqual({ panes: [], focus: "a" })
    expect(closePane({ panes: ["a", "b"], focus: "b" }, "a")).toEqual({ panes: [], focus: "b" })
  })

  test("closing the focused pane focuses its neighbour", () => {
    expect(closePane({ panes: ["a", "b", "c"], focus: "b" }, "b")).toEqual({ panes: ["a", "c"], focus: "c" })
    expect(closePane({ panes: ["a", "b", "c"], focus: "c" }, "c")).toEqual({ panes: ["a", "b"], focus: "b" })
  })

  test("closing another pane keeps the focus", () => {
    expect(closePane({ panes: ["a", "b", "c"], focus: "a" }, "c")).toEqual({ panes: ["a", "b"], focus: "a" })
  })
})

describe("keepExisting", () => {
  test("drops deleted sessions", () => {
    expect(keepExisting({ panes: ["a", "b", "c"], focus: "a" }, (id) => id !== "b")).toEqual({
      panes: ["a", "c"],
      focus: "a",
    })
    expect(keepExisting({ panes: ["a", "b"], focus: "a" }, (id) => id !== "a")).toEqual({ panes: [], focus: "b" })
  })
})
