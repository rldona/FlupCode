import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillUsage } from "./learned-store"
import { createLearnedStore, learnedRoots } from "./learned-store"
import { DEFAULT_LIFECYCLE_CONFIG, nextSkillState } from "./lifecycle"
import { createSkillCurator } from "./curator"

const usage = (over: Partial<SkillUsage> = {}): SkillUsage => ({
  load: 0,
  view: 0,
  patch: 0,
  opportunities: 0,
  ...over,
})

describe("the lifecycle machine (FH-042)", () => {
  const config = { probationSample: 3, staleAfter: 4, archiveAfter: 5 }

  test("a fresh skill installs into probation and waits for its sample", () => {
    expect(nextSkillState({ state: "probation", usage: usage({ opportunities: 2 }), config })).toMatchObject({
      changed: false,
      state: "probation",
    })
  })

  test("a selected probation skill graduates; a never-selected one ages out", () => {
    const graduated = nextSkillState({ state: "probation", usage: usage({ opportunities: 3, load: 1 }), config })
    expect(graduated).toMatchObject({ changed: true, from: "probation", to: "mature", reason: "graduated" })

    const stale = nextSkillState({ state: "probation", usage: usage({ opportunities: 3 }), config })
    expect(stale).toMatchObject({ changed: true, from: "probation", to: "stale", reason: "no-recall" })
  })

  test("probation is not evictable: it never reaches archived, whatever the opportunities", () => {
    for (let opportunities = 0; opportunities <= 50; opportunities++) {
      const decision = nextSkillState({ state: "probation", usage: usage({ opportunities }), config })
      if (decision.changed) expect(decision.to).not.toBe("archived")
    }
  })

  test("a mature skill with recent use stays; without it ages to stale", () => {
    const base = usage({ opportunities: 3, load: 1 })
    const recent = usage({ opportunities: 6, load: 2 })
    expect(nextSkillState({ state: "mature", usage: recent, since: base, config })).toMatchObject({
      changed: false,
      state: "mature",
    })
    expect(nextSkillState({ state: "mature", usage: recent, since: base, config }).since).toEqual(recent)

    const quiet = usage({ opportunities: 7, load: 1 })
    expect(nextSkillState({ state: "mature", usage: quiet, since: base, config })).toMatchObject({
      changed: true,
      from: "mature",
      to: "stale",
      reason: "no-recent-use",
    })
  })

  test("a stale skill is archived only when its window had no load or view", () => {
    const base = usage({ opportunities: 7, load: 1 })
    const used = usage({ opportunities: 12, load: 2 })
    expect(nextSkillState({ state: "stale", usage: used, since: base, config })).toMatchObject({
      changed: false,
      state: "stale",
    })

    const quiet = usage({ opportunities: 12, load: 1 })
    expect(nextSkillState({ state: "stale", usage: quiet, since: base, config })).toMatchObject({
      changed: true,
      from: "stale",
      to: "archived",
      reason: "aged-out",
    })
  })

  test("a patch returns the skill to probation, and terminal states never move", () => {
    expect(nextSkillState({ state: "mature", usage: usage({ opportunities: 9 }), patched: true, config })).toMatchObject({
      changed: true,
      to: "probation",
      reason: "patched",
    })
    expect(nextSkillState({ state: "archived", usage: usage({ opportunities: 999 }), config })).toMatchObject({
      changed: false,
      state: "archived",
    })
    expect(nextSkillState({ state: "merged", usage: usage({ opportunities: 999 }), config })).toMatchObject({
      changed: false,
      state: "merged",
    })
  })

  test("the defaults are conservative and ordered", () => {
    expect(DEFAULT_LIFECYCLE_CONFIG.probationSample).toBeLessThan(DEFAULT_LIFECYCLE_CONFIG.staleAfter)
    expect(DEFAULT_LIFECYCLE_CONFIG.staleAfter).toBeLessThan(DEFAULT_LIFECYCLE_CONFIG.archiveAfter)
  })
})

let root = ""
let home = ""
let config = ""
let xdg = ""
let project = ""
let learned = ""
let archive = ""
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-lifecycle-"))
  home = join(root, "home")
  config = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  for (const directory of [home, config, xdg, project]) mkdirSync(directory, { recursive: true })
  const roots = learnedRoots(project, {})
  learned = roots.learned
  archive = roots.archive
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

describe("the lifecycle on disk", () => {
  const numbers = { probationSample: 3, staleAfter: 4, archiveAfter: 5 }
  // No override: the default root under the temp project is the one `roster` can scan.
  const env = () => ({})

  test("graduates, ages to stale and archives by move, logging every transition", () => {
    const store = createLearnedStore({ env: env() })
    const skills = createSkillCurator({ store, config: () => numbers })

    expect(
      skills.promote({
        projectID: project,
        episodeID: "episode:run:1",
        intent: "add",
        name: "fix-failing-test",
        description: "Use when a test fails and the failing assertion is not obvious",
        body: `## Steps\n${"Do the thing carefully. ".repeat(20)}`.trim(),
        evidenceRefs: ["episode:run:1"],
      }).ok,
    ).toBe(true)

    const offer = (loaded: string[]) =>
      skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded })

    offer(["fix-failing-test"])
    offer([])
    offer([])
    expect(skills.recompute(project)).toEqual([
      { name: "fix-failing-test", from: "probation", to: "mature", reason: "graduated" },
    ])

    for (let index = 0; index < 4; index++) offer([])
    expect(skills.recompute(project)).toEqual([
      { name: "fix-failing-test", from: "mature", to: "stale", reason: "no-recent-use" },
    ])

    for (let index = 0; index < 5; index++) offer([])
    expect(skills.recompute(project)).toEqual([
      { name: "fix-failing-test", from: "stale", to: "archived", reason: "aged-out" },
    ])

    // Archive is a move: the skill left `skills/` and lives in the archive root.
    expect(existsSync(join(learned, "fix-failing-test"))).toBe(false)
    expect(existsSync(join(archive, "fix-failing-test", "SKILL.md"))).toBe(true)
    const archived = JSON.parse(readFileSync(join(archive, "fix-failing-test", ".sidecar.json"), "utf8"))
    expect(archived.state).toBe("archived")
    const ledger = readFileSync(join(archive, "fix-failing-test", ".ledger.jsonl"), "utf8")
    expect(ledger).toContain('"event":"state"')
    expect(ledger).toContain('"to":"mature"')
    expect(ledger).toContain('"event":"archived"')
  })

  test("a used mature skill is not archived by age alone", () => {
    const store = createLearnedStore({ env: env() })
    const skills = createSkillCurator({ store, config: () => numbers })
    store.write({
      projectID: project,
      name: "used-skill",
      description: "Use when a used skill is needed",
      body: `## Steps\n${"Do the thing carefully. ".repeat(20)}`.trim(),
    })

    const offer = (loaded: string[]) =>
      skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded })

    offer(["used-skill"])
    offer([])
    offer([])
    skills.recompute(project)
    // Every window keeps a recent load, so `mature` never ages out.
    for (let index = 0; index < 20; index++) {
      offer(["used-skill"])
      expect(skills.recompute(project)).toEqual([])
    }
    expect(store.readSidecar(project, "used-skill")!.state).toBe("mature")
  })
})
