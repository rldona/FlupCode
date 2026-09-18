import { describe, expect, test } from "bun:test"
import { compareFromSearch, screenFromPath, searchForCompare, urlForScreen } from "./screen"

describe("the screen in the URL", () => {
  test("reads the screens it knows, with or without a trailing slash", () => {
    expect(screenFromPath("/runs")).toBe("runs")
    expect(screenFromPath("/routines/")).toBe("routines")
  })

  test("claims nothing else", () => {
    expect(screenFromPath("/")).toBeUndefined()
    expect(screenFromPath("")).toBeUndefined()
    expect(screenFromPath("/sessions")).toBeUndefined()
    expect(screenFromPath("/runs/1")).toBeUndefined()
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
