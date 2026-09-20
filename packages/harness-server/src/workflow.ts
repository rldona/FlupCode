import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TaskCondition, TaskInput } from "./types"
import { FINDINGS_INSTRUCTION } from "./findings"
import { PLAN_INSTRUCTION } from "./plan"

/**
 * The findings instruction, indented to sit inside a `prompt: |` block.
 *
 * Interpolated raw, only its first line gets the block's indentation and every line after it lands
 * at column zero — which ends the block scalar and leaves a template that does not parse. The
 * templates are checked by a test for exactly that, and it is how this was found.
 */
const indented = (text: string, spaces = 6) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || !line ? line : " ".repeat(spaces) + line))
    .join("\n")

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
  /** What a model is asked. A verify or external task has none for the model (H-38). */
  prompt?: string
  kind?: "agent" | "verify" | "external"
  agent?: string
  /** The command an `external` task runs (H-38), with `{{prompt}}` for its prompt. */
  command?: string
  /** On a verify task: how many times the work before it may be attempted again (H-22). */
  retries?: number
  /** `human` holds the run here until somebody reads what it did and lets it through. */
  gate?: "human"
  /** The tasks this one waits for, by id (H-28). Empty means none; absent means the one before it. */
  dependsOn?: string[]
  /** `parallel: true` is `dependsOn: []`: start with the roots instead of after the task above. */
  parallel?: boolean
  /** Run only if an earlier task ended a certain way; otherwise it is skipped (H-28). */
  when?: TaskCondition
  /** The task whose plan is split into one task per step (H-28). */
  foreach?: string
}

export type Workflow = {
  name: string
  description: string
  /** The names a launcher asks for and the prompts interpolate, e.g. `goal`. */
  inputs: string[]
  tasks: WorkflowTask[]
  /** `limits: { tool: 10m }` — how long one tool call may run before the task is stopped (H-47). */
  toolLimitMs?: number
  /** `outside: true` — let this workflow's tasks reach outside the project. Stated, never default. */
  outside?: boolean
  /** `shell: false` — refuse the shell for this workflow's tasks (H-47). Stated, never default. */
  shell?: boolean
}

/**
 * `10m`, `90s`, `2h`, or a number of minutes.
 *
 * Written by a person in a file, so it reads like a duration rather than like milliseconds. A value
 * nobody can make sense of is dropped rather than guessed at: a limit that was meant to be ten
 * minutes and is read as ten milliseconds would stop every task instantly.
 */
export function duration(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value * 60_000 : undefined
  if (typeof value !== "string") return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  if (!(amount > 0)) return undefined
  const unit = match[2] ?? "m"
  return amount * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "m" | "h"]
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
  if (graphProblem(tasks)) return undefined
  const limits = value.limits && typeof value.limits === "object" ? (value.limits as Record<string, unknown>) : undefined
  const toolLimitMs = duration(limits?.tool)
  return {
    ...(toolLimitMs ? { toolLimitMs } : {}),
    ...(value.outside === true ? { outside: true as const } : {}),
    ...(value.shell === false ? { shell: false as const } : {}),
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
  const kind = task.kind === "verify" ? "verify" : task.kind === "external" ? "external" : "agent"
  const prompt = typeof task.prompt === "string" ? task.prompt : ""
  const command = typeof task.command === "string" ? task.command.trim() : ""
  // A model task without a prompt has nothing to ask; an external one without a command has nothing
  // to run. Both are refused here rather than becoming a task that fails on the runner.
  if (kind === "agent" && !prompt.trim()) return undefined
  if (kind === "external" && !command) return undefined
  const onFail = task.onFail && typeof task.onFail === "object" ? (task.onFail as Record<string, unknown>) : undefined
  const max = typeof onFail?.max === "number" ? onFail.max : undefined
  const dependsOn = Array.isArray(task.dependsOn)
    ? task.dependsOn.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim())
    : undefined
  return {
    id,
    kind,
    ...(prompt.trim() ? { prompt } : {}),
    ...(kind === "external" && command ? { command } : {}),
    ...(typeof task.agent === "string" && task.agent ? { agent: task.agent } : {}),
    ...(kind === "verify" && max !== undefined ? { retries: max } : {}),
    ...(task.gate === "human" ? { gate: "human" as const } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(task.parallel === true ? { parallel: true as const } : {}),
    ...(conditionFrom(task.when) ? { when: conditionFrom(task.when) } : {}),
    ...(typeof task.foreach === "string" && task.foreach.trim() ? { foreach: task.foreach.trim() } : {}),
  }
}

