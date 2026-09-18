import { describe, expect, test } from "bun:test"
import { cascade, decodeBounds, decodeWindowStates, DEFAULT_BOUNDS } from "./window-bounds"

describe("where windows open (H-36)", () => {
  test("the first window keeps its bounds, and each next one steps down", () => {
    const base = { width: 1280, height: 840, x: 100, y: 80 }
    expect(cascade(base, 0)).toEqual(base)
    // A second window beside the first, not exactly on top of it.
    expect(cascade(base, 1)).toEqual({ width: 1280, height: 840, x: 128, y: 108 })
    expect(cascade(base, 2).x).toBe(156)
  })

  test("a window with no position cascades from the origin rather than nowhere", () => {
    expect(cascade(DEFAULT_BOUNDS, 1)).toMatchObject({ x: 28, y: 28 })
  })

  test("bounds are read only when they are a size", () => {
    expect(decodeBounds({ width: 800, height: 600, x: 1, y: 2 })).toEqual({ width: 800, height: 600, x: 1, y: 2 })
    expect(decodeBounds({ width: 800 })).toBeUndefined()
    expect(decodeBounds("nonsense")).toBeUndefined()
    expect(decodeBounds(null)).toBeUndefined()
  })

  test("an old file with one window is still read, and a list keeps every entry", () => {
    expect(decodeWindowStates({ width: 800, height: 600 })).toEqual([{ width: 800, height: 600 }])
    expect(
      decodeWindowStates([
        { width: 800, height: 600 },
        { width: 900, height: 700, x: 10, y: 20 },
        { broken: true },
      ]),
    ).toEqual([
      { width: 800, height: 600 },
      { width: 900, height: 700, x: 10, y: 20 },
    ])
    expect(decodeWindowStates(undefined)).toEqual([])
  })
})
