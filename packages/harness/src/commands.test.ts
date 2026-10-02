import { describe, expect, test } from "bun:test"
import { BUILTIN_COMMANDS, COMMAND_GROUPS, builtinCommand, runBuiltin, type CommandContext } from "./commands"

/** A context that writes down what it was asked to do, as `name(args)`. */
function recorder(input: { session?: string; draft?: string } = {}) {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.map(String).join(",")})`)
    }
  const context: CommandContext = {
    session: input.session,
    draft: input.draft ?? "",
    notify: record("notify"),
    newSession: record("newSession"),
    showScreen: record("showScreen"),
    openSettings: record("openSettings"),
    open: record("open"),
    send: record("send"),
    stash: record("stash"),
    compact: record("compact"),
    resume: record("resume"),
    skillify: record("skillify"),
    toggleSteps: record("toggleSteps"),
    toggleSidebar: record("toggleSidebar"),
    cycleTab: record("cycleTab"),
    closeTab: record("closeTab"),
    split: record("split"),
    rename: record("rename"),
    pin: record("pin"),
    remove: record("remove"),
  }
  return { context, calls }
}

// What each built-in does with a session open. The ones the palette alone used to know are here too,
// which is the point: the composer runs this same table.
const EXPECTED: Record<string, string> = {
  new: "newSession()",
  compact: "compact()",
  resume: "resume()",
  skillify: "skillify()",
  stash: "stash(draft)",
  stashes: "open(stashes)",
  rename: "rename(ses_1)",
  pin: "pin(ses_1)",
  split: "split(ses_1)",
  delete: "remove(ses_1)",
  "next-tab": "cycleTab(1)",
  "prev-tab": "cycleTab(-1)",
  "close-tab": "closeTab(ses_1)",
  files: "showScreen(files)",
  artifacts: "showScreen(artifacts)",
  skills: "open(skills)",
  workflows: "showScreen(workflows)",
  routines: "showScreen(routines)",
  actions: "showScreen(actions)",
  compare: "showScreen(compare)",
  "best-of-n": "open(best-of-n)",
  memory: "open(memory)",
  steps: "toggleSteps()",
  "toggle-sidebar": "toggleSidebar()",
  settings: "open(settings)",
  providers: "openSettings(providers)",
  mcp: "openSettings(mcp)",
  config: "open(config)",
  remote: "open(remote)",
  about: "open(about)",
}

describe("the built-in commands", () => {
  test("each one does one thing, and the table above covers all of them", () => {
    expect(BUILTIN_COMMANDS.map((command) => command.id).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const command of BUILTIN_COMMANDS) {
      const { context, calls } = recorder({ session: "ses_1", draft: "draft" })
      expect(runBuiltin(command.id, "", context)).toBe(true)
      expect(calls).toEqual([EXPECTED[command.id]!])
    }
  })

  test("names and aliases are unique, and every group is a known heading", () => {
    const names = BUILTIN_COMMANDS.flatMap((command) => [command.id, ...(command.aliases ?? [])])
    expect(new Set(names).size).toBe(names.length)
    for (const command of BUILTIN_COMMANDS) expect(COMMAND_GROUPS).toContain(command.group)
  })

  test("are listed group by group, so the menu draws each heading once", () => {
    const groups = BUILTIN_COMMANDS.map((command) => command.group)
    expect(groups.filter((group, index) => group !== groups[index - 1])).toEqual([...COMMAND_GROUPS])
  })

  test("an alias runs its command", () => {
    expect(builtinCommand("clear")?.id).toBe("new")
    const { context, calls } = recorder()
    expect(runBuiltin("clear", "", context)).toBe(true)
    expect(calls).toEqual(["newSession()"])
  })

  test("a session action with no session says so instead of reaching the engine", () => {
    for (const command of BUILTIN_COMMANDS.filter((entry) => entry.session)) {
      const { context, calls } = recorder()
      expect(runBuiltin(command.id, "", context)).toBe(true)
      expect(calls).toEqual(["notify(No session)"])
    }
  })

  test("what is typed after the name is used where it means something", () => {
    const stash = recorder({ draft: "draft" })
    runBuiltin("stash", "remember this", stash.context)
    expect(stash.calls).toEqual(["stash(remember this)"])

    const actions = recorder()
    runBuiltin("actions", "book a table", actions.context)
    expect(actions.calls).toEqual(["send(book a table)"])
  })

  test("a name that is not a built-in is left for the engine", () => {
    const { context, calls } = recorder({ session: "ses_1" })
    expect(runBuiltin("review", "", context)).toBe(false)
    expect(builtinCommand("review")).toBeUndefined()
    expect(calls).toEqual([])
  })
})