/** `when: { task: verify, is: failed }` or a list of outcomes, so recovery is written, not coded. */
const conditionFrom = (value: unknown): TaskCondition | undefined => {
  if (!value || typeof value !== "object") return undefined
  const condition = value as { task?: unknown; is?: unknown }
  if (typeof condition.task !== "string" || !condition.task.trim()) return undefined
  const is = (Array.isArray(condition.is) ? condition.is : [condition.is]).filter(
    (entry): entry is TaskCondition["is"][number] =>
      entry === "success" || entry === "failed" || entry === "stopped" || entry === "skipped",
  )
  return is.length > 0 ? { task: condition.task.trim(), is } : undefined
}

/**
 * The tasks a workflow declares, with the graph checked before a run is allowed to start.
 *
 * The order still means "after the one above" unless a task says otherwise, which is what keeps a v1
 * file working unchanged. `parallel: true` opts out of that, `dependsOn` says it exactly, and a
 * `when` names a task it cannot run before — so it is a dependency too, whether or not it was listed.
 * A cycle is refused here rather than discovered by a run that waits forever.
 */
const dependencies = (tasks: WorkflowTask[], task: WorkflowTask, index: number): string[] => {
  const explicit = task.foreach
    ? [task.foreach]
    : task.dependsOn ?? (task.parallel ? [] : index > 0 ? [tasks[index - 1]!.id] : [])
  const condition = task.when?.task
  return condition && !explicit.includes(condition) ? [...explicit, condition] : explicit
}

function graphProblem(tasks: WorkflowTask[]): string | undefined {
  const byID = new Map(tasks.map((task) => [task.id, task]))
  if (byID.size !== tasks.length) return "two tasks share an id"
  for (const [index, task] of tasks.entries()) {
    for (const dependency of dependencies(tasks, task, index)) {
      if (!byID.has(dependency)) return `${task.id} depends on ${dependency}, which is not a task here`
    }
  }
  const state = new Map<string, "visiting" | "done">()
  const visit = (id: string): string | undefined => {
    if (state.get(id) === "done") return undefined
    if (state.get(id) === "visiting") return `the tasks form a cycle at ${id}`
    state.set(id, "visiting")
    const index = tasks.findIndex((task) => task.id === id)
    for (const dependency of dependencies(tasks, byID.get(id)!, index)) {
      const problem = visit(dependency)
      if (problem) return problem
    }
    state.set(id, "done")
    return undefined
  }
  for (const task of tasks) {
    const problem = visit(task.id)
    if (problem) return problem
  }
  return undefined
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
    // An external command is filled like a prompt: `{{goal}}` is the same idea wherever it appears.
    ...(task.command ? { command: fill(task.command, inputs) } : {}),
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.retries !== undefined ? { retries: task.retries } : {}),
    ...(task.gate ? { gate: task.gate } : {}),
    // `parallel: true` is written down as an empty list so the runner can tell it from "no opinion",
    // which still means "after the task above".
    ...(task.dependsOn ? { dependsOn: task.dependsOn } : task.parallel ? { dependsOn: [] } : {}),
    ...(task.when ? { when: task.when } : {}),
    ...(task.foreach ? { foreach: task.foreach } : {}),
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
 * Where a workflow lives and what it says (H-28), for the editor.
 *
 * The list is by name, but a file is by path, and editing needs both. A project's file wins, exactly
 * as it does when running one, so opening `feature` edits the one that would run in this folder.
 */
