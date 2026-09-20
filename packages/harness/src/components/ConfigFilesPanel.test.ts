import { describe, expect, test } from "bun:test"
import { changedPaths, exportCounts, groupByKind, restartKinds, sizeLabel } from "./ConfigFilesPanel"
import type { ConfigFileEntry, ConfigFileExport } from "../types"

const entry = (overrides: Partial<ConfigFileEntry>): ConfigFileEntry => ({
  name: "x.js",
  path: "/c/x.js",
  scope: "global",
  kind: "tool",
  bytes: 10,
  mtimeMs: 1,
  ...overrides,
})

describe("grouping config files", () => {
  test("keeps the tool, guard, config order and drops the empty groups", () => {
    const config = entry({ name: "config.json", path: "/c/config.json", kind: "config" })
    const guard = entry({ name: "guards/safety.js", path: "/c/guards/safety.js", kind: "guard", scope: "global" })
    const tool = entry({ name: "hello.js", path: "/c/tool/hello.js", kind: "tool" })

    const groups = groupByKind([config, guard, tool])
    expect(groups.map((group) => group.kind)).toEqual(["tool", "guard", "config"])
    expect(groups[0]!.entries).toEqual([tool])
    expect(groups[1]!.entries).toEqual([guard])
    expect(groups[2]!.entries).toEqual([config])
    expect(groupByKind([tool])).toHaveLength(1)
    expect(groupByKind([])).toEqual([])
  })
})

describe("sizing a config file", () => {
  test("uses the unit a reader scans", () => {
    expect(sizeLabel(0)).toBe("0 B")
    expect(sizeLabel(1013)).toBe("1013 B")
    expect(sizeLabel(2048)).toBe("2 kB")
    expect(sizeLabel(1536)).toBe("1.5 kB")
    expect(sizeLabel(2 * 1024 * 1024)).toBe("2 MB")
  })
})

describe("detecting a change on disk", () => {
  test("names the files whose mtime moved, and the ones that appeared", () => {
    const before = [entry({ path: "/c/a.js", mtimeMs: 1 }), entry({ path: "/c/b.js", mtimeMs: 2 })]
    const after = [
      entry({ path: "/c/a.js", mtimeMs: 9 }),
      entry({ path: "/c/b.js", mtimeMs: 2 }),
      entry({ path: "/c/c.js", mtimeMs: 5 }),
    ]
    expect(changedPaths(before, after)).toEqual(["/c/a.js", "/c/c.js"])
  })

  test("a missing guard that stays missing is not a change", () => {
    const before = [entry({ path: "/c/gone.js", kind: "guard", missing: true, mtimeMs: 0 })]
    const after = [entry({ path: "/c/gone.js", kind: "guard", missing: true, mtimeMs: 0 })]
    expect(changedPaths(before, after)).toEqual([])
  })

  test("an unchanged reading is no change at all", () => {
    const files = [entry({ path: "/c/a.js", mtimeMs: 3 })]
    expect(changedPaths(files, files)).toEqual([])
  })
})

describe("deciding what needs a restart", () => {
  test("editing an existing tool needs a restart", () => {
    const before = [entry({ path: "/c/tool/a.js", kind: "tool", mtimeMs: 1 })]
    const after = [entry({ path: "/c/tool/a.js", kind: "tool", mtimeMs: 9 })]
    expect(restartKinds(["/c/tool/a.js"], after, before)).toEqual({ guard: false, tool: true })
  })

  test("a newly added tool takes effect after a reload, not a restart", () => {
    const before: ConfigFileEntry[] = []
    const after = [entry({ path: "/c/tool/new.js", kind: "tool", mtimeMs: 9 })]
    expect(restartKinds(["/c/tool/new.js"], after, before)).toEqual({ guard: false, tool: false })
  })

  test("a changed guard needs a restart", () => {
    const before = [entry({ path: "/c/guards/a.js", kind: "guard", mtimeMs: 1 })]
    const after = [entry({ path: "/c/guards/a.js", kind: "guard", mtimeMs: 9 })]
    expect(restartKinds(["/c/guards/a.js"], after, before)).toEqual({ guard: true, tool: false })
  })
})

describe("counting an export", () => {
  test("reports every classification, in the order the plan reads", () => {
    const result: ConfigFileExport = {
      repo: "/repo",
      dryRun: true,
      written: ["/c/a.js"],
      unchanged: [],
      conflicts: ["/c/b.js"],
      skipped: ["/c/c.js", "/c/d.js"],
      outside: [],
      entries: [],
    }
    expect(exportCounts(result)).toEqual([
      { classification: "written", count: 1 },
      { classification: "unchanged", count: 0 },
      { classification: "conflicts", count: 1 },
      { classification: "skipped", count: 2 },
      { classification: "outside", count: 0 },
    ])
  })
})
