import { describe, expect, test } from "bun:test"
import { entryName, isAbsolutePath, joinPath, parentPath, pathOfSegments, segmentsOf, visibleFolders } from "./folder"

describe("folder paths", () => {
  test("joinPath handles roots and relative paths", () => {
    expect(joinPath("/Users/u", "")).toBe("/Users/u")
    expect(joinPath("/Users/u/", "workspace/app/")).toBe("/Users/u/workspace/app")
    expect(joinPath("/", "opt")).toBe("/opt")
    expect(joinPath("C:\\Users\\u", "code/app")).toBe("C:\\Users\\u\\code\\app")
  })

  test("parentPath stops at the filesystem root", () => {
    expect(parentPath("/Users/u/workspace")).toBe("/Users/u")
    expect(parentPath("/Users")).toBe("/")
    expect(parentPath("/")).toBeUndefined()
    expect(parentPath("C:\\Users\\u")).toBe("C:\\Users")
    expect(parentPath("C:\\Users")).toBe("C:\\")
    expect(parentPath("C:\\")).toBeUndefined()
  })

  test("segments round-trip through pathOfSegments", () => {
    const segments = segmentsOf("/Users/u/workspace/")
    expect(segments).toEqual(["/", "Users", "u", "workspace"])
    expect(pathOfSegments(segments, 1)).toBe("/")
    expect(pathOfSegments(segments, 3)).toBe("/Users/u")
    expect(pathOfSegments(segments, 4)).toBe("/Users/u/workspace")
    expect(segmentsOf("C:\\Users\\u")).toEqual(["C:\\", "Users", "u"])
    expect(pathOfSegments(["C:\\", "Users", "u"], 2)).toBe("C:\\Users")
  })

  test("isAbsolutePath and entryName", () => {
    expect(isAbsolutePath("/tmp")).toBe(true)
    expect(isAbsolutePath("C:\\code")).toBe(true)
    expect(isAbsolutePath("relative/path")).toBe(false)
    expect(isAbsolutePath("  ")).toBe(false)
    expect(entryName("docs/guides/")).toBe("guides")
    expect(entryName("README.md")).toBe("README.md")
  })

  test("visibleFolders filters files, hidden folders and by name", () => {
    const entries = [
      { path: "workspace/", type: "directory" as const },
      { path: ".config/", type: "directory" as const },
      { path: "notes.txt", type: "file" as const },
      { path: "Documents/", type: "directory" as const },
    ]
    expect(visibleFolders(entries, { hidden: false, filter: "" }).map((entry) => entry.name)).toEqual([
      "Documents",
      "workspace",
    ])
    expect(visibleFolders(entries, { hidden: true, filter: "" }).map((entry) => entry.name)).toEqual([
      ".config",
      "Documents",
      "workspace",
    ])
    expect(visibleFolders(entries, { hidden: false, filter: "work" }).map((entry) => entry.name)).toEqual(["workspace"])
  })
})
