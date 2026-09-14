import { describe, expect, test } from "bun:test"
import {
  entryName,
  isAbsolutePath,
  joinPath,
  parentPath,
  pathOfSegments,
  segmentsOf,
  visibleFolders,
} from "./folder"

describe("folder paths", () => {
  test("joinPath handles roots and relative paths", () => {
    expect(joinPath("/Users/raul", "")).toBe("/Users/raul")
    expect(joinPath("/Users/raul/", "workspace/app/")).toBe("/Users/raul/workspace/app")
    expect(joinPath("/", "opt")).toBe("/opt")
    expect(joinPath("C:\\Users\\raul", "code/app")).toBe("C:\\Users\\raul\\code\\app")
  })

  test("parentPath stops at the filesystem root", () => {
    expect(parentPath("/Users/raul/workspace")).toBe("/Users/raul")
    expect(parentPath("/Users")).toBe("/")
    expect(parentPath("/")).toBeUndefined()
    expect(parentPath("C:\\Users\\raul")).toBe("C:\\Users")
    expect(parentPath("C:\\Users")).toBe("C:\\")
    expect(parentPath("C:\\")).toBeUndefined()
  })

  test("segments round-trip through pathOfSegments", () => {
    const segments = segmentsOf("/Users/raul/workspace/")
    expect(segments).toEqual(["/", "Users", "raul", "workspace"])
    expect(pathOfSegments(segments, 1)).toBe("/")
    expect(pathOfSegments(segments, 3)).toBe("/Users/raul")
    expect(pathOfSegments(segments, 4)).toBe("/Users/raul/workspace")
    expect(segmentsOf("C:\\Users\\raul")).toEqual(["C:\\", "Users", "raul"])
    expect(pathOfSegments(["C:\\", "Users", "raul"], 2)).toBe("C:\\Users")
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
