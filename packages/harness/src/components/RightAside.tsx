import { For, Show, type Component } from "solid-js"
import type { TodoItem } from "./TodoDock"
import { MemoryInspector } from "./MemoryInspector"
import { formatTokens } from "../metrics"
import { t } from "../i18n"
import { cssPx } from "../text-size"

type RightAsideProps = {
  /** The composer's context meter figures: tokens in the window, its size, and what the session spent. */
  usage: { used: number; limit: number; cost: number }
  todos: TodoItem[]
  /** Hides completed tasks by their text. */
  onClearTodos: (contents: string[]) => void
  width: number
  onResize: (width: number) => void
  /** Dragging the edge almost to the window's right side hides the panel. */
  onHide: () => void
  serverUrl: string
  sessionID?: string
}

export const CONTEXT_PANEL_WIDTH = { min: 240, max: 560, default: 300 }

const mark = (status: string) => {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  return ""
}

export const RightAside: Component<RightAsideProps> = (props) => {
  const used = () =>
    props.usage.limit > 0 ? Math.min(100, Math.round((props.usage.used / props.usage.limit) * 100)) : undefined

  const completed = () => props.todos.filter((todo) => todo.status === "completed").length

  return (
    <aside class="fc-rightaside" style={{ width: `${props.width}px` }}>
      <div
        class="fc-rightaside-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize context panel")}
        title={t("Drag to resize, double-click to reset")}
        onDblClick={() => props.onResize(CONTEXT_PANEL_WIDTH.default)}
        onPointerDown={(event) => {
          const target = event.currentTarget
          const right = target.parentElement!.getBoundingClientRect().right
          const startWidth = props.width
          target.setPointerCapture(event.pointerId)
          const move = (moveEvent: PointerEvent) => {
            const width = cssPx(right - moveEvent.clientX)
            if (width < CONTEXT_PANEL_WIDTH.min - 80) {
              stop()
              // Reopening restores the width from before this drag.
              props.onResize(startWidth)
              props.onHide()
              return
            }
            props.onResize(width)
          }
          const stop = () => {
            if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
            target.removeEventListener("pointermove", move)
            target.removeEventListener("pointerup", stop)
          }
          target.addEventListener("pointermove", move)
          target.addEventListener("pointerup", stop)
        }}
      />
      <div class="fc-rightaside-body">
        <section class="fc-aside-section">
          <h3 class="fc-aside-title">{t("Context")}</h3>
          <div class="fc-aside-row">
            <span>{formatTokens(props.usage.used)} tokens</span>
          </div>
          <Show when={used() !== undefined}>
            <div class="fc-aside-row">
              <span>{t("% used")}</span>
              <span>{used()}%</span>
            </div>
            <div class="fc-meter">
              <div class="fc-meter-fill" style={{ width: `${used()}%` }} />
            </div>
          </Show>
          <div class="fc-aside-row">
            <span>{t("Spent")}</span>
            <span>${props.usage.cost.toFixed(2)}</span>
          </div>
        </section>

        <MemoryInspector serverUrl={props.serverUrl} sessionID={props.sessionID} />

        <section class="fc-aside-section">
          <h3 class="fc-aside-title">
            {t("Tasks")}
            <Show when={props.todos.length > 0}>
              <span class="fc-aside-title-actions">
                <Show when={completed() > 0}>
                  <button
                    class="fc-aside-clear"
                    type="button"
                    onClick={() =>
                      props.onClearTodos(
                        props.todos.filter((todo) => todo.status === "completed").map((todo) => todo.content),
                      )
                    }
                  >
                    {t("Clear completed")}
                  </button>
                </Show>
                <span class="fc-aside-count">
                  {completed()}/{props.todos.length}
                </span>
              </span>
            </Show>
          </h3>
          <Show when={props.todos.length > 0} fallback={<div class="fc-empty">{t("No tasks")}</div>}>
            <ul class="fc-aside-todos">
              <For each={props.todos}>
                {(todo) => (
                  <li
                    class="fc-aside-todo"
                    classList={{ "fc-aside-todo-done": todo.status === "completed" }}
                    data-status={todo.status}
                  >
                    <span class="fc-aside-todo-mark" aria-hidden="true">
                      {mark(todo.status)}
                    </span>
                    <span class="fc-aside-todo-text">{todo.content}</span>
                    <Show when={todo.status === "completed"}>
                      <button
                        class="fc-aside-todo-remove"
                        type="button"
                        title={t("Remove task")}
                        aria-label={`${t("Remove task")}: ${todo.content}`}
                        onClick={() => props.onClearTodos([todo.content])}
                      >
                        ×
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </aside>
  )
}
