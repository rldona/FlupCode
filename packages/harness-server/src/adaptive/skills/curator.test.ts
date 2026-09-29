import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skillReport } from "../../skills"
import type { SkillProposal } from "../learning/proposal"
import { createLearnedStore, learnedRoots, SNAPSHOT_KEEP } from "./learned-store"
import { createSkillCurator } from "./curator"

let root = ""
let home = ""
let config = ""
let xdg = ""
let project = ""
let learned = ""
let outside = ""
const saved: Record<string, string | undefined> = {}

/** The default, scannable roots under the temp project: only this path makes `skillReport` see it. */
const scannableRoots = () => learnedRoots(project, {})

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

const humanSkill = (name: string) => `---\nname: ${name}\ndescription: A human skill\n---\n\nDo the human thing.\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-curator-"))
  home = join(root, "home")
  config = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  outside = join(root, "outside")
  for (const directory of [home, config, xdg, project, outside]) mkdirSync(directory, { recursive: true })
  learned = scannableRoots().learned
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

// No override: the learned skill lands where the engine and `skillReport` actually scan it.
const store = () => createLearnedStore({ env: {} })
const curator = (created = store()) => createSkillCurator({ store: created })

const body = (label = "Do the thing carefully. ") => `## Steps\n${label.repeat(20)}`.trim()

const proposal = (over: Partial<SkillProposal> = {}): SkillProposal => ({
  projectID: project,
  episodeID: "episode:run:1",
  decisionID: "skillReflection:episode:run:1",
  intent: "add",
  name: "fix-failing-test",
  description: "Use when a test fails and the failing assertion is not obvious",
  body: body(),
  evidenceRefs: ["episode:run:1"],
  modelVersion: "prov/small",
  ...over,
})

describe("promotion (FH-041)", () => {
  test("promotes a valid proposal into probation, with the marker, the sidecar and the ledger", () => {
    const result = curator().promote(proposal())
    expect(result).toMatchObject({ ok: true, state: "probation", version: 1 })
    if (!result.ok) return

    expect(result.path).toBe(join(learned, "fix-failing-test", "SKILL.md"))
    expect(readFileSync(result.path, "utf8")).toContain("self-authored: true")
    const sidecar = store().readSidecar(project, "fix-failing-test")!
    expect(sidecar).toMatchObject({
      name: "fix-failing-test",
      version: 1,
      state: "probation",
      createdBy: "skillReflection",
      usage: { load: 0, view: 0, patch: 0, opportunities: 0 },
      since: { load: 0, view: 0, patch: 0, opportunities: 0 },
    })
    expect(readFileSync(join(learned, "fix-failing-test", ".ledger.jsonl"), "utf8")).toContain('"event":"created"')
    expect(skillReport(project, project).find((file) => file.name === "fix-failing-test")).toMatchObject({
      loaded: true,
      learned: true,
    })
  })

  test("an interrupted promotion leaves no partial skill, and a retry completes it", () => {
    // `SKILL.md.tmp` as a directory makes the final rename fail after the sidecar and ledger are written.
    const folder = join(learned, "fix-failing-test")
    mkdirSync(join(folder, "SKILL.md.tmp"), { recursive: true })

    const interrupted = curator().promote(proposal())
    expect(interrupted).toEqual({ ok: false, reason: "write-failed" })
    expect(existsSync(join(folder, "SKILL.md"))).toBe(false)
    // The half-written folder is invisible to the engine's scanner: no partial skill.
    expect(skillReport(project, project).some((file) => file.name === "fix-failing-test")).toBe(false)

    rmSync(join(folder, "SKILL.md.tmp"), { recursive: true, force: true })
    expect(curator().promote(proposal()).ok).toBe(true)
    expect(existsSync(join(folder, "SKILL.md"))).toBe(true)
  })

  test("a patch bumps the version, snapshots within SNAPSHOT_KEEP and counts the patch", () => {
    expect(curator().promote(proposal()).ok).toBe(true)
    for (let index = 0; index < 7; index++) {
      const patched = curator().promote(
        proposal({ intent: "patch", targetSkill: "fix-failing-test", body: body(`Step ${index}. `) }),
      )
      expect(patched.ok).toBe(true)
    }

    const sidecar = store().readSidecar(project, "fix-failing-test")!
    expect(sidecar.version).toBe(8)
    expect(sidecar.usage.patch).toBe(7)
    const versions = readdirSync(join(learned, "fix-failing-test", ".versions"))
    expect(versions).toHaveLength(SNAPSHOT_KEEP)
    expect(versions.every((entry) => entry.endsWith(".txt"))).toBe(true)
  })

  test("refuses merge and drop with an explicit reason", () => {
    expect(curator().promote(proposal({ intent: "drop" }))).toEqual({ ok: false, reason: "unsupported-intent" })
    expect(curator().promote(proposal({ intent: "merge", targetSkill: "ghost" }))).toEqual({
      ok: false,
      reason: "merge-target-missing",
    })

    expect(curator().promote(proposal()).ok).toBe(true)
    expect(curator().promote(proposal({ intent: "merge", targetSkill: "fix-failing-test" }))).toEqual({
      ok: false,
      reason: "unsupported-intent",
    })
  })

  test("refuses a name a human skill uses, without touching it", () => {
    const humanPath = join(project, ".opencode", "skills", "shared", "SKILL.md")
    write(humanPath, humanSkill("shared"))
    expect(curator().promote(proposal({ name: "shared" }))).toEqual({ ok: false, reason: "name-collision" })
    expect(readFileSync(humanPath, "utf8")).toBe(humanSkill("shared"))
  })

  test("refuses an invalid name and a write that escapes the learned root", () => {
    expect(curator().promote(proposal({ name: "../escape" }))).toEqual({ ok: false, reason: "invalid-name" })

    mkdirSync(learned, { recursive: true })
    symlinkSync(outside, join(learned, "sneaky"))
    expect(curator().promote(proposal({ name: "sneaky" }))).toEqual({ ok: false, reason: "path-escape" })
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false)
  })

  test("the roster distinguishes human from learned and carries the sidecar state", () => {
    write(join(project, ".opencode", "skills", "human-skill", "SKILL.md"), humanSkill("human-skill"))
    curator().promote(proposal())

    const entries = curator().roster(project)
    expect(entries.find((entry) => entry.name === "human-skill")).toMatchObject({ learned: false })
    expect(entries.find((entry) => entry.name === "fix-failing-test")).toMatchObject({
      learned: true,
      state: "probation",
      usage: { load: 0, view: 0, patch: 0, opportunities: 0 },
    })
  })
})

