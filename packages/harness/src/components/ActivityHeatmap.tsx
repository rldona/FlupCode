import { For, Show, type Component } from "solid-js"
import type { ActivityDay } from "../metrics"

type ActivityHeatmapProps = {
  days: ActivityDay[]
  comparison: string
}

export const ActivityHeatmap: Component<ActivityHeatmapProps> = (props) => {
  const max = () => Math.max(1, ...props.days.map((day) => day.count))

  const cells = () => {
    const list = props.days
    const first = list[0]
    if (!first) return []
    const lead = (first.day + 4) % 7
    return [...Array.from<null>({ length: lead }).fill(null), ...list]
  }

  const level = (count: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / max()) * 4)))

  return (
    <div class="oh-heatmap">
      <div class="oh-heatmap-grid">
        <For each={cells()}>
          {(cell) => (
            <span
              class="oh-heat-cell"
              data-level={cell ? level(cell.count) : 0}
              title={cell ? `${cell.count} sesiones` : ""}
            />
          )}
        </For>
      </div>
      <Show when={props.comparison}>
        <div class="oh-heatmap-comparison">{props.comparison}</div>
      </Show>
    </div>
  )
}
