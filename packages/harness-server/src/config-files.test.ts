import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigFileError, exportConfigFiles, listConfigFiles, readConfigFile } from "./config-files"

let root = ""
let config = ""
let home = ""
let xdg = ""
let project = ""
let repo = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-config-files-"))
  config = join(root, "config")
  home = join(root, "home")
  xdg = join(root, "xdg")
  project = join(root, "project")
  repo = join(root, "repo")
  for (const dir of [config, home, xdg, project, repo]) mkdirSync(dir, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_CONFIG_HOME = xdg
  process.env.OPENCODE_TEST_HOME = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("listing config files", () => {
  test("tools, guards and the global config across every layer", () => {
    write(join(config, "tool", "global.js"), "export const a = 1\n")
    write(join(home, ".opencode", "tools", "home.ts"), "export const b = 2\n")
    write(join(project, ".opencode", "tool", "local.js"), "export const c = 3\n")
    write(join(config, "guards", "safety.js"), "export const guards = []\n")
    write(join(config, "config.json"), "{}\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { delivery: { one: { guards: ["guards/safety.js", "guards/gone.js"] } } } }))
    write(join(config, "opencode.jsonc"), "{\n  // a comment\n  \"theme\": \"dark\",\n}\n")

    const files = listConfigFiles({ directory: project, project })
    const at = (suffix: string) => files.find((file) => file.path.endsWith(suffix))

    expect(at("tool/global.js")).toMatchObject({ kind: "tool", scope: "global", name: "global.js" })
    expect(at("tools/home.ts")).toMatchObject({ kind: "tool", scope: "global", name: "home.ts" })
    expect(at("tool/local.js")).toMatchObject({ kind: "tool", scope: "project", name: "local.js" })
    expect(at("guards/safety.js")).toMatchObject({ kind: "guard", scope: "global", name: "guards/safety.js" })
    expect(at("config.json")).toMatchObject({ kind: "config", scope: "global", name: "config.json" })
    expect(at("opencode.json")).toMatchObject({ kind: "config", scope: "global" })
    expect(at("opencode.jsonc")).toMatchObject({ kind: "config", scope: "global" })
  })

  test("a guard the config names but which is not there is listed, not dropped", () => {
    write(join(config, "guards", "safety.js"), "export const guards = []\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { delivery: { one: { guards: ["guards/safety.js", "guards/gone.js"] } } } }))

    const missing = listConfigFiles().find((file) => file.name === "guards/gone.js")
    expect(missing).toMatchObject({ kind: "guard", scope: "global", missing: true, bytes: 0 })
    expect(missing!.path).toBe(join(config, "guards", "gone.js"))
  })

  test("a symlinked tool is described with its target", () => {
    write(join(root, "elsewhere.js"), "export const x = 1\n")
    mkdirSync(join(config, "tool"), { recursive: true })
    symlinkSync(join(root, "elsewhere.js"), join(config, "tool", "linked.js"))

    const entry = listConfigFiles().find((file) => file.name === "linked.js")
    expect(entry).toMatchObject({ kind: "tool", symlink: { target: join(root, "elsewhere.js") } })
  })

  test("nothing anywhere is an empty list", () => {
    expect(listConfigFiles({ directory: project, project })).toEqual([])
  })
})

describe("reading one", () => {
  test("reads one it listed, and refuses one it did not", () => {
    write(join(config, "tool", "known.js"), "export const x = 1\n")
    expect(readConfigFile(join(config, "tool", "known.js")).text).toBe("export const x = 1\n")
    write(join(root, "secret.txt"), "not yours")
    expect(() => readConfigFile(join(root, "secret.txt"))).toThrow(ConfigFileError)
  })
})

describe("exporting", () => {
  const tool = () => {
    write(join(config, "tool", "hello.js"), "export const hello = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))
    return listConfigFiles().find((file) => file.name === "hello.js")!
  }

  test("a dry run writes nothing and says what it would do", async () => {
    const file = tool()
    const result = await exportConfigFiles({ paths: [file.path] })
    expect(result.dryRun).toBe(true)
    expect(result.written).toEqual([file.path])
    expect(existsSync(join(repo, "tool", "hello.js"))).toBe(false)
  })

  test("confirm copies the file to the config-relative path", async () => {
    const file = tool()
    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.written).toEqual([file.path])
    expect(readFileSync(join(repo, "tool", "hello.js"), "utf8")).toBe("export const hello = 1\n")
  })

  test("a global config carrying action profiles is exported to the repository", async () => {
    write(join(config, "tool", "hello.js"), "export const hello = 1\n")
    write(
      join(config, "opencode.json"),
      JSON.stringify({
        flupcode: {
          configRepo: repo,
          actions: { publish: { tool: "do_publish", kind: "browser", origin: "https://example.com", steps: [{ goto: "{{origin}}/" }] } },
        },
      }),
    )

    const file = listConfigFiles().find((entry) => entry.name === "opencode.json")!
    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.written).toEqual([file.path])
    const exported = JSON.parse(readFileSync(join(repo, "opencode.json"), "utf8"))
    expect(exported.flupcode.actions.publish).toMatchObject({ tool: "do_publish", kind: "browser" })
  })

  test("exporting the same file again is unchanged", async () => {
    const file = tool()
    await exportConfigFiles({ paths: [file.path], confirm: true })
    const again = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(again.unchanged).toEqual([file.path])
    expect(again.written).toEqual([])
  })

  test("a link that already points into the repository is unchanged", async () => {
    write(join(repo, "tool", "existing.js"), "export const e = 1\n")
    mkdirSync(join(config, "tool"), { recursive: true })
    symlinkSync(join(repo, "tool", "existing.js"), join(config, "tool", "linked.js"))
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const linked = listConfigFiles().find((file) => file.name === "linked.js")!
    const result = await exportConfigFiles({ paths: [linked.path] })
    expect(result.unchanged).toEqual([linked.path])
    expect(result.written).toEqual([])
  })

  test("a link pointing outside the repository is refused", async () => {
    write(join(root, "outside.js"), "export const o = 1\n")
    mkdirSync(join(config, "tool"), { recursive: true })
    symlinkSync(join(root, "outside.js"), join(config, "tool", "linked.js"))
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const linked = listConfigFiles().find((file) => file.name === "linked.js")!
    const result = await exportConfigFiles({ paths: [linked.path], confirm: true })
    expect(result.outside).toEqual([linked.path])
    expect(existsSync(join(repo, "tool", "linked.js"))).toBe(false)
  })

  test("a dangling link at the target is never replaced", async () => {
    const file = tool()
    mkdirSync(join(repo, "tool"), { recursive: true })
    symlinkSync(join(repo, "tool", "missing.js"), join(repo, "tool", "hello.js"))

    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.conflicts).toEqual([file.path])
    expect(result.written).toEqual([])
    expect(lstatSync(join(repo, "tool", "hello.js")).isSymbolicLink()).toBe(true)
  })

  test("a dangling link that leaves the repository is outside", async () => {
    const file = tool()
    mkdirSync(join(repo, "tool"), { recursive: true })
    symlinkSync(join(root, "gone.js"), join(repo, "tool", "hello.js"))

    const result = await exportConfigFiles({ paths: [file.path] })
    expect(result.outside).toEqual([file.path])
    expect(lstatSync(join(repo, "tool", "hello.js")).isSymbolicLink()).toBe(true)
  })

  test("a target that is not a regular file is a conflict", async () => {
    const file = tool()
    mkdirSync(join(repo, "tool", "hello.js"), { recursive: true })

    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.conflicts).toEqual([file.path])
  })

  test("the repository is read from the XDG config when OPENCODE_CONFIG_DIR is unset", async () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const xdgDir = join(xdg, "opencode")
    write(join(xdgDir, "tool", "hello.js"), "export const hello = 1\n")
    write(join(xdgDir, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const file = listConfigFiles().find((entry) => entry.name === "hello.js")!
    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.repo).toBe(repo)
    expect(readFileSync(join(repo, "tool", "hello.js"), "utf8")).toBe("export const hello = 1\n")
  })

  test("the repository is read from the XDG config even when OPENCODE_CONFIG_DIR is set", async () => {
    const xdgDir = join(xdg, "opencode")
    write(join(config, "tool", "hello.js"), "export const hello = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: {} }))
    write(join(xdgDir, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const file = listConfigFiles().find((entry) => entry.name === "hello.js")!
    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.repo).toBe(repo)
  })

  test("OPENCODE_CONFIG_DIR wins when both set a repository", async () => {
    const xdgDir = join(xdg, "opencode")
    const other = join(root, "other-repo")
    mkdirSync(other, { recursive: true })
    write(join(config, "tool", "hello.js"), "export const hello = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))
    write(join(xdgDir, "opencode.json"), JSON.stringify({ flupcode: { configRepo: other } }))

    const file = listConfigFiles().find((entry) => entry.name === "hello.js")!
    const result = await exportConfigFiles({ paths: [file.path] })
    expect(result.repo).toBe(repo)
  })

  test("a project-scope file is skipped", async () => {
    write(join(project, ".opencode", "tool", "local.js"), "export const l = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const local = listConfigFiles({ directory: project, project }).find((file) => file.name === "local.js")!
    const result = await exportConfigFiles({ directory: project, project, paths: [local.path] })
    expect(result.skipped).toEqual([local.path])
  })

  test("a home file that would map outside the repository is refused", async () => {
    write(join(home, ".opencode", "tool", "home.js"), "export const h = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))

    const homeTool = listConfigFiles().find((file) => file.name === "home.js")!
    const result = await exportConfigFiles({ paths: [homeTool.path], confirm: true })
    expect(result.outside).toEqual([homeTool.path])
    expect(existsSync(join(repo, "tool", "home.js"))).toBe(false)
  })

  test("a path this server never listed is skipped, never read", async () => {
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { configRepo: repo } }))
    const result = await exportConfigFiles({ paths: ["/etc/passwd", join(root, "secret.txt")] })
    expect(result.skipped).toEqual(["/etc/passwd", join(root, "secret.txt")])
    expect(result.entries.map((entry) => entry.classification)).toEqual(["skipped", "skipped"])
  })

  test("a target with different bytes is a conflict and is not clobbered", async () => {
    const file = tool()
    write(join(repo, "tool", "hello.js"), "somebody else's work\n")
    const result = await exportConfigFiles({ paths: [file.path], confirm: true })
    expect(result.conflicts).toEqual([file.path])
    expect(readFileSync(join(repo, "tool", "hello.js"), "utf8")).toBe("somebody else's work\n")
  })

  test("the repository comes from the config, never the request", async () => {
    const file = tool()
    const result = await exportConfigFiles({ paths: [file.path] })
    expect(result.repo).toBe(repo)
  })

  test("with no config repository set it refuses", async () => {
    write(join(config, "tool", "hello.js"), "export const hello = 1\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: {} }))
    const file = listConfigFiles().find((entry) => entry.name === "hello.js")!
    await expect(exportConfigFiles({ paths: [file.path] })).rejects.toThrow(ConfigFileError)
  })
})
