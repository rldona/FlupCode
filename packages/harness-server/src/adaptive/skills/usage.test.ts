import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteRoutineRepository } from "../../repository"
import { createLearnedStore } from "./learned-store"
import type { SkillUsage } from "./learned-store"
import { bumpUsage, recallRate, sessionSkills } from "./usage"
import { createSkillCurator } from "./curator"

const EMPTY: SkillUsage = { load: 0, view: 0, patch: 0, opportunities: 0 }

describe("the usage arithmetic (FH-043, AH-F02)", () => {
  test("a bump moves exactly one counter", () => {
    const once = bumpUsage(EMPTY, "load")
    expect(once).toEqual({ load: 1, view: 0, patch: 0, opportunities: 0 })
    expect(bumpUsage(once, "view")).toEqual({ load: 1, view: 1, patch: 0, opportunities: 0 })
    expect(bumpUsage(once, "patch")).toEqual({ load: 1, view: 0, patch: 1, opportunities: 0 })
    expect(bumpUsage(once, "opportunities")).toEqual({ load: 1, view: 0, patch: 0, opportunities: 1 })
  })

  test("the rate is real sessions that used it over real sessions seen, never over time", () => {
    expect(recallRate(EMPTY)).toBe(0)
    expect(recallRate({ load: 3, view: 0, patch: 0, opportunities: 10 })).toBeCloseTo(0.3)
  })

  test("a session's skills are the engine's `skill` tool calls across its turns, once each", () => {
    expect(sessionSkills([])).toEqual([])
    expect(sessionSkills([{ skills: ["a", "b"] }, { skills: [] }, { skills: ["b", "c"] }])).toEqual(["a", "b", "c"])
  })

  test("reads the skill loads the session-metrics plugin recorded, and nothing else", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const tool = (id: string, turnID: string, name: string, skill?: string) =>
      repository.recordSessionMetric({
        sessionID: "ses_1",
        projectID: "/w",
        observation: { kind: "tool", id, turnID, tool: name, error: false, bytes: 10, ...(skill ? { skill } : {}) },
      })
    tool("t1", "msg_u1", "skill", "fix-failing-test")
    tool("t2", "msg_u1", "read")
    tool("t3", "msg_u2", "skill", "fix-failing-test")
    tool("t4", "msg_u2", "skill", "deploy")
    expect(sessionSkills(repository.listSessionMetrics("ses_1"))).toEqual(["fix-failing-test", "deploy"])
    expect(sessionSkills(repository.listSessionMetrics("ses_other"))).toEqual([])
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
    skills.recordSession({ projectID: project, sessionID: "ses_1", skills: ["fix-failing-test"] })
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
    store.updateSidecar({ projectID: project, name: "fix-failing-test", usage: bumpUsage(before.usage, "view") })

    const sidecar = store.readSidecar(project, "fix-failing-test")!
    expect(sidecar.usage).toEqual({ load: 1, view: 1, patch: 1, opportunities: 1 })
  })

  test("the rate is measured over real sessions from install", () => {
    const { skills } = setup()
    for (let index = 0; index < 10; index++) {
      const used = index < 3 ? ["fix-failing-test"] : []
      skills.recordSession({ projectID: project, sessionID: `ses_${index}`, skills: used })
    }
    expect(skills.recallRate(project, "fix-failing-test")).toBeCloseTo(0.3)
    expect(skills.recallRate(project, "never-seen")).toBe(0)
  })

  test("a skill the model never called is not used, whatever the harness suggested", () => {
    const { store, skills } = setup()
    // Another skill's call, and a human skill's, are not this skill's use.
    skills.recordSession({ projectID: project, sessionID: "ses_1", skills: ["other-skill"] })
    expect(store.readSidecar(project, "fix-failing-test")).toMatchObject({
      usage: { load: 0, opportunities: 1 },
      sessionsSinceUse: 1,
    })
  })
})