describe("the learning kill switch stops usage writes (FH-043)", () => {
  test("with learning off promote is a no-op and writes nothing", () => {
    const off = createSkillCurator({ store: store(), enabled: () => false })
    expect(off.promote(proposal())).toEqual({ ok: false, reason: "disabled" })
    expect(existsSync(join(learned, "fix-failing-test"))).toBe(false)
  })

  test("with learning off a selection records nothing, while the roster still reads for the shadow", () => {
    const created = store()
    expect(
      created.write({ projectID: project, name: "gated", description: "Use when gated", body: body() }).ok,
    ).toBe(true)
    const sidecarPath = join(learned, "gated", ".sidecar.json")
    const ledgerPath = join(learned, "gated", ".ledger.jsonl")
    const beforeSidecar = readFileSync(sidecarPath)
    const beforeLedger = readFileSync(ledgerPath)
    const beforeMtime = statSync(sidecarPath).mtimeMs

    const off = createSkillCurator({ store: created, enabled: () => false })
    // The shadow still needs the roster to evaluate relevance; only the writer is inert.
    const roster = off.roster(project)
    expect(roster.some((entry) => entry.name === "gated" && entry.learned)).toBe(true)
    off.recordSelection({ projectID: project, roster, loaded: ["gated"] })

    expect(readFileSync(sidecarPath).equals(beforeSidecar)).toBe(true)
    expect(readFileSync(ledgerPath).equals(beforeLedger)).toBe(true)
    expect(statSync(sidecarPath).mtimeMs).toBe(beforeMtime)
    expect(store().readSidecar(project, "gated")!.usage).toMatchObject({ load: 0, opportunities: 0 })

    // With the switch on, the same call moves the counters.
    const on = createSkillCurator({ store: created, enabled: () => true })
    on.recordSelection({ projectID: project, roster: on.roster(project), loaded: ["gated"] })
    expect(store().readSidecar(project, "gated")!.usage).toMatchObject({ load: 1, opportunities: 1 })
  })

  test("with learning off recompute and archive are inert and touch nothing", () => {
    const created = store()
    expect(
      created.write({ projectID: project, name: "gated", description: "Use when gated", body: body() }).ok,
    ).toBe(true)
    const folder = join(learned, "gated")
    const sidecarPath = join(folder, ".sidecar.json")
    const ledgerPath = join(folder, ".ledger.jsonl")
    const beforeSidecar = readFileSync(sidecarPath)
    const beforeLedger = readFileSync(ledgerPath)
    const beforeMtime = statSync(sidecarPath).mtimeMs

    const off = createSkillCurator({ store: created, enabled: () => false })
    expect(off.recompute(project)).toEqual([])
    expect(off.archive(project, "gated", "stale")).toBe(false)

    expect(readFileSync(sidecarPath).equals(beforeSidecar)).toBe(true)
    expect(readFileSync(ledgerPath).equals(beforeLedger)).toBe(true)
    expect(statSync(sidecarPath).mtimeMs).toBe(beforeMtime)
    // The skill never left its root.
    expect(existsSync(join(folder, "SKILL.md"))).toBe(true)
  })
})

