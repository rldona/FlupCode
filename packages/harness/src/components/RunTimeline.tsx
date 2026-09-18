import { For, Show, createMemo, type Component } from "solid-js"
import { t } from "../i18n"
import type { Task } from "../types"

export type TimelineSlot = { task: Task; start: number; end: number }

/**
 * Places a run's tasks on lanes by overlap (H-28).
 *
 * Two tasks that were in flight at the same time land on two rows, so the eye reads the parallelism
 * without reading a single timestamp. A task that never started — queued, stopped, or skipped by the
 * graph — has no place on a time axis, so it is handed back separately instead of being drawn at the
 * origin as if it had run.
 */
export function timelineLanes(tasks: Task[]) {
  const placed = tasks
    .filter((task) => task.startedAt !== undefined)
    .map((task) => ({
      task,
      start: task.startedAt!,
      // A task still going ends "now"; the caller re-renders on the server's events.
      end: Math.max(task.finishedAt ?? Date.now(), task.startedAt!),
    }))
    .sort((left, right) => left.start - right.start || left.task.position - right.task.position)
  const lanes: TimelineSlot[][] = []
  for (const slot of placed) {
    const lane = lanes.find((row) => (row.at(-1)?.end ?? Number.NEGATIVE_INFINITY) <= slot.start)
    if (lane) lane.push(slot)
    else lanes.push([slot])
  }
  return { lanes, pending: tasks.filter((task) => task.startedAt === undefined) }
}

const seconds = (ms: number) => {
  const value = Math.max(0, Math.round(ms / 1000))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  return minutes < 60 ? `${minutes}m ${value % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The run on a time axis (H-28): one row per set of tasks that overlapped, so "these two ran at once"
 * is a picture rather than an inference from two timestamps.
 */
export const RunTimeline: Component<{ tasks: Task[] }> = (props) => {
  const timeline = createMemo(() => timelineLanes(props.tasks))
  const bounds = createMemo(() => {
    const slots = timeline().lanes.flat()
    if (slots.length === 0) return { start: 0, span: 1 }
    const start = Math.min(...slots.map((slot) => slot.start))
    const end = Math.max(...slots.map((slot) => slot.end))
    // A floor on the span keeps two tasks started in the same millisecond from becoming a divide by
    // zero, and keeps a very short run from drawing full-width bars that look like long work.
    return { start, span: Math.max(1_000, end - start) }
  })
  const offset = (value: number) => `${((value - bounds().start) / bounds().span) * 100}%`
  const width = (slot: TimelineSlot) =>
    `${Math.max(2, ((slot.end - slot.start) / bounds().span) * 100)}%`

  return (
    <Show when={timeline().lanes.length > 0 || timeline().pending.length > 0}>
      <div class="fc-run-timeline" aria-label={t("Run timeline")}>
        <For each={timeline().lanes}>
          {(lane) => (
            <div class="fc-run-lane">
              <For each={lane}>
                {(slot) => (
                  <span
                    class="fc-run-bar"
                    data-status={slot.task.status}
                    // Logical on purpose: the axis follows the writing direction, so in RTL time
                    // reads right to left like the rest of the page.
                    style={{ "inset-inline-start": offset(slot.start), width: width(slot) }}
                    title={`${slot.task.name} — ${seconds(slot.end - slot.start)}`}
                  >
                    <bdi class="fc-run-bar-name" dir="auto">
                      {slot.task.name}
                    </bdi>
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
        <Show when={timeline().pending.length > 0}>
          <div class="fc-run-pending">
            <For each={timeline().pending}>
              {(task) => (
                <span class="fc-run-bar-pending" data-status={task.status} title={task.error}>
                  {task.name}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
