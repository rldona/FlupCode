import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillUsage } from "./learned-store"
import { COUNTED_SESSIONS_KEEP, createLearnedStore, learnedRoots, SIDECAR_FILE } from "./learned-store"
import type { SkillUse } from "./lifecycle"
import { DEFAULT_LIFECYCLE_CONFIG, foldSession, suggestsArchive } from "./lifecycle"
import { createSkillCurator } from "./curator"

const usage = (over: Partial<SkillUsage> = {}): SkillUsage => ({
  load: 0,
  view: 0,
  patch: 0,
  opportunities: 0,
  ...over,
})

const fresh = (over: Partial<SkillUse> = {}): SkillUse => ({
  state: "probation",
  usage: usage(),
  sessionsSinceUse: 0,
  ...over,
})

describe("the single-sidecar lifecycle (AH-F02)", () => {
  test("a used session counts a load, resets the unused count and promotes probation", () => {
    const folded = foldSession(fresh({ sessionsSinceUse: 7 }), { id: "ses_a", used: true, at: 50 })!
    expect(folded.next).toMatchObject({
      state: "mature",
      usage: { load: 1, opportunities: 1 },
      lastUsedAt: 50,
      sessionsSinceUse: 0,
      countedSessions: [{ id: "ses_a", used: true }],
    })
    expect(folded.events).toEqual([
      { at: 50, event: "usage", kind: "load", total: 1 },
      { at: 50, event: "state", from: "probation", to: "mature", reason: "used" },
    ])
  })

  test("an unused session only advances the unused count, and never changes the state", () => {
    const folded = foldSession(fresh({ state: "mature" }), { id: "ses_a", used: false, at: 50 })!
    expect(folded.next).toMatchObject({ state: "mature", usage: { load: 0, opportunities: 1 }, sessionsSinceUse: 1 })
    expect(folded.next.lastUsedAt).toBeUndefined()
    expect(folded.events).toEqual([])
  })

  test("a session counts once, but a later use of an unused session still counts", () => {
    const once = foldSession(fresh(), { id: "ses_a", used: false, at: 1 })!.next
    expect(foldSession(once, { id: "ses_a", used: false, at: 2 })).toBeUndefined()

    const used = foldSession(once, { id: "ses_a", used: true, at: 3 })!.next
    // The same session: one opportunity, now one load, and the unused count it earned is taken back.
    expect(used).toMatchObject({ usage: { load: 1, opportunities: 1 }, sessionsSinceUse: 0, lastUsedAt: 3 })
    expect(foldSession(used, { id: "ses_a", used: true, at: 4 })).toBeUndefined()
    expect(foldSession(used, { id: "ses_a", used: false, at: 4 })).toBeUndefined()
  })

  test("the memory of counted sessions is bounded", () => {
    const last = Array.from({ length: COUNTED_SESSIONS_KEEP + 3 }, (_, index) => `ses_${index}`).reduce(
      (current, id) => foldSession(current, { id, used: false, at: 1 })!.next,
      fresh(),
    )
    expect(last.countedSessions).toHaveLength(COUNTED_SESSIONS_KEEP)
    expect(last.usage.opportunities).toBe(COUNTED_SESSIONS_KEEP + 3)
  })

  test("stale and merged are frozen: nothing assigns them, and a used stale skill leaves stale", () => {
    const states = ["probation", "mature", "stale", "merged"] as const
    for (const state of states) {
      for (const used of [true, false]) {
        const folded = foldSession(fresh({ state, sessionsSinceUse: 1_000 }), { id: "ses_a", used, at: 1 })!
        if (state !== "stale") expect(folded.next.state).not.toBe("stale")
        if (state !== "merged") expect(folded.next.state).not.toBe("merged")
        expect(folded.next.state).not.toBe("archived")
      }
    }
    expect(foldSession(fresh({ state: "stale" }), { id: "ses_a", used: true, at: 1 })!.next.state).toBe("mature")
    expect(foldSession(fresh({ state: "merged" }), { id: "ses_a", used: true, at: 1 })!.next.state).toBe("merged")
  })

  test("archiving is suggested only after archiveAfter unused sessions, never for a terminal state", () => {
    const config = { archiveAfter: 3 }
    expect(suggestsArchive({ state: "mature", sessionsSinceUse: 2 }, config)).toBe(false)
    expect(suggestsArchive({ state: "mature", sessionsSinceUse: 3 }, config)).toBe(true)
    expect(suggestsArchive({ state: "probation", sessionsSinceUse: 3 }, config)).toBe(true)
    expect(suggestsArchive({ state: "merged", sessionsSinceUse: 99 }, config)).toBe(false)
    expect(suggestsArchive({ state: "archived", sessionsSinceUse: 99 }, config)).toBe(false)
    expect(DEFAULT_LIFECYCLE_CONFIG.archiveAfter).toBeGreaterThanOrEqual(10)
  })

  test("a used skill never proposes archiving, however many sessions pass", () => {
    const config = { archiveAfter: 3 }
    const last = Array.from({ length: 200 }, (_, index) => index).reduce((current, index) => {
      // Used in every third session: the unused count never reaches the threshold.
      const next = foldSession(current, { id: `ses_${index}`, used: index % 3 === 0, at: index })!.next
      expect(suggestsArchive(next, config)).toBe(false)
      return next
    }, fresh())
    expect(last.usage.load).toBe(67)
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
  const numbers = { archiveAfter: 3 }
  const body = `## Steps\n${"Do the thing carefully. ".repeat(20)}`.trim()

  test("an unused skill is suggested for archiving but never moved or marked stale", () => {
    const store = createLearnedStore({ env: {} })
    const skills = createSkillCurator({ store, config: () => numbers })
    expect(store.write({ projectID: project, name: "quiet-skill", description: "Use when quiet", body }).ok).toBe(true)

    for (let index = 0; index < 2; index++)
      skills.recordSession({ projectID: project, sessionID: `ses_${index}`, skills: [] })
    expect(skills.recompute(project)).toEqual([])

    skills.recordSession({ projectID: project, sessionID: "ses_2", skills: [] })
    expect(skills.recompute(project)).toEqual([{ name: "quiet-skill", unusedSessions: 3 }])
    expect(skills.roster(project).find((entry) => entry.name === "quiet-skill")).toMatchObject({
      state: "probation",
      sessionsSinceUse: 3,
      suggestArchive: true,
    })
    // The sweep only suggests: the skill is still loaded and still `probation`.
    for (let index = 3; index < 30; index++)
      skills.recordSession({ projectID: project, sessionID: `ses_${index}`, skills: [] })
    skills.recompute(project)
    expect(existsSync(join(learned, "quiet-skill", "SKILL.md"))).toBe(true)
    expect(existsSync(join(archive, "quiet-skill"))).toBe(false)
    expect(store.readSidecar(project, "quiet-skill")!.state).toBe("probation")
  })

  test("a real use promotes the skill, records when, and clears the suggestion", () => {
    const store = createLearnedStore({ env: {} })
    const skills = createSkillCurator({ store, config: () => numbers })
    store.write({ projectID: project, name: "used-skill", description: "Use when used", body })

    for (let index = 0; index < 3; index++)
      skills.recordSession({ projectID: project, sessionID: `ses_${index}`, skills: [] })
    expect(skills.recompute(project)).toHaveLength(1)

    skills.recordSession({ projectID: project, sessionID: "ses_used", skills: ["used-skill"], at: 9_000 })
    expect(skills.recompute(project)).toEqual([])
    expect(store.readSidecar(project, "used-skill")).toMatchObject({
      state: "mature",
      lastUsedAt: 9_000,
      sessionsSinceUse: 0,
      usage: { load: 1, opportunities: 4 },
    })
    const ledger = readFileSync(join(learned, "used-skill", ".ledger.jsonl"), "utf8")
    expect(ledger).toContain('"to":"mature"')
    expect(ledger).toContain('"kind":"load"')
  })

  test("a sidecar from before AH-F02 is migrated on read and rewritten in the new shape", () => {
    const store = createLearnedStore({ env: {} })
    const skills = createSkillCurator({ store, config: () => numbers })
    store.write({ projectID: project, name: "legacy-skill", description: "Use when legacy", body })
    const path = join(learned, "legacy-skill", SIDECAR_FILE)
    // What the old writer left: suggestion-based counters, a `since` window and a `stale` state.
    const legacy = JSON.parse(readFileSync(path, "utf8"))
    delete legacy.usageSource
    delete legacy.sessionsSinceUse
    writeFileSync(
      path,
      JSON.stringify({
        ...legacy,
        state: "stale",
        usage: { load: 4, view: 1, patch: 2, opportunities: 40 },
        since: { load: 4, view: 1, patch: 2, opportunities: 30 },
        countedEpisodes: ["episode:run:1"],
      }),
    )

    // The suggestion counters are dropped; the harness's own view/patch survive; the state is kept.
    expect(store.readSidecar(project, "legacy-skill")).toMatchObject({
      state: "stale",
      usage: { load: 0, view: 1, patch: 2, opportunities: 0 },
      sessionsSinceUse: 0,
      usageSource: "engine",
    })
    expect(skills.recompute(project)).toEqual([])

    skills.recordSession({ projectID: project, sessionID: "ses_a", skills: [] })
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(written).toMatchObject({ usageSource: "engine", sessionsSinceUse: 1, state: "stale" })
    expect(written.since).toBeUndefined()
    expect(written.countedEpisodes).toBeUndefined()
  })
})
