import { describe, expect, test } from "bun:test"
import { screenFromHash, urlForScreen } from "./screen"

const here = { pathname: "/", search: "" }

describe("the screen in the URL", () => {
  test("reads the screens it knows, in either spelling", () => {
    expect(screenFromHash("#runs")).toBe("runs")
    expect(screenFromHash("#/routines")).toBe("routines")
  })

  test("claims nothing else", () => {
    expect(screenFromHash("")).toBeUndefined()
    expect(screenFromHash("#")).toBeUndefined()
    expect(screenFromHash("#sessions")).toBeUndefined()
    // Remote control pairs through this same hash, and the link is not a screen.
    expect(screenFromHash("#pair=eyJ2IjoxfQ")).toBeUndefined()
  })

  test("keeps the path and the query a deep link arrived with", () => {
    expect(urlForScreen("runs", { pathname: "/app", search: "?launch=1" })).toBe("/app?launch=1#runs")
    expect(urlForScreen(undefined, { pathname: "/app", search: "?launch=1" })).toBe("/app?launch=1")
  })
})
