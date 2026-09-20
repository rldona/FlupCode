import { describe, expect, test } from "bun:test"
import { parseTags } from "./TagsDialog"

describe("parseTags", () => {
  test("splits on commas and newlines, trims, and drops what is blank", () => {
    expect(parseTags("work, home")).toEqual(["work", "home"])
    expect(parseTags("a\nb ,  c ")).toEqual(["a", "b", "c"])
    expect(parseTags(" , ")).toEqual([])
  })

  test("the same tag written twice is one tag, in the order it was given", () => {
    expect(parseTags("work, home, work")).toEqual(["work", "home"])
  })
})