export type WorkflowFile = {
  name: string
  scope: "project" | "global"
  path: string
  /** The file as written, so a person edits the YAML rather than the parsed shape. */
  source: string
  workflow: Workflow
}

const workflowExtensions = [".yaml", ".yml"]

const findByName = async (directory: string, name: string) => {
  if (!existsSync(directory)) return undefined
  for (const entry of readdirSync(directory)) {
    if (!workflowExtensions.some((extension) => entry.endsWith(extension))) continue
    const path = join(directory, entry)
    const source = await Bun.file(path)
      .text()
      .catch(() => undefined)
    if (source === undefined) continue
    const workflow = parseWorkflow(source, entry.replace(/\.ya?ml$/, ""))
    if (workflow?.name === name) return { path, source, workflow }
  }
  return undefined
}

export async function readWorkflow(name: string, directory?: string) {
  const places: Array<{ scope: "project" | "global"; directory: string }> = []
  if (directory) places.push({ scope: "project", directory: projectWorkflowsDirectory(directory) })
  places.push({ scope: "global", directory: userWorkflowsDirectory() })
  for (const place of places) {
    const found = await findByName(place.directory, name)
    if (found) return { name, scope: place.scope, ...found }
  }
  return undefined
}

/** A filename a workflow name can become: lowercase, dashes, no separators. */
const fileSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow"

/**
 * Writes a workflow file (H-28).
 *
 * What is written is validated by reading it back, so a file that would not run cannot be saved as
 * one. An existing workflow keeps its filename — an edit is not a rename — and only what is missing
 * is created.
 */
export async function saveWorkflow(input: {
  name: string
  source: string
  directory?: string
  scope?: "project" | "global"
}): Promise<{ saved: WorkflowFile } | { problem: string }> {
  const workflow = parseWorkflow(input.source, input.name)
  if (!workflow) return { problem: "That is not a workflow this server can read" }
  const scope = input.scope ?? (input.directory ? "project" : "global")
  if (scope === "project" && !input.directory) return { problem: "A project's workflow needs a folder" }
  const directory =
    scope === "project" ? projectWorkflowsDirectory(input.directory!) : userWorkflowsDirectory()
  mkdirSync(directory, { recursive: true })
  const existing = await findByName(directory, workflow.name)
  const path = existing?.path ?? join(directory, `${fileSlug(workflow.name)}.yaml`)
  await Bun.write(path, input.source)
  return { saved: { name: workflow.name, scope, path, source: input.source, workflow } }
}

/** Forgets a workflow file. A project's is tried first, the same order reads use. */
export async function removeWorkflow(name: string, directory?: string) {
  const found = await readWorkflow(name, directory)
  if (!found) return false
  rmSync(found.path, { force: true })
  return true
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
    gate: human
    prompt: |
      Create an implementation plan for: {{goal}}

      Say what you will change and why. Do not write the code yet.

      ${indented(PLAN_INSTRUCTION)}
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

      ${indented(PLAN_INSTRUCTION)}
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

      ${indented(FINDINGS_INSTRUCTION)}
`,
  security: `name: security
description: Review the current changes for security problems only
inputs: [scope]
tasks:
  - id: review
    agent: plan
    prompt: |
      Review the current changes{{scope}} for security problems only.

      Look for: input that reaches a shell or a query unescaped, a path that can
      escape its folder, a secret written to disk or to a log, a permission check
      that can be skipped, and data sent somewhere it was not meant to go.

      Report what an attacker could actually do, not what looks unusual. Say
      plainly if you find nothing.

      ${indented(FINDINGS_INSTRUCTION)}
`,
  quality: `name: quality
description: Review the current changes for correctness and clarity
inputs: [scope]
tasks:
  - id: review
    agent: plan
    prompt: |
      Review the current changes{{scope}} for correctness and clarity.

      Look for: a case the code gets wrong, an error swallowed, a name that
      misleads, a comment that is no longer true, and a test that would pass
      whether or not the code worked.

      Give the input or the state that makes it go wrong. Say plainly if you
      find nothing.

      ${indented(FINDINGS_INSTRUCTION)}
`,
}
