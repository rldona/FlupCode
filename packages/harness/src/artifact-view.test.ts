import { describe, expect, test } from "bun:test"
import { viewerFor, viewerNeedsRaw } from "./artifact-view"

describe("the viewer an artifact gets (H-14)", () => {
  test("is chosen from the mime the server kept", () => {
    expect(viewerFor({ mime: "text/markdown" })).toBe("markdown")
    expect(viewerFor({ mime: "text/html" })).toBe("html")
    expect(viewerFor({ mime: "image/png" })).toBe("image")
    expect(viewerFor({ mime: "image/svg+xml" })).toBe("image")
    expect(viewerFor({ mime: "application/pdf" })).toBe("pdf")
    // Anything else is the text it is: a report, a log, a diff.
    expect(viewerFor({ mime: "text/plain" })).toBe("text")
    expect(viewerFor({ mime: "application/json" })).toBe("text")
  })

  test("only a drawing viewer needs the bytes themselves", () => {
    expect(viewerNeedsRaw("image")).toBe(true)
    expect(viewerNeedsRaw("pdf")).toBe(true)
    expect(viewerNeedsRaw("markdown")).toBe(false)
    expect(viewerNeedsRaw("html")).toBe(false)
    expect(viewerNeedsRaw("text")).toBe(false)
  })
})