describe("reading a skill to patch it (FH-042/FH-043)", () => {
  test("returns the current body and counts the re-read as a view", () => {
    const created = store()
    expect(curator(created).promote(proposal()).ok).toBe(true)

    const current = createSkillCurator({ store: created }).readExisting(project, "fix-failing-test")
    expect(current).toMatchObject({ name: "fix-failing-test", description: proposal().description })
    expect(current!.body).toContain("Do the thing carefully.")
    expect(store().readSidecar(project, "fix-failing-test")!.usage).toMatchObject({ view: 1, load: 0, patch: 0 })
    // A name that is not a learned skill yields nothing and never bumps a counter.
    expect(createSkillCurator({ store: created }).readExisting(project, "ghost")).toBeUndefined()
  })
})

describe("human skills are never touched", () => {
  test("stay byte-identical through a full curator pass", () => {
    const humanPath = join(project, ".opencode", "skills", "human-skill", "SKILL.md")
    write(humanPath, humanSkill("human-skill"))
    const before = readFileSync(humanPath)
    const beforeStat = lstatSync(humanPath)

    const skills = curator()
    skills.promote(proposal())
    skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded: ["fix-failing-test"] })
    skills.promote(proposal({ intent: "patch", targetSkill: "fix-failing-test", body: body("Patched. ") }))
    skills.recompute(project)
    skills.archive(project, "fix-failing-test", "test")

    expect(readFileSync(humanPath).equals(before)).toBe(true)
    expect(lstatSync(humanPath).mtimeMs).toBe(beforeStat.mtimeMs)
    expect(skillReport(project, project).find((file) => file.name === "human-skill")).toMatchObject({ loaded: true })
  })

  test("the learned root is the only place the curator writes", () => {
    curator().promote(proposal())
    // The default root is under the project's own `.opencode/skills`, never a sibling tree.
    expect(learnedRoots(project, {})).toEqual({
      learned: join(project, ".opencode", "skills", "flupcode-learned"),
      archive: join(project, ".opencode", "flupcode-learned-archive"),
    })
  })
})

