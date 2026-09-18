import { describe, expect, test } from "bun:test"
import { addSource, hasSources, normalizeSources, removeSource } from "./skill-sources"

describe("reading the config's skill sources", () => {
  test("two lists of strings, whatever else is there", () => {
    expect(normalizeSources({ paths: ["/a"], urls: ["https://x"], other: 3 })).toEqual({
      paths: ["/a"],
      urls: ["https://x"],
    })
  })

  test("nothing, or something that is not a source, reads as empty", () => {
    expect(normalizeSources(undefined)).toEqual({ paths: [], urls: [] })
    expect(normalizeSources("nope")).toEqual({ paths: [], urls: [] })
    expect(normalizeSources({ paths: [1, "/a", null] })).toEqual({ paths: ["/a"], urls: [] })
  })
})

describe("adding and removing", () => {
  test("adds one, trimmed, on the right list", () => {
    const withPath = addSource({ paths: [], urls: [] }, "path", "  /skills  ")
    expect(withPath).toEqual({ paths: ["/skills"], urls: [] })
    expect(addSource(withPath, "url", "https://x/y")).toEqual({ paths: ["/skills"], urls: ["https://x/y"] })
  })

  test("does not add the same one twice, and ignores an empty one", () => {
    const once = addSource({ paths: ["/a"], urls: [] }, "path", "/a")
    expect(once.paths).toEqual(["/a"])
    expect(addSource(once, "path", "   ")).toEqual(once)
  })

  test("removes only the named one", () => {
    const sources = { paths: ["/a", "/b"], urls: ["https://x"] }
    expect(removeSource(sources, "path", "/a")).toEqual({ paths: ["/b"], urls: ["https://x"] })
    expect(removeSource(sources, "url", "https://x")).toEqual({ paths: ["/a", "/b"], urls: [] })
  })

  test("hasSources says whether there is anything to show", () => {
    expect(hasSources({ paths: [], urls: [] })).toBe(false)
    expect(hasSources({ paths: ["/a"], urls: [] })).toBe(true)
  })
})
