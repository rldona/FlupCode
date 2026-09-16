import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TaskInput } from "./types"

/**
 * Workflows (H-21): a process written down, instead of remembered and retyped.
 *
 * A workflow is a file, not code. The audit is explicit that the templates ship "como ficheros
 * editables, no como código" — a process you cannot open and change is a process the harness owns
 * rather than the team.
 *
 * What it produces is a run of tasks, which is all the rest of the server already understands: the
 * supervisor, the stream, verification and the bounded retry work on it without knowing a workflow
 * was involved.
 */

export type WorkflowTask = {
  id: string
  /** What a model is asked. A verify task has none: it runs the project's own commands (H-22). */
  prompt?: string
  kind?: "agent" | "verify"
  agent?: string
  /** On a verify task: how many times the work before it may be attempted again (H-22). */
  retries?: number
}

export type Workflow = {
  name: string
  description: string
  /** The names a launcher asks for and the prompts interpolate, e.g. `goal`. */
  inputs: string[]
  tasks: WorkflowTask[]
}

/** What v1 runs. `dependsOn`, `parallel`, `foreach` and `when` are H-28; order is the dependency. */
export function parseWorkflow(text: string, fallbackName: string): Workflow | undefined {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const value = parsed as Record<string, unknown>
  const tasks = Array.isArray(value.tasks) ? value.tasks.map(taskFrom).filter((task) => !!task) : []
  if (tasks.length === 0) return undefined
  return {
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallbackName,
    description: typeof value.description === "string" ? value.description.trim() : "",
    inputs: Array.isArray(value.inputs) ? value.inputs.filter((input): input is string => typeof input === "string") : [],
    tasks,
  }
}

const taskFrom = (value: unknown): WorkflowTask | undefined => {
  if (!value || typeof value !== "object") return undefined
  const task = value as Record<string, unknown>
  const id = typeof task.id === "string" ? task.id.trim() : ""
  if (!id) return undefined
  const kind = task.kind === "verify" ? "verify" : "agent"
  const prompt = typeof task.prompt === "string" ? task.prompt : ""
  if (kind === "agent" && !prompt.trim()) return undefined
  const onFail = task.onFail && typeof task.onFail === "object" ? (task.onFail as Record<string, unknown>) : undefined
  const max = typeof onFail?.max === "number" ? onFail.max : undefined
  return {
    id,
    kind,
    ...(prompt.trim() ? { prompt } : {}),
    ...(typeof task.agent === "string" && task.agent ? { agent: task.agent } : {}),
    ...(kind === "verify" && max !== undefined ? { retries: max } : {}),
  }
}

/**
 * Fills `{{name}}` from the inputs.
 *
 * A placeholder nobody answered is left as it was written rather than replaced with nothing: a
 * prompt that reads "Create a plan for: {{goal}}" says what is missing, and one that reads "Create a
 * plan for: " asks a model to invent the goal.
 */
export function fill(text: string, inputs: Record<string, string>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => inputs[name] ?? whole)
}

/** The tasks a run is made of, in the order the file wrote them. */
export function tasksFor(workflow: Workflow, inputs: Record<string, string>): TaskInput[] {
  return workflow.tasks.map((task) => ({
    name: task.id,
    prompt: task.prompt ? fill(task.prompt, inputs) : "",
    kind: task.kind ?? "agent",
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.retries !== undefined ? { retries: task.retries } : {}),
  }))
}

/** Where a person's own workflows live, next to the database the server already keeps there. */
export function userWorkflowsDirectory() {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "workflows")
}

/** A project's own, which win over the ones shared across projects. */
export function projectWorkflowsDirectory(directory: string) {
  return join(directory, ".flupcode", "workflows")
}

const readDirectory = async (directory: string) => {
  if (!existsSync(directory)) return new Map<string, Workflow>()
  const found = new Map<string, Workflow>()
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue
    const fallback = entry.replace(/\.ya?ml$/, "")
    const text = await Bun.file(join(directory, entry))
      .text()
      .catch(() => undefined)
    const workflow = text === undefined ? undefined : parseWorkflow(text, fallback)
    if (workflow) found.set(workflow.name, workflow)
  }
  return found
}

/**
 * Every workflow available to a run, by name.
 *
 * A project's own override the shared ones: a repository that keeps a `feature` of its own means
 * that one, and the way to change a process for one project is to write it down in that project.
 */
export async function listWorkflows(directory?: string) {
  const workflows = await readDirectory(userWorkflowsDirectory())
  if (directory) for (const [name, workflow] of await readDirectory(projectWorkflowsDirectory(directory))) {
    workflows.set(name, workflow)
  }
  return [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function findWorkflow(name: string, directory?: string) {
  return (await listWorkflows(directory)).find((workflow) => workflow.name === name)
}

/**
 * The templates the audit names, written to disk once so they can be read and changed.
 *
 * Only what is missing is written, and nothing is ever overwritten: an edited `feature` is the
 * point of shipping them as files, and a server that restored its own version on every start would
 * quietly undo it.
 */
export function seedTemplates(directory = userWorkflowsDirectory()) {
  mkdirSync(directory, { recursive: true })
  const written: string[] = []
  for (const [name, contents] of Object.entries(TEMPLATES)) {
    const path = join(directory, `${name}.yaml`)
    if (existsSync(path)) continue
    Bun.write(path, contents)
    written.push(name)
  }
  return written
}

export const TEMPLATES: Record<string, string> = {
  feature: `name: feature
description: Plan a feature, build it, and check it still works
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    prompt: |
      Create an implementation plan for: {{goal}}

      Say what you will change and why. Do not write the code yet.
  - id: implement
    agent: build
    prompt: |
      Implement the plan above for: {{goal}}
  - id: verify
    kind: verify
    onFail: { max: 2 }
`,
  bugfix: `name: bugfix
description: Investigate a bug, reproduce it, fix it, and prove it is fixed
inputs: [report]
tasks:
  - id: investigate
    agent: plan
    prompt: |
      Investigate this report and say what causes it: {{report}}

      Name the file and the line. Do not fix it yet.
  - id: reproduce
    agent: build
    prompt: |
      Write a failing test that reproduces the cause found above.

      It must fail for the reason given, not for a different one.
  - id: fix
    agent: build
    prompt: |
      Make that test pass without changing what it asserts.
  - id: verify
    kind: verify
    onFail: { max: 2 }
`,
  refactor: `name: refactor
description: Change the shape of the code without changing what it does
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    prompt: |
      Plan this refactor: {{goal}}

      Say what moves, what stays, and what could break.
  - id: refactor
    agent: build
    prompt: |
      Carry out the plan above. Behaviour must not change.
  - id: verify
    kind: verify
    onFail: { max: 1 }
`,
  review: `name: review
description: Read the current changes and say what is wrong with them
inputs: [scope]
tasks:
  - id: review
    agent: plan
    prompt: |
      Review the current changes{{scope}}.

      For each finding give the file, the line, what is wrong and how it fails.
      Say plainly if you find nothing.
`,
}
