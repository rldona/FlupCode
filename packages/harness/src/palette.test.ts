import { describe, expect, test } from "bun:test"
import { capped, kindsIn, search } from "./components/CommandPalette"
import type { SessionInfo } from "./engine-types"
import type { Artifact, CommandOption, ProjectItem, Routine, Run, Workflow } from "./types"

const session = (id: string, title: string, directory?: string, agent?: string) =>
  ({
    id,
    projectID: "p",
    title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    ...(directory ? { location: { directory } } : {}),
    ...(agent ? { agent } : {}),
  }) as unknown as SessionInfo

const empty = {
  commands: [] as CommandOption[],
  sessions: [] as SessionInfo[],
  projects: [] as ProjectItem[],
  artifacts: [] as Artifact[],
  routines: [] as Routine[],
  runs: [] as Run[],
  workflows: [] as Workflow[],
  files: [],
}

const routine = (id: string, name: string, enabled = true) =>
  ({ id, name, description: "", prompt: "", enabled, schedule: { type: "manual" }, runs: [] }) as unknown as Routine

describe("search", () => {
  test("an empty query finds everything, which is what an empty search box should show", () => {
    const items = search("", {
      ...empty,
      sessions: [session("s1", "One")],
      projects: [{ directory: "/w/app", name: "app" } as ProjectItem],
      routines: [routine("r1", "Nightly")],
    })
    expect(items.map((item) => item.kind)).toEqual(["session", "project", "routine"])
  })

  test("a session matches on its folder as well as its title", () => {
    const sessions = [session("s1", "Untitled", "/work/flupcode"), session("s2", "Untitled", "/work/other")]
    const found = search("flupcode", { ...empty, sessions })
    expect(found.map((item) => item.value)).toEqual(["s1"])
    // And the folder's last part is the detail, because two "Untitled" rows are otherwise the same.
    expect(found[0]!.detail).toBe("flupcode")
  })

  test("matching ignores case, so a search is not a spelling test", () => {
    expect(search("NIGHTLY", { ...empty, routines: [routine("r1", "Nightly audit")] })).toHaveLength(1)
  })

  test("a cowork session is marked, a code one is not", () => {
    const sessions = [session("c1", "Cowork one", "/w/app", "cowork"), session("s1", "Code one", "/w/app", "build")]
    const items = search("", { ...empty, sessions })
    expect(items.find((item) => item.value === "c1")?.cowork).toBe(true)
    expect(items.find((item) => item.value === "s1")?.cowork).toBe(false)
  })

  test("a paused routine says so, and a running one says nothing", () => {
    const [paused] = search("", { ...empty, routines: [routine("r1", "Off", false)] })
    const [running] = search("", { ...empty, routines: [routine("r2", "On", true)] })
    expect(paused!.detail).toBeDefined()
    expect(running!.detail).toBeUndefined()
  })

  test("a disabled command is offered but cannot be picked", () => {
    const commands = [{ name: "move", description: "", disabled: true }] as CommandOption[]
    expect(search("mo", { ...empty, commands })[0]).toMatchObject({ kind: "command", disabled: true })
  })

  test("files come back whatever the query, because the engine already matched them", () => {
    // The engine's own fuzzy search decided these; filtering them again here would drop its matches.
    const found = search("zzz", { ...empty, files: [{ path: "src/a.ts" } as never] })
    expect(found.map((item) => item.value)).toEqual(["src/a.ts"])
  })

  test("a source list that answers nothing does not take the palette down", () => {
    // A resource can resolve to `undefined` when a server answers without a value; the palette is
    // built on every render, so iterating that used to crash the whole app at startup.
    const broken = { ...empty, artifacts: undefined as unknown as Artifact[] }
    expect(() => search("", broken)).not.toThrow()
    expect(search("", broken)).toEqual([])
  })

  test("HF-1: workflows are found by name and description", () => {
    const workflows = [
      { name: "feature", description: "Plan and build", inputs: ["goal"], tasks: [] },
      { name: "review", description: "Review a diff", inputs: [], tasks: [] },
    ] as unknown as Workflow[]
    expect(search("feat", { ...empty, workflows }).map((item) => item.value)).toEqual(["feature"])
    expect(search("diff", { ...empty, workflows }).map((item) => item.kind)).toEqual(["workflow"])
  })
})

describe("kindsIn", () => {
  test("offers a tab only for what was actually found", () => {
    const items = search("", { ...empty, sessions: [session("s1", "One")], routines: [routine("r1", "R")] })
    // No tab for artifacts, runs, projects, commands or files: a tab that finds nothing is furniture.
    expect(kindsIn(items)).toEqual(["session", "routine"])
  })

  test("nothing found, no tabs", () => {
    expect(kindsIn([])).toEqual([])
  })
})

describe("capped", () => {
  test('"All" keeps a few of each kind rather than a hundred of one', () => {
    const sessions = Array.from({ length: 40 }, (_, index) => session(`s${index}`, `Session ${index}`))
    const items = search("", { ...empty, sessions, routines: [routine("r1", "Nightly")] })

    const shown = capped(items)

    expect(shown.filter((item) => item.kind === "session")).toHaveLength(6)
    // The routine is still there, which is the whole point: it was item 41 before the cap.
    expect(shown.filter((item) => item.kind === "routine")).toHaveLength(1)
  })

  test("keeps the kinds in their tab order, so the list and the tabs agree", () => {
    const items = search("", {
      ...empty,
      commands: [{ name: "new", description: "" } as CommandOption],
      sessions: [session("s1", "One")],
      routines: [routine("r1", "R")],
    })
    expect(capped(items).map((item) => item.kind)).toEqual(["session", "routine", "command"])
  })
})
