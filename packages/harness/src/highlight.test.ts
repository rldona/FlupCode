import { describe, expect, test } from "bun:test"
import { parsePatch } from "./highlight"

describe("parsePatch", () => {
  test("numbers additions against the new file and deletions against the old one", () => {
    const patch = ["@@ -10,2 +10,3 @@", " keep", "-old", "+new", "+extra"].join("\n")
    expect(parsePatch(patch)).toEqual([
      { type: "meta", text: "@@ -10,2 +10,3 @@" },
      { type: "same", no: 10, text: "keep" },
      { type: "del", no: 11, text: "old" },
      { type: "add", no: 11, text: "new" },
      { type: "add", no: 12, text: "extra" },
    ])
  })

  test("keeps file headers and no-newline markers as meta rows", () => {
    const patch = ["--- a/file.ts", "+++ b/file.ts", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join(
      "\n",
    )
    expect(parsePatch(patch).map((row) => row.type)).toEqual(["meta", "meta", "meta", "del", "add", "meta"])
  })

  test("handles empty and hunk-less patches", () => {
    expect(parsePatch("")).toEqual([])
    expect(parsePatch("just text")).toEqual([{ type: "meta", text: "just text" }])
  })
})
