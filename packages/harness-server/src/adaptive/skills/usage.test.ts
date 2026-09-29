import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLearnedStore } from "./learned-store"
import type { SkillUsage } from "./learned-store"
import { EMPTY_USAGE, bumpUsage, recallRate, sameUsage, usageDelta } from "./usage"
import { nextSkillState } from "./lifecycle"
import { createSkillCurator } from "./curator"

describe("the usage arithmetic (FH-043)", () => {
  test("a bump moves exactly one counter", () => {
    const once = bumpUsage(EMPTY_USAGE, "load")
    expect(once).toEqual({ load: 1, view: 0, patch: 0, opportunities: 0 })
    expect(bumpUsage(once, "view")).toEqual({ load: 1, view: 1, patch: 0, opportunities: 0 })
    expect(bumpUsage(once, "patch")).toEqual({ load: 1, view: 0, patch: 1, opportunities: 0 })
    expect(bumpUsage(once, "opportunities")).toEqual({ load: 1, view: 0, patch: 0, opportunities: 1 })
  })

  test("the delta is a non-negative window and equality is exact", () => {
    const base: SkillUsage = { load: 1, view: 0, patch: 1, opportunities: 3 }
    const now: SkillUsage = { load: 3, view: 2, patch: 1, opportunities: 9 }
    expect(usageDelta(now, base)).toEqual({ load: 2, view: 2, patch: 0, opportunities: 6 })
    // A stale reading never goes negative.
    expect(usageDelta(base, now)).toEqual({ load: 0, view: 0, patch: 0, opportunities: 0 })
    expect(sameUsage(base, { ...base })).toBe(true)
    expect(sameUsage(base, now)).toBe(false)
  })

  test("the rate is load over opportunities from creation, never over time", () => {
    expect(recallRate(EMPTY_USAGE)).toBe(0)
    expect(recallRate({ load: 3, view: 0, patch: 0, opportunities: 10 })).toBeCloseTo(0.3)
  })
})

let root = ""
let home = ""
let config = ""
let xdg = ""
let project = ""
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-usage-"))
  home = join(root, "home")
  config = join(root, "config")
  xdg = join(root, "xdg")
  project = join(root, "project")
  for (const directory of [home, config, xdg, project]) mkdirSync(directory, { recursive: true })
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

describe("the counters on disk", () => {
  // No override: the default root under the temp project is the one `skillReport` can scan.
  const env = () => ({})
  const body = `## Steps\n${"Do the thing carefully. ".repeat(20)}`.trim()

  const setup = () => {
    const store = createLearnedStore({ env: env() })
    const skills = createSkillCurator({ store })
    store.write({ projectID: project, name: "fix-failing-test", description: "Use when a test fails", body })
    return { store, skills }
  }

  test("load, view and patch are distinct counters", () => {
    const { store, skills } = setup()
    skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded: ["fix-failing-test"] })
    skills.promote({
      projectID: project,
      episodeID: "episode:run:2",
      intent: "patch",
      targetSkill: "fix-failing-test",
      name: "fix-failing-test",
      description: "Use when a test fails",
      body,
      evidenceRefs: ["episode:run:2"],
    })

    const before = store.readSidecar(project, "fix-failing-test")!
    store.updateSidecar({
      projectID: project,
      name: "fix-failing-test",
      usage: bumpUsage(before.usage, "view"),
      since: before.since,
    })

    const sidecar = store.readSidecar(project, "fix-failing-test")!
    expect(sidecar.usage).toEqual({ load: 1, view: 1, patch: 1, opportunities: 1 })
  })

  test("the rate is measured over candidate decisions from creation", () => {
    const { skills } = setup()
    for (let index = 0; index < 10; index++) {
      const loaded = index < 3 ? ["fix-failing-test"] : []
      skills.recordSelection({ projectID: project, roster: skills.roster(project), loaded })
    }
    expect(skills.recallRate(project, "fix-failing-test")).toBeCloseTo(0.3)
    expect(skills.recallRate(project, "never-seen")).toBe(0)
  })

  test("a reserved view is accounted and does not break the lifecycle", () => {
    const { store, skills } = setup()
    const sidecar = store.readSidecar(project, "fix-failing-test")!
    store.updateSidecar({ projectID: project, name: "fix-failing-test", usage: bumpUsage(sidecar.usage, "view") })
    expect(store.readSidecar(project, "fix-failing-test")!.usage.view).toBe(1)

    // A view inside a mature window keeps the skill from aging out, exactly like a load: with enough
    // opportunities and no view the same window would be `stale`.
    const base: SkillUsage = { load: 0, view: 0, patch: 0, opportunities: 5 }
    const quiet: SkillUsage = { load: 0, view: 0, patch: 0, opportunities: 20 }
    const viewed: SkillUsage = { load: 0, view: 1, patch: 0, opportunities: 20 }
    expect(nextSkillState({ state: "mature", usage: quiet, since: base })).toMatchObject({ changed: true, to: "stale" })
    expect(nextSkillState({ state: "mature", usage: viewed, since: base })).toMatchObject({
      changed: false,
      state: "mature",
    })
    expect(skills.recallRate(project, "fix-failing-test")).toBe(0)
  })
})
