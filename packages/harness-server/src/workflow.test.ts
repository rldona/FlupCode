import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TEMPLATES,
  duration,
  fill,
  findWorkflow,
  listWorkflows,
  parseWorkflow,
  readWorkflow,
  removeWorkflow,
  saveWorkflow,
  seedTemplates,
  tasksFor,
} from "./workflow"

const made: string[] = []
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-workflow-"))
  made.push(directory)
  return directory
}
const write = (directory: string, name: string, contents: string) => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), contents)
}

const dataHome = process.env.XDG_DATA_HOME
afterEach(() => {
  if (dataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = dataHome
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("reading a workflow", () => {
  test("the tasks keep the order the file wrote them", () => {
    const workflow = parseWorkflow(
      `name: feature
description: Do the thing
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    prompt: "Plan {{goal}}"
  - id: verify
    kind: verify
    onFail: { max: 2 }
`,
      "ignored",
    )
    expect(workflow?.name).toBe("feature")
    expect(workflow?.inputs).toEqual(["goal"])
    expect(workflow?.tasks).toEqual([
      { id: "plan", kind: "agent", prompt: "Plan {{goal}}", agent: "plan" },
      { id: "verify", kind: "verify", retries: 2 },
    ])
  })

  test("what is not a workflow is not read as one", () => {
    expect(parseWorkflow("tasks: [", "x")).toBeUndefined()
    // No tasks is not a process.
    expect(parseWorkflow("name: empty\ntasks: []\n", "x")).toBeUndefined()
    // An agent task with nothing to say is a mistake, not an empty prompt.
    expect(parseWorkflow("tasks:\n  - id: build\n", "x")).toBeUndefined()
    // A task with no id has no name to show or to depend on.
    expect(parseWorkflow("tasks:\n  - prompt: do it\n", "x")).toBeUndefined()
  })

  test("a file with no name is called after the file", () => {
    expect(parseWorkflow("tasks:\n  - id: go\n    prompt: do it\n", "nightly")?.name).toBe("nightly")
  })
})

describe("filling the inputs", () => {
  test("replaces what was answered", () => {
    expect(fill("Plan {{goal}} for {{ who }}", { goal: "search", who: "us" })).toBe("Plan search for us")
  })

  test("leaves a placeholder nobody answered as it was written", () => {
    // "Create a plan for: " asks a model to invent the goal; the placeholder says what is missing.
    expect(fill("Create a plan for: {{goal}}", {})).toBe("Create a plan for: {{goal}}")
  })
})

describe("what a workflow produces", () => {
  test("tasks a run can execute, with the inputs filled in", () => {
    const workflow = parseWorkflow(
      `name: feature
tasks:
  - id: plan
    agent: plan
    prompt: "Plan {{goal}}"
  - id: verify
    kind: verify
    onFail: { max: 2 }
`,
      "x",
    )!
    expect(tasksFor(workflow, { goal: "search" })).toEqual([
      { name: "plan", prompt: "Plan search", kind: "agent", agent: "plan" },
      { name: "verify", prompt: "", kind: "verify", retries: 2 },
    ])
  })
})

describe("the graph a workflow declares (H-28)", () => {
  test("`dependsOn` is read as written, by id", () => {
    const workflow = parseWorkflow(
      `name: fan
tasks:
  - id: read
    prompt: read it
  - id: left
    dependsOn: [read]
    prompt: left
  - id: right
    dependsOn: [read]
    prompt: right
  - id: join
    dependsOn: [left, right]
    prompt: join
`,
      "x",
    )!
    expect(workflow.tasks.map((task) => task.dependsOn)).toEqual([undefined, ["read"], ["read"], ["left", "right"]])
  })

  test("`parallel: true` is an explicit no-dependency, and a task that says nothing follows the one above", () => {
    const workflow = parseWorkflow(
      `name: fan
tasks:
  - id: a
    prompt: a
  - id: b
    parallel: true
    prompt: b
  - id: c
    prompt: c
`,
      "x",
    )!
    expect(tasksFor(workflow, {})).toEqual([
      { name: "a", prompt: "a", kind: "agent" },
      // A root: it does not wait for `a`.
      { name: "b", prompt: "b", kind: "agent", dependsOn: [] },
      // And `c` still follows `b`, because it said nothing.
      { name: "c", prompt: "c", kind: "agent" },
    ])
  })

  test("`when` names an outcome, and the task it names is a dependency anyway", () => {
    const workflow = parseWorkflow(
      `name: recover
tasks:
  - id: build
    prompt: build
  - id: check
    kind: verify
  - id: report
    when:
      task: check
      is: [failed, stopped]
    prompt: say what broke
`,
      "x",
    )!
    expect(workflow.tasks[2]!.when).toEqual({ task: "check", is: ["failed", "stopped"] })
  })

  test("a dependency that is not a task, and a cycle, are refused before a run waits forever", () => {
    expect(
      parseWorkflow("name: x\ntasks:\n  - id: a\n    dependsOn: [ghost]\n    prompt: a\n", "x"),
    ).toBeUndefined()
    expect(
      parseWorkflow(
        "name: x\ntasks:\n  - id: a\n    dependsOn: [b]\n    prompt: a\n  - id: b\n    dependsOn: [a]\n    prompt: b\n",
        "x",
      ),
    ).toBeUndefined()
  })

  test("two tasks cannot share an id, because a dependency would be ambiguous", () => {
    expect(parseWorkflow("name: x\ntasks:\n  - id: a\n    prompt: one\n  - id: a\n    prompt: two\n", "x")).toBeUndefined()
  })

  test("a `when` that names nothing is dropped, not guessed at", () => {
    const workflow = parseWorkflow(
      "name: x\ntasks:\n  - id: a\n    when: { is: failed }\n    prompt: a\n",
      "x",
    )!
    expect(workflow.tasks[0]!.when).toBeUndefined()
  })
})

describe("editing a workflow file (H-28)", () => {
  test("reads the file a project would run, source and all", async () => {
    const shared = scratch()
    const project = scratch()
    process.env.XDG_DATA_HOME = shared
    write(join(shared, "flupcode", "workflows"), "feature.yaml", "name: feature\ntasks:\n  - id: a\n    prompt: shared\n")
    write(join(project, ".flupcode", "workflows"), "feature.yaml", "name: feature\ntasks:\n  - id: a\n    prompt: mine\n")

    const found = await readWorkflow("feature", project)
    expect(found?.scope).toBe("project")
    expect(found?.source).toContain("mine")
    expect(found?.path).toContain(join(".flupcode", "workflows", "feature.yaml"))
    // A name nobody wrote down is not a workflow, and is not invented.
    expect(await readWorkflow("ghost", project)).toBeUndefined()
  })

  test("writes a workflow it can read back, and refuses one it cannot", async () => {
    const shared = scratch()
    process.env.XDG_DATA_HOME = shared
    const project = scratch()

    const refused = await saveWorkflow({ name: "broken", source: "tasks: [", scope: "project", directory: project })
    expect(refused).toHaveProperty("problem")

    const saved = await saveWorkflow({
      name: "feature",
      source: "name: feature\ntasks:\n  - id: plan\n    prompt: plan\n",
      scope: "project",
      directory: project,
    })
    expect(saved).toHaveProperty("saved")
    expect((await readWorkflow("feature", project))?.workflow.tasks[0]!.id).toBe("plan")

    // Editing keeps the filename, so a save is never a silent rename; and the id taken from the
    // body is the name the launcher addresses it by.
    const renamed = await saveWorkflow({
      name: "feature",
      source: "name: renamed\ntasks:\n  - id: plan\n    prompt: plan\n",
      scope: "project",
      directory: project,
    })
    expect(renamed).toHaveProperty("saved")
    expect(existsSync(join(project, ".flupcode", "workflows", "renamed.yaml"))).toBe(true)
  })

  test("a project's workflow needs a folder, and can be removed", async () => {
    const shared = scratch()
    process.env.XDG_DATA_HOME = shared
    const project = scratch()
    expect(await saveWorkflow({ name: "x", source: "name: x\ntasks:\n  - id: a\n    prompt: a\n", scope: "project" }))
      .toHaveProperty("problem")

    await saveWorkflow({
      name: "x",
      source: "name: x\ntasks:\n  - id: a\n    prompt: a\n",
      scope: "project",
      directory: project,
    })
    expect(await removeWorkflow("x", project)).toBe(true)
    expect(await readWorkflow("x", project)).toBeUndefined()
    expect(await removeWorkflow("x", project)).toBe(false)
  })
})

describe("where workflows come from", () => {
  test("a project's own wins over the one shared across projects", async () => {
    const shared = scratch()
    const project = scratch()
    process.env.XDG_DATA_HOME = shared
    write(join(shared, "flupcode", "workflows"), "feature.yaml", "name: feature\ntasks:\n  - id: a\n    prompt: shared\n")
    write(join(project, ".flupcode", "workflows"), "feature.yaml", "name: feature\ntasks:\n  - id: a\n    prompt: mine\n")

    const found = await findWorkflow("feature", project)
    expect(found?.tasks[0]!.prompt).toBe("mine")
    // And it is one workflow called feature, not two.
    expect((await listWorkflows(project)).filter((entry) => entry.name === "feature")).toHaveLength(1)
  })

  test("a directory that is not there is not an error", async () => {
    process.env.XDG_DATA_HOME = join(scratch(), "nothing-here")
    expect(await listWorkflows(join(scratch(), "also-nothing"))).toEqual([])
  })
})

describe("the templates", () => {
  test("are written once and never written over", async () => {
    const directory = join(scratch(), "workflows")
    expect(seedTemplates(directory).sort()).toEqual(["bugfix", "feature", "quality", "refactor", "review", "security"])

    writeFileSync(join(directory, "feature.yaml"), "name: feature\ntasks:\n  - id: mine\n    prompt: my own\n")
    // Seeding again must not undo an edit — that is the whole point of shipping them as files.
    expect(seedTemplates(directory)).toEqual([])
    expect(parseWorkflow(await Bun.file(join(directory, "feature.yaml")).text(), "x")?.tasks[0]!.id).toBe("mine")
  })

  test("every one of them is a workflow this server can read", () => {
    for (const [name, contents] of Object.entries(TEMPLATES)) {
      const workflow = parseWorkflow(contents, name)
      expect(workflow?.name).toBe(name)
      expect(workflow!.tasks.length).toBeGreaterThan(0)
    }
  })

  test("the ones that build something end by checking it", () => {
    for (const name of ["feature", "bugfix", "refactor"]) {
      const tasks = parseWorkflow(TEMPLATES[name]!, name)!.tasks
      expect(tasks.at(-1)!.kind).toBe("verify")
      expect(tasks.at(-1)!.retries).toBeGreaterThan(0)
    }
  })
})

test("every template's prompt survives being read back, instruction and all", () => {
  // The findings instruction is several lines. Interpolated without indenting it, the block scalar
  // ends at its second line and the template stops parsing — silently, which is worse.
  for (const [name, contents] of Object.entries(TEMPLATES)) {
    const workflow = parseWorkflow(contents, name)
    expect(workflow).toBeDefined()
    for (const task of workflow!.tasks) {
      if (task.kind === "verify") continue
      expect(task.prompt!.length).toBeGreaterThan(20)
      // Nothing of the YAML leaked into the prompt, which is what a broken block looks like.
      expect(task.prompt).not.toContain("prompt: |")
    }
  }
})

test("the review presets ask for findings that can be anchored", () => {
  for (const name of ["review", "security", "quality"]) {
    const prompt = parseWorkflow(TEMPLATES[name]!, name)!.tasks[0]!.prompt
    expect(prompt).toContain("fenced json block")
    expect(prompt).toContain('"file"')
    expect(prompt).toContain('"line"')
  }
})

describe("a ceiling written in the file (H-47)", () => {
  test("reads a duration the way a person writes one", () => {
    expect(duration("10m")).toBe(600_000)
    expect(duration("90s")).toBe(90_000)
    expect(duration("2h")).toBe(7_200_000)
    expect(duration("500ms")).toBe(500)
    // A bare number is minutes, which is the unit these are argued about in.
    expect(duration(10)).toBe(600_000)
  })

  test("refuses what it cannot make sense of rather than guessing", () => {
    // "ten minutes" read as ten milliseconds would stop every task the instant it started.
    for (const value of ["ten minutes", "", "-5m", "0", "m", undefined, null, {}]) {
      expect(duration(value)).toBeUndefined()
    }
  })

  test("a workflow carries its limit and its bypass", () => {
    const workflow = parseWorkflow(
      ["name: careful", "limits:", "  tool: 10m", "tasks:", "  - id: one", "    prompt: do it"].join("\n"),
      "file",
    )
    expect(workflow?.toolLimitMs).toBe(600_000)
    // Not declared is not opened: confinement is the default and leaving it is written down.
    expect(workflow?.outside).toBeUndefined()

    const open = parseWorkflow(
      ["name: wide", "outside: true", "tasks:", "  - id: one", "    prompt: do it"].join("\n"),
      "file",
    )
    expect(open?.outside).toBe(true)
  })

  test("a limit nobody can read leaves the workflow usable", () => {
    const workflow = parseWorkflow(
      ["name: typo", "limits:", "  tool: soon", "tasks:", "  - id: one", "    prompt: do it"].join("\n"),
      "file",
    )
    // The run still happens, with no ceiling, rather than the whole file being refused over it.
    expect(workflow?.tasks).toHaveLength(1)
    expect(workflow?.toolLimitMs).toBeUndefined()
  })
})
