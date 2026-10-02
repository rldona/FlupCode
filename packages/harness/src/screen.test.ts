import { describe, expect, test } from "bun:test"
import {
  compareFromSearch,
  decisionFromSearch,
  screenFromPath,
  searchForCompare,
  searchForDecision,
  urlForScreen,
} from "./screen"

describe("the screen in the URL", () => {
  test("reads the screens it knows, with or without a trailing slash", () => {
    expect(screenFromPath("/runs")).toBe("runs")
    expect(screenFromPath("/routines/")).toBe("routines")
    expect(screenFromPath("/decisions")).toBe("decisions")
  })

  test("claims nothing else", () => {
    expect(screenFromPath("/")).toBeUndefined()
    expect(screenFromPath("")).toBeUndefined()
    expect(screenFromPath("/sessions")).toBeUndefined()
    expect(screenFromPath("/runs/1")).toBeUndefined()
    // The session replay screen never rendered and is gone (TI-12): its address is the home screen.
    expect(screenFromPath("/replay")).toBeUndefined()
  })

  test("keeps the query and the hash the address arrived with", () => {
    // Remote control pairs through the hash and the launcher through the query; both are read after
    // the first paint, so a screen change must not drop them.
    expect(urlForScreen("runs", { search: "?launch=1", hash: "#pair=eyJ2IjoxfQ" })).toBe(
      "/runs?launch=1#pair=eyJ2IjoxfQ",
    )
    expect(urlForScreen(undefined, { search: "", hash: "" })).toBe("/")
  })
})

describe("the runs a comparison link names (H-44)", () => {
  test("writes the first two runs into the address, and no more", () => {
    expect(searchForCompare(["a", "b", "c"])).toBe("?left=a&right=b")
    expect(searchForCompare(["a"])).toBe("?left=a")
    expect(searchForCompare([])).toBe("")
  })

  test("reads them back, with an absent side left for the reader to pick", () => {
    expect(compareFromSearch("?left=a&right=b")).toEqual({ left: "a", right: "b" })
    expect(compareFromSearch("?left=a")).toEqual({ left: "a", right: undefined })
    expect(compareFromSearch("")).toEqual({ left: undefined, right: undefined })
  })
})

describe("the decision a link focuses (AH-E05)", () => {
  test("round-trips an id that carries the characters decision ids have", () => {
    const id = "skillRelevance:ses_1:msg 2&x"
    expect(decisionFromSearch(searchForDecision(id))).toBe(id)
  })

  test("is nothing without the parameter, or with it empty", () => {
    expect(decisionFromSearch("")).toBeUndefined()
    expect(decisionFromSearch("?decision=")).toBeUndefined()
    expect(decisionFromSearch("?left=a")).toBeUndefined()
  })
})
