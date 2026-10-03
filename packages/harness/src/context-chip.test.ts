import { describe, expect, test } from "bun:test"
import { resolveChips, withChips, type ContextChip } from "./context-chip"

const annotation: ContextChip = {
  id: "c1",
  type: "preview",
  label: "localhost:5173/settings",
  source: "http://localhost:5173/settings",
  artifactID: "a1",
  image: "data:image/png;base64,AAAA",
  note: "The button overlaps\nthe title",
}

describe("a context chip (BU-06)", () => {
  test("a preview annotation resolves into a quoted block and its picture", () => {
    const resolved = resolveChips([annotation])
    expect(resolved.files).toEqual([{ uri: "data:image/png;base64,AAAA", name: "preview-a1.png" }])
    expect(resolved.text).toBe(
      [
        "[Preview annotation of http://localhost:5173/settings, artifact a1]",
        "> The button overlaps",
        "> the title",
        "The attached image is the page as FlupCode's preview showed it, with the marked areas numbered.",
      ].join("\n"),
    )
  })

  test("the blocks follow what the reader typed, or stand alone", () => {
    expect(withChips("Fix this", [annotation])).toStartWith("Fix this\n\n[Preview annotation of")
    expect(withChips("", [annotation])).toStartWith("[Preview annotation of")
    expect(withChips("Only text", [])).toBe("Only text")
  })

  test("a chip without a kept picture says nothing about an artifact", () => {
    const resolved = resolveChips([{ id: "c2", type: "preview", label: "x", source: "http://localhost:3000/" }])
    expect(resolved.files).toEqual([])
    expect(resolved.text).toStartWith("[Preview annotation of http://localhost:3000/]")
  })
})
