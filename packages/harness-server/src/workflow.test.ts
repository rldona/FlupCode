import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TEMPLATES, fill, findWorkflow, listWorkflows, parseWorkflow, seedTemplates, tasksFor } from "./workflow"

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
    expect(seedTemplates(directory).sort()).toEqual(["bugfix", "feature", "refactor", "review"])

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
