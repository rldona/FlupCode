import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_LEARNING_CONFIG } from "../config"
import { DRAFT_LIMITS, DEFAULT_MAX_INPUT_CHARS } from "../learning/draft"
import { skillReport } from "../../skills"
import { SNAPSHOT_KEEP, contentHashOf, createLearnedStore, learnedRoots, serialiseLearnedSkill } from "./learned-store"

let root = ""
let home = ""
let config = ""
let xdg = ""
let project = ""
let learned = ""
let archive = ""
let outside = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

const humanSkill = (name: string) => `---\nname: ${name}\ndescription: A human skill\n---\n\nDo the human thing.\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-learned-"))
  home = join(root, "home")
  config = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  // Both roots live inside the project, as the store now requires; the override only renames them.
  learned = join(project, ".opencode", "custom-learned")
  archive = join(project, ".opencode", "custom-archive")
  outside = join(root, "outside")
  for (const directory of [home, config, xdg, project, outside]) mkdirSync(directory, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
  process.env.XDG_CONFIG_HOME = xdg
  process.env.OPENCODE_TEST_HOME = home
  process.env.HOME = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/** The store tests point at temp roots; the scannable test uses the real project-scoped default. */
const overrides = () => ({ FLUPCODE_ADAPTIVE_LEARNED_ROOT: learned, FLUPCODE_ADAPTIVE_LEARNED_ARCHIVE: archive })

const store = (env: NodeJS.ProcessEnv = overrides()) => createLearnedStore({ env })

const input = (overridesInput: Partial<Parameters<ReturnType<typeof store>["write"]>[0]> = {}) => ({
  projectID: project,
  name: "fix-failing-test",
  description: "Use when a test fails",
  body: "Locate the failing assertion and fix the minimal cause.",
  ...overridesInput,
})

describe("the learned root (FH-040)", () => {
  test("sits under the project by default, with an environment override and a separate archive", () => {
    expect(learnedRoots("/work/project", {})).toEqual({
      learned: join("/work/project", ".opencode", "skills", "flupcode-learned"),
      archive: join("/work/project", ".opencode", "flupcode-learned-archive"),
    })
    expect(learnedRoots("/work/project", overrides())).toEqual({ learned, archive })
  })

  test("the default snapshot count and the learning config agree", () => {
    expect(SNAPSHOT_KEEP).toBe(DEFAULT_LEARNING_CONFIG.snapshotKeep)
    expect(DEFAULT_LEARNING_CONFIG.maxInputChars).toBe(DEFAULT_MAX_INPUT_CHARS)
    expect(DEFAULT_LEARNING_CONFIG.maxBodyChars).toBe(DRAFT_LIMITS.maxBodyChars)
  })

  test("a learned skill appears in the engine's own report, marked as the harness's", () => {
    // No root override: the learned skill must land where the engine scans.
    const defaultStore = createLearnedStore({ env: {} })
    const result = defaultStore.write(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.path).toBe(join(project, ".opencode", "skills", "flupcode-learned", "fix-failing-test", "SKILL.md"))
    const [file] = skillReport(project, project)
    expect(file).toMatchObject({ name: "fix-failing-test", loaded: true, scope: "project", learned: true })
    expect(readFileSync(result.path, "utf8")).toContain("self-authored: true")
  })
})

describe("writing a learned skill", () => {
  test("writes the marker, the sidecar and the ledger entry", () => {
    const result = store().write(input({ evidenceRefs: ["episode:run:1"] }))
    expect(result).toMatchObject({ ok: true, version: 1, state: "probation" })
    if (!result.ok) return

    const sidecar = store().readSidecar(project, "fix-failing-test")!
    expect(sidecar).toMatchObject({
      name: "fix-failing-test",
      version: 1,
      state: "probation",
      createdBy: "skillReflection",
      source: { projectID: project },
      evidenceRefs: ["episode:run:1"],
      usage: { load: 0, view: 0, patch: 0, opportunities: 0 },
    })
    expect(sidecar.contentHash).toBe(result.contentHash)

    const ledger = readFileSync(join(learned, "fix-failing-test", ".ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
    expect(ledger).toHaveLength(1)
    expect(JSON.parse(ledger[0]!)).toMatchObject({ event: "created", version: 1 })
  })

  test("refuses a name that would escape the root, and a project that is not one", () => {
    for (const name of ["../escape", "a/b", "", "..", ".hidden"]) {
      expect(store().write(input({ name }))).toEqual({ ok: false, reason: "invalid-name" })
    }
    expect(store().write(input({ projectID: "local" }))).toEqual({ ok: false, reason: "no-project" })
  })

  test("the store refuses to write with learning disabled", () => {
    const gated = createLearnedStore({ env: overrides(), enabled: () => false })
    expect(gated.write(input())).toEqual({ ok: false, reason: "disabled" })
    expect(existsSync(join(learned, "fix-failing-test"))).toBe(false)
  })

  test("the writer is fail-closed: archive and updateSidecar are disabled no-ops too", () => {
    const created = store()
    expect(created.write(input()).ok).toBe(true)
    const folder = join(learned, "fix-failing-test")
    const sidecarPath = join(folder, ".sidecar.json")
    const ledgerPath = join(folder, ".ledger.jsonl")
    const skillPath = join(folder, "SKILL.md")
    const beforeSidecar = readFileSync(sidecarPath)
    const beforeLedger = readFileSync(ledgerPath)
    const beforeSkill = readFileSync(skillPath)

    const gated = createLearnedStore({ env: overrides(), enabled: () => false })
    expect(gated.updateSidecar({ projectID: project, name: "fix-failing-test", state: "mature" })).toEqual({
      ok: false,
      reason: "disabled",
    })
    expect(gated.archive({ projectID: project, name: "fix-failing-test", reason: "test" })).toEqual({
      ok: false,
      reason: "disabled",
    })

    // Nothing moved and no file changed.
    expect(existsSync(join(folder, "SKILL.md"))).toBe(true)
    expect(readFileSync(sidecarPath).equals(beforeSidecar)).toBe(true)
    expect(readFileSync(ledgerPath).equals(beforeLedger)).toBe(true)
    expect(readFileSync(skillPath).equals(beforeSkill)).toBe(true)
  })

  test("a security archive runs even with learning off, so the human wins on disk", () => {
    const created = store()
    expect(created.write(input()).ok).toBe(true)
    const gated = createLearnedStore({ env: overrides(), enabled: () => false })
    // The reverse-collision repair is a move, not a learning write (ADR-0022 §4): the one archive
    // that bypasses the kill switch, and only when the caller marks it as a security repair.
    expect(
      gated.archive({ projectID: project, name: "fix-failing-test", reason: "human-name-collision", security: true }),
    ).toMatchObject({ ok: true })
    expect(existsSync(join(learned, "fix-failing-test", "SKILL.md"))).toBe(false)
    expect(existsSync(join(archive, "fix-failing-test", "SKILL.md"))).toBe(true)
  })

  test("refuses a path that leaves the root through a symlink", () => {
    mkdirSync(learned, { recursive: true })
    symlinkSync(outside, join(learned, "sneaky"))
    expect(store().write(input({ name: "sneaky" }))).toEqual({ ok: false, reason: "path-escape" })
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false)
  })

  test("refuses a learned root under a symlinked ancestor instead of writing outside the project", () => {
    // The reproduced escape: `.opencode` is a symlink, so a realpath check against the already-resolved
    // root accepted the write and landed it in the link's target. The component walk refuses it.
    const target = join(outside, "config")
    mkdirSync(target, { recursive: true })
    symlinkSync(target, join(project, ".opencode"))
    expect(store().write(input())).toEqual({ ok: false, reason: "path-escape" })
    expect(existsSync(join(target, "custom-learned"))).toBe(false)
  })

  test("refuses an ancestor that is a file, not a directory", () => {
    writeFileSync(join(project, ".opencode"), "not a directory")
    expect(store().write(input())).toEqual({ ok: false, reason: "not-a-directory" })
  })

  test("refuses a name a human skill already uses", () => {
    write(join(project, ".opencode", "skills", "shared", "SKILL.md"), humanSkill("shared"))
    expect(store().write(input({ name: "shared" }))).toEqual({ ok: false, reason: "name-collision" })
    // And the human file is exactly as it was.
    expect(readFileSync(join(project, ".opencode", "skills", "shared", "SKILL.md"), "utf8")).toBe(humanSkill("shared"))
  })

  test("never overwrites a file that is not self-authored", () => {
    write(join(learned, "fix-failing-test", "SKILL.md"), humanSkill("fix-failing-test"))
    expect(store().write(input())).toEqual({ ok: false, reason: "not-self-authored" })
    expect(readFileSync(join(learned, "fix-failing-test", "SKILL.md"), "utf8")).toBe(humanSkill("fix-failing-test"))
  })

  test("a patch snapshots the old body, bumps the version and keeps the ledger append-only", () => {
    const created = store().write(input({ body: "First body." }))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    for (const body of ["Second body.", "Third body.", "Fourth body."]) {
      expect(store().write(input({ body })).ok).toBe(true)
    }

    const sidecar = store().readSidecar(project, "fix-failing-test")!
    expect(sidecar.version).toBe(4)
    const versions = readdirSync(join(learned, "fix-failing-test", ".versions"))
    // One snapshot per patch, all `.txt` so no scanner lists them.
    expect(versions).toHaveLength(3)
    expect(versions.every((entry) => entry.endsWith(".txt"))).toBe(true)
    expect(readFileSync(join(learned, "fix-failing-test", ".versions", versions[0]!), "utf8")).toContain("body.")

    const ledger = readFileSync(join(learned, "fix-failing-test", ".ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
    expect(ledger).toHaveLength(4)
    expect(JSON.parse(ledger[1]!)).toMatchObject({ event: "patched", version: 2, from: created.contentHash })
  })

  test("keeps at most SNAPSHOT_KEEP snapshots", () => {
    store().write(input({ body: "v1" }))
    for (let version = 2; version <= 12; version++) store().write(input({ body: `v${version}` }))
    expect(readdirSync(join(learned, "fix-failing-test", ".versions"))).toHaveLength(SNAPSHOT_KEEP)
  })
})

describe("atomic install and the catalogue", () => {
  test("an interrupted install leaves a folder with no visible skill and no partial SKILL.md", () => {
    // What a crash before the final rename leaves behind: sidecar and temp, no `SKILL.md`.
    const folder = join(learned, "half-written")
    mkdirSync(folder, { recursive: true })
    write(join(folder, ".sidecar.json"), "{}\n")
    write(join(folder, "SKILL.md.tmp"), "---\nname: half-written\n---\n")

    expect(existsSync(join(folder, "SKILL.md"))).toBe(false)
    const files = skillReport(project, project)
    expect(files.some((file) => file.name === "half-written")).toBe(false)
    expect(files.some((file) => file.path.endsWith(".tmp"))).toBe(false)
  })

  test("the snapshots and the archive never enter the catalogue", () => {
    // The learned root is the project-scoped default, so the skill is in the catalogue to begin with.
    const defaultStore = createLearnedStore({ env: { FLUPCODE_ADAPTIVE_LEARNED_ARCHIVE: archive } })
    defaultStore.write(input({ body: "First body." }))
    defaultStore.write(input({ body: "Second body." }))
    const before = skillReport(project, project).filter((file) => file.loaded)
    expect(before.map((file) => file.name)).toEqual(["fix-failing-test"])

    expect(defaultStore.archive({ projectID: project, name: "fix-failing-test", reason: "test" })).toEqual({
      ok: true,
      path: join(archive, "fix-failing-test"),
    })

    // The archive is outside `skills/`, so nothing learned remains in the project catalogue.
    const after = skillReport(project, project).filter((file) => file.path.includes("flupcode-learned"))
    expect(after).toEqual([])
    expect(existsSync(join(project, ".opencode", "skills", "flupcode-learned", "fix-failing-test"))).toBe(false)
  })
})

describe("archive is a move", () => {
  test("moves the skill, marks the sidecar archived and logs it", () => {
    store().write(input())
    const archived = store().archive({ projectID: project, name: "fix-failing-test", reason: "stale" })
    expect(archived).toEqual({ ok: true, path: join(archive, "fix-failing-test") })

    const sidecar = store().readSidecar(project, "fix-failing-test") // still reads source root
    expect(sidecar).toBeUndefined()
    const moved: unknown = JSON.parse(readFileSync(join(archive, "fix-failing-test", ".sidecar.json"), "utf8"))
    expect(moved).toMatchObject({ state: "archived" })
    const ledger = readFileSync(join(archive, "fix-failing-test", ".ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
    expect(JSON.parse(ledger.at(-1)!)).toMatchObject({ event: "archived", reason: "stale" })
  })

  test("refuses something that is not there, or is not self-authored", () => {
    expect(store().archive({ projectID: project, name: "missing", reason: "test" })).toEqual({
      ok: false,
      reason: "not-found",
    })
    write(join(learned, "human", "SKILL.md"), humanSkill("human"))
    expect(store().archive({ projectID: project, name: "human", reason: "test" })).toEqual({
      ok: false,
      reason: "not-self-authored",
    })
  })

  test("a folder with no visible SKILL.md is not-found, not a crash", () => {
    mkdirSync(join(learned, "half-written"), { recursive: true })
    write(join(learned, "half-written", "SKILL.md.tmp"), "---\nname: half-written\n---\n")
    expect(store().archive({ projectID: project, name: "half-written", reason: "test" })).toEqual({
      ok: false,
      reason: "not-found",
    })
  })

  test("refuses an archive root behind a symlinked ancestor", () => {
    store().write(input())
    const target = join(outside, "archives")
    mkdirSync(target, { recursive: true })
    symlinkSync(target, archive)
    expect(store().archive({ projectID: project, name: "fix-failing-test", reason: "test" })).toEqual({
      ok: false,
      reason: "path-escape",
    })
    expect(existsSync(join(target, "fix-failing-test"))).toBe(false)
  })
})

describe("reading protects the same boundary as writing (FH-040)", () => {
  test("a read guard is the same NAME and containment: a traversal name never crosses the root", () => {
    write(join(project, ".opencode", "skills", "human", "SKILL.md"), humanSkill("human"))
    for (const name of ["../human", "a/b", "", ".."]) {
      expect(store().readSidecar(project, name)).toBeUndefined()
      expect(store().read(project, name)).toBeUndefined()
    }
  })

  test("a read never escapes the learned root through a symlink", () => {
    mkdirSync(learned, { recursive: true })
    symlinkSync(outside, join(learned, "sneaky"))
    write(join(outside, "SKILL.md"), `---\nname: sneaky\nself-authored: true\n---\n\nOutside.\n`)
    expect(store().read(project, "sneaky")).toBeUndefined()
  })

  test("a read under a symlinked ancestor reads nothing", () => {
    const target = join(outside, "config")
    mkdirSync(join(target, "custom-learned", "sneaky"), { recursive: true })
    write(
      join(target, "custom-learned", "sneaky", "SKILL.md"),
      `---\nname: sneaky\nself-authored: true\n---\n\nOutside.\n`,
    )
    symlinkSync(target, join(project, ".opencode"))
    expect(store().read(project, "sneaky")).toBeUndefined()
    expect(store().readSidecar(project, "sneaky")).toBeUndefined()
  })

  test("read returns a learned body and nothing for a human file or a missing name", () => {
    store().write(input({ description: "Use when reading", body: "Read the body." }))
    expect(store().read(project, "fix-failing-test")).toMatchObject({
      name: "fix-failing-test",
      description: "Use when reading",
      body: "Read the body.",
    })
    write(join(learned, "human", "SKILL.md"), humanSkill("human"))
    expect(store().read(project, "human")).toBeUndefined()
    expect(store().read(project, "missing")).toBeUndefined()
  })
})

describe("human skills are never touched", () => {
  test("stay byte-identical through a create, a patch and an archive", () => {
    const humanPath = join(project, ".opencode", "skills", "human-skill", "SKILL.md")
    write(humanPath, humanSkill("human-skill"))
    const before = readFileSync(humanPath)
    const beforeStat = lstatSync(humanPath)

    store().write(input())
    store().write(input({ body: "A new body." }))
    store().archive({ projectID: project, name: "fix-failing-test", reason: "test" })

    expect(readFileSync(humanPath).equals(before)).toBe(true)
    expect(lstatSync(humanPath).mtimeMs).toBe(beforeStat.mtimeMs)
    // The human skill still loads, unchanged.
    expect(skillReport(project, project).find((file) => file.name === "human-skill")).toMatchObject({ loaded: true })
  })
})

describe("the sidecar is read defensively (FH-040)", () => {
  const sidecarPath = () => join(learned, "fix-failing-test", ".sidecar.json")

  test("a corrupt sidecar reads as missing, and a sidecar-only update rebuilds it rather than failing", () => {
    expect(store().write(input()).ok).toBe(true)
    writeFileSync(sidecarPath(), "{ not json")
    expect(store().readSidecar(project, "fix-failing-test")).toBeUndefined()

    // The curator's defensive read reconstructs PROBATION v1 from the file, not a crash.
    const updated = store().updateSidecar({ projectID: project, name: "fix-failing-test", state: "mature" })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.sidecar).toMatchObject({
      name: "fix-failing-test",
      version: 1,
      state: "mature",
      createdBy: "skillReflection",
    })
    expect(store().readSidecar(project, "fix-failing-test")?.state).toBe("mature")
    // A sidecar-only change never rewrites the skill body.
    expect(readFileSync(join(learned, "fix-failing-test", "SKILL.md"), "utf8")).toContain(
      "Locate the failing assertion",
    )
  })

  test("a sidecar left behind by a new body is not trusted, and a sidecar update repairs it", () => {
    expect(store().write(input({ body: "First body." })).ok).toBe(true)
    // The intermediate state a crash between the body and the sidecar leaves: the body moved on, the
    // sidecar still points at the old version.
    const newBody = serialiseLearnedSkill({
      name: "fix-failing-test",
      description: "Use when a test fails",
      body: "Second body.",
    })
    writeFileSync(join(learned, "fix-failing-test", "SKILL.md"), newBody)
    expect(store().readSidecar(project, "fix-failing-test")).toBeUndefined()

    // The next sidecar write repairs the hash against the body on disk and is readable again.
    const updated = store().updateSidecar({ projectID: project, name: "fix-failing-test", state: "mature" })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.sidecar.contentHash).toBe(contentHashOf(newBody))
    expect(store().readSidecar(project, "fix-failing-test")?.state).toBe("mature")
  })

  test("refuses to update a missing skill or one that is not self-authored", () => {
    expect(store().updateSidecar({ projectID: project, name: "missing", state: "mature" })).toEqual({
      ok: false,
      reason: "not-found",
    })
    write(join(learned, "human", "SKILL.md"), humanSkill("human"))
    expect(store().updateSidecar({ projectID: project, name: "human", state: "mature" })).toEqual({
      ok: false,
      reason: "not-self-authored",
    })
  })
})
