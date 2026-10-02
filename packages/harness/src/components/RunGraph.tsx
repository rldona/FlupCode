import { For, Show, createMemo, type Component } from "solid-js"
import { t } from "../i18n"
import type { Task, TaskActivity } from "../types"
import { runGraph, type WorkflowGraphNode } from "../workflow-graph"
import { stateLabel, taskState } from "../run-state"

type RunGraphProps = {
  tasks: Task[]
  /** The card's title: a node that would repeat it is named by what does the work instead. */
  title: string
  /** What the running tasks are doing right now (H-12), by task id. */
  activity: Record<string, TaskActivity>
  /** The task whose detail is open. */
  selected?: string
  onSelect: (taskID: string) => void
}

const NODE_WIDTH = 156
const NODE_HEIGHT = 46
const COLUMN_GAP = 36
const ROW_GAP = 12

/**
 * How long a single tool call may run before it is worth saying so.
 *
 * Not a limit and not a kill: a test suite legitimately takes minutes, and stopping somebody's
 * build on a guess is worse than the problem. H-47 was eighteen minutes inside one `glob` that
 * looked exactly like work — this is the point at which it stops looking like work.
 */
const LONG_MS = 3 * 60_000

/** Minutes and seconds, or seconds alone: a run is read while it happens, not measured. */
export const elapsed = (from: number, to: number | undefined) => {
  const seconds = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * A run's tasks on its workflow's graph, each in its live state (UX-04).
 *
 * The editor's picture (H-28) with the run in it: a task sits one column to the right of what it
 * waits for, so what can run at once shares a column, and each node is coloured by where it stands —
 * queued, running, skipped, or how it ended — moving as the server's task events arrive. The state's
 * word is the node's name for assistive technology and its tooltip, not text on it: the card says
 * the run's state once, and four nodes saying "Not verified" would say it four more times.
 */
export const RunGraph: Component<RunGraphProps> = (props) => {
  const graph = createMemo(() => runGraph(props.tasks))
  const at = (node: WorkflowGraphNode) => ({
    x: node.depth * (NODE_WIDTH + COLUMN_GAP),
    y: node.row * (NODE_HEIGHT + ROW_GAP),
  })
  const width = () => Math.max(1, graph().columns) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP
  const height = () => graph().rows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP
  const byID = (id: string) => {
    const node = graph().nodes.find((entry) => entry.id === id)
    return node ? at(node) : undefined
  }

  return (
    <Show when={graph().nodes.length > 0}>
      <div class="fc-run-graph" aria-label={t("Workflow graph")}>
        {/* The graph runs left to right whatever the writing direction: it is a picture of order. */}
        <div class="fc-run-graph-canvas" dir="ltr" style={{ width: `${width()}px`, height: `${height()}px` }}>
          <svg class="fc-run-graph-edges" width={width()} height={height()} aria-hidden="true">
            <For each={graph().edges}>
              {(edge) => {
                const from = byID(edge.from)
                const to = byID(edge.to)
                if (!from || !to) return null
                const x1 = from.x + NODE_WIDTH
                const y1 = from.y + NODE_HEIGHT / 2
                const x2 = to.x
                const y2 = to.y + NODE_HEIGHT / 2
                const middle = (x1 + x2) / 2
                return (
                  <path
                    class="fc-workflow-edge"
                    d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
                    fill="none"
                  />
                )
              }}
            </For>
          </svg>
          <For each={graph().nodes}>
            {(node) => {
              const task = () => graph().tasks[node.id]!
              const state = () => taskState(task())
              const doing = () => props.activity[task().id]
              // A check or another vendor's CLI says so. Where a task's own name would repeat the card's
              // title (a routine's one task), it is named by what does it: its agent, or just "Task".
              const who = () =>
                task().kind === "verify" ? t("verify") : task().kind === "external" ? t("external") : undefined
              const name = () => (task().name !== props.title ? task().name : (who() ?? task().agent ?? t("Task")))
              // What the node adds under its name: who does it, the attempt from the second, and how
              // long — or, while it runs, what it is doing now and for how long.
              const fact = () =>
                [
                  name() === task().name ? who() : undefined,
                  (task().attempt ?? 1) > 1 ? t("attempt {n}", { n: task().attempt! }) : undefined,
                  doing()
                    ? `${doing()!.tool ?? t("working")} ${elapsed(Date.now() - doing()!.waitingMs, undefined)}`
                    : task().startedAt
                      ? elapsed(task().startedAt!, task().finishedAt)
                      : undefined,
                ]
                  .filter((value): value is string => !!value)
                  .join(" · ")
              const why = () => task().error ?? (state() === "failed" || state() === "needs-user" ? task().verdict?.reason : undefined)
              return (
                <button
                  type="button"
                  class="fc-run-node"
                  classList={{
                    "fc-run-node-selected": props.selected === task().id,
                    "fc-run-node-long": (doing()?.waitingMs ?? 0) >= LONG_MS,
                  }}
                  data-state={state()}
                  data-kind={node.kind}
                  style={{ left: `${at(node).x}px`, top: `${at(node).y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }}
                  aria-label={`${name()}: ${stateLabel(state())}`}
                  title={[stateLabel(state()), why(), doing()?.detail].filter(Boolean).join("\n")}
                  onClick={() => props.onSelect(task().id)}
                >
                  <bdi class="fc-run-node-name" dir="auto">
                    {name()}
                  </bdi>
                  <Show when={fact()}>
                    <span class="fc-run-node-fact">{fact()}</span>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
