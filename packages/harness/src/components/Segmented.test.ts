import { describe, expect, test } from "bun:test"
import { segmentTarget } from "./Segmented"

describe("the arrow keys over a level or capability selector (AH-E06)", () => {
  const all = [true, true, true, true]

  test("the arrows step to the next and previous option, and wrap at both ends", () => {
    expect(segmentTarget(all, 0, "ArrowRight")).toBe(1)
    expect(segmentTarget(all, 1, "ArrowDown")).toBe(2)
    expect(segmentTarget(all, 3, "ArrowRight")).toBe(0)
    expect(segmentTarget(all, 0, "ArrowLeft")).toBe(3)
    expect(segmentTarget(all, 2, "ArrowUp")).toBe(1)
  })

  test("Home and End go to the first and last option that can be picked", () => {
    expect(segmentTarget([false, true, true, false], 2, "Home")).toBe(1)
    expect(segmentTarget([false, true, true, false], 1, "End")).toBe(2)
  })

  test("an option that cannot be picked is stepped over, both ways", () => {
    // Off, Observe, Assist, Custom — with Assist blocked by a guard and Custom offered only from a mix.
    const levels = [true, true, false, false]
    expect(segmentTarget(levels, 1, "ArrowRight")).toBe(0)
    expect(segmentTarget(levels, 0, "ArrowLeft")).toBe(1)
  })

  test("from an option that cannot be picked, the arrows still find the next one", () => {
    expect(segmentTarget([true, false, true], 1, "ArrowRight")).toBe(2)
    expect(segmentTarget([true, false, true], 1, "ArrowLeft")).toBe(0)
  })

  test("any other key is not a move, and nothing moves when nothing can be picked", () => {
    expect(segmentTarget(all, 1, "Enter")).toBeUndefined()
    expect(segmentTarget(all, 1, " ")).toBeUndefined()
    expect(segmentTarget([false, false], 0, "ArrowRight")).toBeUndefined()
    expect(segmentTarget([false, false], 0, "Home")).toBeUndefined()
  })
})
