import { describe, expect, test } from "bun:test"
import { hunkLabel, hunkLineCount, parseHunks } from "./patch"

describe("parseHunks", () => {
  test("drops the file header and keeps only what is inside a hunk", () => {
    const patch = [
      "diff --git a/file.ts b/file.ts",
      "index f384549..02b5054 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "",
    ].join("\n")
    const hunks = parseHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines.map((line) => line.text)).toEqual(["keep", "old", "new"])
  })

  test("numbers each side against its own file", () => {
    const patch = ["@@ -10,3 +20,4 @@", " keep", "-gone", "+added", "+more"].join("\n")
    expect(parseHunks(patch)[0]!.lines).toEqual([
      { type: "same", oldNo: 10, newNo: 20, text: "keep" },
      { type: "del", oldNo: 11, text: "gone" },
      { type: "add", newNo: 21, text: "added" },
      { type: "add", newNo: 22, text: "more" },
    ])
  })

  test("restarts the counters on every hunk", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -50,1 +50,1 @@", "-c", "+d"].join("\n")
    const hunks = parseHunks(patch)
    expect(hunks.map((hunk) => [hunk.oldStart, hunk.newStart])).toEqual([
      [1, 1],
      [50, 50],
    ])
    expect(hunks[1]!.lines[0]).toEqual({ type: "del", oldNo: 50, text: "c" })
  })

  test("keeps the heading git writes after the counts", () => {
    const [hunk] = parseHunks(["@@ -1,1 +1,1 @@ export function handler() {", "-a", "+b"].join("\n"))
    expect(hunk!.heading).toBe("export function handler() {")
    expect(hunkLabel(hunk!)).toBe("@@ -1 +1 @@ export function handler() {")
  })

  test("leaves out the no-newline marker, which is not a line of the file", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n")
    expect(parseHunks(patch).flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual(["a", "b"])
  })

  test("answers nothing for a patch with no hunks at all", () => {
    expect(parseHunks(undefined)).toEqual([])
    expect(parseHunks("")).toEqual([])
    expect(parseHunks("Binary files a/logo.png and b/logo.png differ")).toEqual([])
  })

  test("counts the lines a patch would draw", () => {
    expect(hunkLineCount(parseHunks(["@@ -1,2 +1,2 @@", " a", "-b", "+c"].join("\n")))).toBe(3)
  })
})
