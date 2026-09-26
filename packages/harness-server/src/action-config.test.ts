import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ActionConfigError, listActionProfiles, removeActionProfile, writeActionProfile } from "./action-config"
import { loadActionProfiles } from "./config-files"

let root = ""
let config = ""
let xdg = ""
let project = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

/** A profile that passes `validateActionProfile`, so a write test is about writing and not schema. */
const profile = (overrides: Record<string, unknown> = {}) => ({
  tool: "do_publish",
  kind: "browser",
  origin: "https://example.com",
  inputs: { text: "string" },
  steps: [{ goto: "{{origin}}/compose" }, { fill: { selector: "#body", text: "{{text}}" } }],
  ...overrides,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-action-config-"))
  config = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  for (const dir of [config, xdg, project]) mkdirSync(dir, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_CONFIG_HOME = xdg
  process.env.OPENCODE_TEST_HOME = join(root, "home")
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("writing a global action", () => {
  test("edits only flupcode.actions[id] and keeps the rest of the file", async () => {
    const path = join(config, "opencode.json")
    write(path, JSON.stringify({ theme: "dark", flupcode: { actions: { old: profile({ tool: "do_old" }) } } }, null, 2))

    const written = await writeActionProfile({ scope: "global", profile: profile(), id: "publish" })

    expect(written).toMatchObject({ path, scope: "global", id: "publish" })
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.theme).toBe("dark")
    expect(Object.keys(parsed.flupcode.actions).sort()).toEqual(["old", "publish"])
    // The map key is the id; the profile itself must not carry a second copy of it.
    expect(parsed.flupcode.actions.publish.id).toBeUndefined()
    expect(parsed.flupcode.actions.publish.tool).toBe("do_publish")
  })

  // `chmod 0` does not stop root, so the unreadable case cannot be reproduced there.
  test.skipIf(process.getuid?.() === 0)("an unreadable config is refused instead of overwritten", async () => {
    const path = join(config, "opencode.json")
    write(path, JSON.stringify({ flupcode: { actions: { keep: profile({ tool: "do_keep" }) } } }))
    chmodSync(path, 0o000)
    try {
      await expect(writeActionProfile({ scope: "global", profile: profile(), id: "publish" })).rejects.toMatchObject({
        code: "config_unreadable",
      })
    } finally {
      chmodSync(path, 0o644)
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.flupcode.actions).toHaveProperty("keep")
    expect(parsed.flupcode.actions).not.toHaveProperty("publish")
  })

  test("prefers opencode.jsonc, then opencode.json, then creates opencode.jsonc", async () => {
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { actions: {} } }))
    expect((await writeActionProfile({ scope: "global", profile: profile(), id: "publish" })).path).toBe(
      join(config, "opencode.json"),
    )

    write(join(config, "opencode.jsonc"), "{ // a comment\n  \"theme\": \"dark\"\n}\n")
    const other = await writeActionProfile({ scope: "global", profile: profile({ tool: "do_other" }), id: "other" })
    expect(other.path).toBe(join(config, "opencode.jsonc"))
    expect(readFileSync(join(config, "opencode.jsonc"), "utf8")).toContain("// a comment")

    rmSync(join(config, "opencode.json"))
    rmSync(join(config, "opencode.jsonc"))
    expect((await writeActionProfile({ scope: "global", profile: profile(), id: "fresh" })).path).toBe(
      join(config, "opencode.jsonc"),
    )
  })

  test("writes into the file that already holds the id rather than a preferred one", async () => {
    write(join(config, "opencode.jsonc"), "{}\n")
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { actions: { publish: profile() } } }))

    const written = await writeActionProfile({ scope: "global", profile: profile({ description: "updated" }), id: "publish" })
    expect(written.path).toBe(join(config, "opencode.json"))
  })
})

describe("writing a project action", () => {
  test("creates the project's .opencode and overrides a global id by id", async () => {
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { actions: { publish: profile({ description: "global" }) } } }))

    const written = await writeActionProfile({
      scope: "project",
      project,
      directory: project,
      profile: profile({ description: "project" }),
      id: "publish",
    })
    expect(written.path).toBe(join(project, ".opencode", "opencode.jsonc"))

    const source = loadActionProfiles({ directory: project, project })
    expect(source.scopes.publish).toBe("project")
    expect(source.guardDirs.publish).toBe(join(project, ".opencode"))
    expect(source.profiles.publish).toMatchObject({ description: "project" })
  })

  test("a project profile appears beside a global one in the list", async () => {
    write(join(config, "opencode.json"), JSON.stringify({ flupcode: { actions: { global_one: profile() } } }))
    await writeActionProfile({ scope: "project", project, profile: profile({ tool: "do_local" }), id: "local_one" })

    const listed = listActionProfiles({ directory: project, project })
    expect(listed.find((entry) => entry.id === "global_one")).toMatchObject({ scope: "global" })
    expect(listed.find((entry) => entry.id === "local_one")).toMatchObject({ scope: "project" })
  })

  test("a profile inherited from a parent .opencode lists the file that declared it", async () => {
    const nested = join(project, "packages", "app")
    mkdirSync(nested, { recursive: true })
    const declaring = join(project, "packages", ".opencode", "opencode.json")
    write(declaring, JSON.stringify({ flupcode: { actions: { shared: profile({ tool: "do_shared" }) } } }))

    const listed = listActionProfiles({ directory: nested, project })
    expect(listed.find((entry) => entry.id === "shared")).toMatchObject({ scope: "project", path: declaring })
  })

  test("a folder is required for a project write", async () => {
    await expect(writeActionProfile({ scope: "project", profile: profile(), id: "publish" })).rejects.toBeInstanceOf(
      ActionConfigError,
    )
  })
})

describe("validation and removal", () => {
  test("a broken profile is refused with 422 and nothing is written", async () => {
    const rejection = writeActionProfile({ scope: "global", profile: { tool: "do_x", kind: "api" }, id: "publish" })
    await expect(rejection).rejects.toMatchObject({ status: 422 })
    expect(listActionProfiles()).toEqual([])
  })

  test("removing takes only that id and leaves the others", async () => {
    await writeActionProfile({ scope: "global", profile: profile(), id: "publish" })
    await writeActionProfile({ scope: "global", profile: profile({ tool: "do_other" }), id: "other" })

    const removed = await removeActionProfile({ id: "publish", scope: "global" })
    expect(removed).toMatchObject({ removed: true })
    expect(listActionProfiles().map((entry) => entry.id)).toEqual(["other"])
  })

  test("removing something that is not there answers nothing", async () => {
    expect(await removeActionProfile({ id: "nope", scope: "global" })).toBeUndefined()
  })
})
