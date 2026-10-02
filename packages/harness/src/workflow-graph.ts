import type { Task, Workflow } from "./types"

/**
 * The workflow as a graph (H-28), laid out in columns by depth.
 *
 * Depth is the longest chain of dependencies behind a task, so a task sits one column to the right of
 * the last thing it waits for and things that can run together share a column. That is the only claim
 * the picture makes, and it is the claim the runner makes.
 */
export type WorkflowGraphNode = {
  id: string
  kind: "agent" | "verify" | "external"
  /** How many dependencies deep it is; tasks at the same depth have nothing to wait for each other. */
  depth: number
  /** Its place within the column, in file order. */
  row: number
  dependsOn: string[]
  gate: boolean
}

export type WorkflowGraph = {
  nodes: WorkflowGraphNode[]
  edges: Array<{ from: string; to: string }>
  columns: number
  rows: number
}

type GraphTask = Workflow["tasks"][number]

/** The tasks a task waits for: what it says, or the one above it, or none when it is `parallel`. */
export function graphDependencies(tasks: GraphTask[], position: number): string[] {
  const task = tasks[position]!
  const explicit = task.foreach
    ? [task.foreach]
    : task.dependsOn ?? (task.parallel ? [] : position > 0 ? [tasks[position - 1]!.id] : [])
  const condition = task.when?.task
  return condition && !explicit.includes(condition) ? [...explicit, condition] : explicit
}

export function workflowGraph(tasks: GraphTask[]): WorkflowGraph {
  const index = new Map(tasks.map((task, position) => [task.id, position]))
  const depthCache = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const cached = depthCache.get(id)
    if (cached !== undefined) return cached
    const position = index.get(id)
    // A dependency that is not a task here cannot add a column, and a cycle (which the parser refuses
    // before this is ever called) must not recurse forever in an editor preview.
    if (position === undefined || visiting.has(id)) return 0
    visiting.add(id)
    const value = graphDependencies(tasks, position).reduce((max, dependency) => Math.max(max, depth(dependency) + 1), 0)
    visiting.delete(id)
    depthCache.set(id, value)
    return value
  }

  const rows = new Map<number, number>()
  const nodes = tasks.map((task, position) => {
    const column = depth(task.id)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return {
      id: task.id,
      kind: task.kind === "verify" ? ("verify" as const) : task.kind === "external" ? ("external" as const) : ("agent" as const),
      depth: column,
      row,
      dependsOn: graphDependencies(tasks, position),
      gate: task.gate === "human",
    }
  })
  const edges = nodes.flatMap((node) =>
    node.dependsOn.filter((dependency) => index.has(dependency)).map((dependency) => ({ from: dependency, to: node.id })),
  )
  return {
    nodes,
    edges,
    columns: nodes.reduce((max, node) => Math.max(max, node.depth), -1) + 1,
    rows: Math.max(1, ...rows.values()),
  }
}

/**
 * A run's tasks on its workflow's graph (UX-04): the same layout the editor draws, so the run reads
 * as the process it executed. One node per task name — a retry or a plan's steps share their name —
 * standing for the instance going now, or else the newest one, so the node follows the run's events.
 * Dependencies come from the first instance, which is what the runner reads them from.
 */
export function runGraph(tasks: Task[]) {
  const ordered = [...tasks].sort((left, right) => left.position - right.position)
  const names = [...new Set(ordered.map((task) => task.name))]
  const instances = (name: string) => ordered.filter((task) => task.name === name)
  const graph = workflowGraph(
    names.map((name) => {
      const task = instances(name)[0]!
      return { id: name, kind: task.kind, dependsOn: task.dependsOn, when: task.when, foreach: task.foreach, gate: task.gate }
    }),
  )
  return {
    ...graph,
    tasks: Object.fromEntries(
      names.map((name) => [name, instances(name).find((task) => task.status === "running") ?? instances(name).at(-1)!]),
    ),
  }
}
