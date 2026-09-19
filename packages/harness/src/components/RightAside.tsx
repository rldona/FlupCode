import { For, Show, type Component } from "solid-js"
import type { TodoItem } from "./TodoDock"
import { MemoryInspector } from "./MemoryInspector"
import { SubagentList } from "./SubagentList"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"
import { cssPx } from "../text-size"

type RightAsideProps = {
  todos: TodoItem[]
  /** Hides completed tasks by their text. */
  onClearTodos: (contents: string[]) => void
  /** This session's child sessions, if it has spawned any. */
  subagents: SessionInfo[] | undefined
  /** Hides listed children by their session id. */
  onClearSubagents: (ids: string[]) => void
  onOpenSubagent: (id: string) => void
  /** Which of those the engine is working on, and which are waiting on a permission. */
  runningSubagents: string[]
  blockedSubagents: string[]
  width: number
  onResize: (width: number) => void
  /** Dragging the edge almost to the window's right side hides the panel. */
  onHide: () => void
  serverUrl: string
  sessionID?: string
}

export const CONTEXT_PANEL_WIDTH = { min: 240, max: 560, default: 340 }

const mark = (status: string) => {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  return ""
}

export const RightAside: Component<RightAsideProps> = (props) => {
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
                {/* A task the engine left in progress has no other way out of the panel. */}
                <button
                  class="fc-aside-clear"
                  type="button"
                  onClick={() => props.onClearTodos(props.todos.map((todo) => todo.content))}
                >
                  {t("Clear all")}
                </button>
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
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <SubagentList
          sessions={props.subagents}
          onOpen={props.onOpenSubagent}
          onClear={props.onClearSubagents}
          running={props.runningSubagents}
          blocked={props.blockedSubagents}
        />

        <MemoryInspector serverUrl={props.serverUrl} sessionID={props.sessionID} />
      </div>
    </aside>
  )
}
