import { describe, expect, test } from "bun:test"
import { hunkCount, selectHunks, splitPatch } from "./patch"

const PATCH = [
  "diff --git a/x.ts b/x.ts",
  "index 1111111..2222222 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,3 +10,4 @@ a heading",
  " ten",
  " eleven",
  "+twelve",
  " twelve",
  "",
].join("\n")

describe("splitting a patch", () => {
  test("keeps the file header apart from the hunks, and counts them", () => {
    const { header, hunks } = splitPatch(PATCH)
    expect(header.split("\n")).toEqual([
      "diff --git a/x.ts b/x.ts",
      "index 1111111..2222222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
    ])
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toContain("-two")
    expect(hunks[1]).toContain("+twelve")
    expect(hunkCount(PATCH)).toBe(2)
  })

  test("a patch with no hunks is all header", () => {
    const { header, hunks } = splitPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n")
    expect(hunks).toEqual([])
    expect(header).toContain("+++ b/x")
  })
})

describe("putting hunks back", () => {
  test("keeps the file header and only the chosen hunk", () => {
    const one = selectHunks(PATCH, [1])
    expect(one).toContain("@@ -10,3 +10,4 @@ a heading")
    expect(one).not.toContain("@@ -1,3 +1,3 @@")
    expect(one.startsWith("diff --git a/x.ts b/x.ts")).toBe(true)
  })

  test("de-duplicates and orders, so a selection is written the same way twice", () => {
    expect(selectHunks(PATCH, [1, 0, 1])).toBe(selectHunks(PATCH, [0, 1]))
  })

  test("a hunk that is not there is refused, not silently dropped", () => {
    expect(() => selectHunks(PATCH, [2])).toThrow()
    expect(() => selectHunks(PATCH, [])).toThrow()
  })
})