describe("reverse collision: the human wins (FH-081, ADR-0022 §4)", () => {
  const humanPath = () => join(project, ".opencode", "skills", "shared", "SKILL.md")
  const archivePath = () => join(project, ".opencode", "flupcode-learned-archive", "shared")

  /** A learned skill that a human file with the same name only appears for afterwards. */
  const collided = () => {
    const created = store()
    expect(
      created.write({ projectID: project, name: "shared", description: "A learned skill", body: body() }).ok,
    ).toBe(true)
    write(humanPath(), humanSkill("shared"))
    return created
  }

  test("the shadowed learned skill is excluded from the roster, so it is never counted as used", () => {
    const created = collided()
    const skills = createSkillCurator({ store: created })
    // `skillReport` is first-wins and can mark the learned one loaded; the roster still drops it.
    expect(skills.roster(project).some((entry) => entry.name === "shared")).toBe(false)

    skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded: ["shared"] })
    expect(created.readSidecar(project, "shared")!.usage).toMatchObject({ opportunities: 0, load: 0 })
    // The human file is byte-identical: nothing touched it.
    expect(readFileSync(humanPath(), "utf8")).toBe(humanSkill("shared"))
  })

  test("reconcile archives the learned skill through the single writer, with the reason recorded", () => {
    const created = collided()
    const skills = createSkillCurator({ store: created, now: () => 1_000 })
    expect(skills.reconcile(project, 1_000)).toEqual([{ name: "shared", reason: "human-name-collision" }])

    // Archive-not-delete: the folder moved out of `skills/` and into the archive.
    expect(existsSync(join(learned, "shared", "SKILL.md"))).toBe(false)
    expect(existsSync(join(archivePath(), "SKILL.md"))).toBe(true)
    const sidecar: unknown = JSON.parse(readFileSync(join(archivePath(), ".sidecar.json"), "utf8"))
    expect(sidecar).toMatchObject({ state: "archived" })
    const ledger = readFileSync(join(archivePath(), ".ledger.jsonl"), "utf8").trim().split("\n")
    expect(JSON.parse(ledger.at(-1)!)).toMatchObject({ event: "archived", reason: "human-name-collision" })
    // Once it left the learned root there is nothing left to reconcile.
    expect(createSkillCurator({ store: created }).reconcile(project)).toEqual([])
    expect(readFileSync(humanPath(), "utf8")).toBe(humanSkill("shared"))
  })

  test("recompute reconciles first, so the collision is repaired on disk by the sweep", () => {
    const created = collided()
    const skills = createSkillCurator({ store: created })
    expect(skills.recompute(project, 1_000)).toEqual([])
    expect(existsSync(join(learned, "shared", "SKILL.md"))).toBe(false)
    expect(existsSync(join(archivePath(), "SKILL.md"))).toBe(true)
  })

  test("with learning off the read exclusion still protects, and the collision is repaired on disk", () => {
    const created = collided()
    const off = createSkillCurator({ store: created, enabled: () => false })
    expect(off.roster(project).some((entry) => entry.name === "shared")).toBe(false)
    // A reverse collision is a security move, not a learning write: it is repaired even with the
    // switch off, so the human wins on disk too (ADR-0022 §4).
    expect(off.reconcile(project)).toEqual([{ name: "shared", reason: "human-name-collision" }])
    expect(existsSync(join(learned, "shared", "SKILL.md"))).toBe(false)
    expect(existsSync(join(archivePath(), "SKILL.md"))).toBe(true)
    expect(readFileSync(humanPath(), "utf8")).toBe(humanSkill("shared"))
  })

  test("a malformed human SKILL.md is not a claim and never archives a healthy learned skill", () => {
    const created = store()
    expect(
      created.write({ projectID: project, name: "shared", description: "A learned skill", body: body() }).ok,
    ).toBe(true)
    // The frontmatter cannot be read, so `skillReport` parses no name from it. The learned skill is
    // not shadowed and must survive: the tightening can only fail to exclude, never wrongly archive.
    write(humanPath(), "---\nname: [shared\n---\n\nA human skill with broken frontmatter.\n")
    const skills = createSkillCurator({ store: created })
    expect(skills.reconcile(project)).toEqual([])
    expect(existsSync(join(learned, "shared", "SKILL.md"))).toBe(true)
  })

  test("a learned skill no human claims is offered and reconciling it is a no-op", () => {
    const created = store()
    expect(created.write({ projectID: project, name: "solo", description: "A learned skill", body: body() }).ok).toBe(
      true,
    )
    const skills = createSkillCurator({ store: created })
    expect(skills.roster(project).some((entry) => entry.name === "solo")).toBe(true)
    expect(skills.reconcile(project)).toEqual([])
    expect(existsSync(join(learned, "solo", "SKILL.md"))).toBe(true)
  })
})

describe("cross-project isolation: a learned skill never leaks or collides across projects (FH-081)", () => {
  test("another project's roster never offers it and its reconcile never archives it", () => {
    const other = join(root, "other-project")
    mkdirSync(other, { recursive: true })
    const created = store()
    expect(
      created.write({ projectID: project, name: "shared", description: "A learned skill", body: body() }).ok,
    ).toBe(true)
    // A human claims the same name, but in a *different* project: it must neither shadow nor archive
    // the learned skill that belongs to `project`.
    write(join(other, ".opencode", "skills", "shared", "SKILL.md"), humanSkill("shared"))

    const skills = createSkillCurator({ store: created })
    expect(skills.roster(project).some((entry) => entry.name === "shared" && entry.learned)).toBe(true)
    expect(skills.roster(other).some((entry) => entry.name === "shared" && entry.learned)).toBe(false)
    // The recompute for the other project finds no learned collision: nothing of ours is touched.
    expect(skills.reconcile(other)).toEqual([])
    expect(existsSync(join(learned, "shared", "SKILL.md"))).toBe(true)
  })
})
