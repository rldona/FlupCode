import { describe, expect, test } from "bun:test"
import { screenFromPath, urlForScreen } from "./screen"

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
