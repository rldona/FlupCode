import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capturedPrompts, configDirectory, instructionsFor, isInside, readInstruction, walkUp } from "./context"

let root = ""
let config = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-ctx-"))
  config = join(root, "config")
  mkdirSync(config, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG", "XDG_CONFIG_HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("instructionsFor", () => {
  test("loads the global one, then every AGENTS.md up to the project root, nearest last", () => {
    write(join(config, "AGENTS.md"), "# Global\nAlways be brief.\n")
    write(join(root, "project", "AGENTS.md"), "# Project\nUse tabs.\n")
    write(join(root, "project", "packages", "app", "AGENTS.md"), "# App\nNo, spaces.\n")

    const report = instructionsFor(join(root, "project", "packages", "app"), join(root, "project"))

    // Order is the engine's: the nearest file is read last and has the last word.
    expect(report.instructions.map((file) => file.scope)).toEqual(["global", "project", "project"])
    expect(report.instructions.map((file) => file.path)).toEqual([
      join(config, "AGENTS.md"),
      join(root, "project", "AGENTS.md"),
      join(root, "project", "packages", "app", "AGENTS.md"),
    ])
    expect(report.instructions[0]!.excerpt).toBe("Global")
  })

  test("a folder with no AGENTS.md between it and the root loads only what is there", () => {
    write(join(root, "project", "AGENTS.md"), "# Project\n")
    const report = instructionsFor(join(root, "project", "deep", "deeper"), join(root, "project"))
    expect(report.instructions.map((file) => file.path)).toEqual([join(root, "project", "AGENTS.md")])
  })

  test("only AGENTS.md — not the other files a reader might assume", () => {
    // `CLAUDE.md` and `.cursorrules` are what `/init` reads *about*; the engine never loads them.
    // Listing them would have this screen claim the model was told things it was not.
    write(join(root, "project", "CLAUDE.md"), "# Claude\n")
    write(join(root, "project", ".cursorrules"), "rules\n")
    expect(instructionsFor(join(root, "project"), join(root, "project")).instructions).toEqual([])
  })

  test("a folder outside the project loads nothing from it, and says why", () => {
    write(join(root, "project", "AGENTS.md"), "# Project\n")
    write(join(root, "elsewhere", "AGENTS.md"), "# Elsewhere\n")

    const report = instructionsFor(join(root, "elsewhere"), join(root, "project"))

    expect(report.instructions).toEqual([])
    expect(report.problem).toMatch(/outside the project/)
  })

  test("the engine's off switch is honoured, and said out loud", () => {
    write(join(config, "AGENTS.md"), "# Global\n")
    write(join(root, "project", "AGENTS.md"), "# Project\n")
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

    const report = instructionsFor(join(root, "project"), join(root, "project"))

    expect(report.instructions.map((file) => file.scope)).toEqual(["global"])
    expect(report.problem).toMatch(/OPENCODE_DISABLE_PROJECT_CONFIG/)
  })

  test("the same file is not listed twice when the project root is the folder itself", () => {
    write(join(root, "project", "AGENTS.md"), "# Project\n")
    const report = instructionsFor(join(root, "project"), join(root, "project"))
    expect(report.instructions).toHaveLength(1)
  })

  test("nothing anywhere is an empty list, not an error", () => {
    expect(instructionsFor(join(root, "project"), join(root, "project"))).toMatchObject({ instructions: [] })
  })

  test("reports the size, which is the part that costs tokens", () => {
    write(join(root, "project", "AGENTS.md"), "x".repeat(1234))
    expect(instructionsFor(join(root, "project"), join(root, "project")).instructions[0]!.bytes).toBe(1234)
  })
})

describe("readInstruction", () => {
  test("reads one this report says would load", () => {
    write(join(root, "project", "AGENTS.md"), "# Project\nbody\n")
    const report = instructionsFor(join(root, "project"), join(root, "project"))
    expect(readInstruction(report, join(root, "project", "AGENTS.md"))).toContain("body")
  })

  test("refuses a path the report never named", () => {
    // The path comes from a browser. Reading whatever it asks for would be a file server.
    write(join(root, "secret.txt"), "not yours")
    const report = instructionsFor(join(root, "project"), join(root, "project"))
    expect(readInstruction(report, join(root, "secret.txt"))).toBeUndefined()
    expect(readInstruction(report, "/etc/passwd")).toBeUndefined()
  })
})

describe("the rules themselves", () => {
  test("isInside is about containment, not about string prefixes", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true)
    expect(isInside("/a/b", "/a/b")).toBe(true)
    expect(isInside("/a/bc", "/a/b")).toBe(false)
    expect(isInside("/a", "/a/b")).toBe(false)
  })

  test("walkUp stops at the root it was given, furthest first", () => {
    expect(walkUp("/a/b/c/d", "/a/b")).toEqual(["/a/b", "/a/b/c", "/a/b/c/d"])
    expect(walkUp("/a/b", "/a/b")).toEqual(["/a/b"])
  })

  test("walkUp cannot spin forever on a path that never reaches its stop", () => {
    expect(walkUp("/a/b", "/somewhere/else").length).toBeLessThan(64)
  })

  test("configDirectory follows the engine: its own variable, then XDG, then ~/.config", () => {
    process.env.OPENCODE_CONFIG_DIR = "/explicit"
    expect(configDirectory()).toBe("/explicit")
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = "/xdg"
    expect(configDirectory()).toBe("/xdg/opencode")
  })
})

describe("capturedPrompts", () => {
  const saveKey = "FLUPCODE_SYSTEM_PROMPTS_DIR"

  beforeEach(() => {
    saved[saveKey] = process.env[saveKey]
    process.env[saveKey] = join(root, "prompts")
  })

  const record = (sessionID: string, name: string, body: unknown) => {
    const folder = join(root, "prompts", sessionID)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, name), typeof body === "string" ? body : JSON.stringify(body))
  }

  test("reads a session's requests newest first, and only the newest few", () => {
    for (let turn = 0; turn < 8; turn++) {
      record("ses_abc", `${1_700_000_000_000 + turn}-a.json`, {
        at: 1_700_000_000_000 + turn,
        providerID: "deepseek",
        modelID: "flash",
        system: [`turn ${turn}`],
      })
    }
    const prompts = capturedPrompts("ses_abc")
    expect(prompts).toHaveLength(6)
    expect(prompts[0]!.system).toEqual(["turn 7"])
    expect(prompts[0]!.modelID).toBe("flash")
  })

  test("skips what it cannot read rather than failing the whole list", () => {
    record("ses_abc", "1700000000000-a.json", { at: 1_700_000_000_000, system: ["good"] })
    record("ses_abc", "1700000000001-b.json", "{ not json")
    record("ses_abc", "1700000000002-c.json", { at: "not a number", system: ["wrong shape"] })
    expect(capturedPrompts("ses_abc").map((prompt) => prompt.system)).toEqual([["good"]])
  })

  test("a session that recorded nothing, and an id that is not one, both read as nothing", () => {
    expect(capturedPrompts("ses_missing")).toEqual([])
    // The id names a folder under ours. Anything else must not walk out of it.
    expect(capturedPrompts("../../etc")).toEqual([])
    expect(capturedPrompts("ses_abc/../..")).toEqual([])
  })
})
