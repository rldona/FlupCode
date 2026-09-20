import { For, Show, type Component } from "solid-js"
import type { ModelInfo, SessionInfo } from "../engine-types"
import type { TodoItem } from "./TodoDock"
import { formatTokens } from "../metrics"
import { t } from "../i18n"
import { cssPx } from "../text-size"

type RightAsideProps = {
  session: SessionInfo | undefined
  models: ModelInfo[]
  todos: TodoItem[]
  width: number
  onResize: (width: number) => void
  /** Dragging the edge almost to the window's right side hides the panel. */
  onHide: () => void
}

export const CONTEXT_PANEL_WIDTH = { min: 240, max: 560, default: 300 }

const mark = (status: string) => {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  return "○"
}

export const RightAside: Component<RightAsideProps> = (props) => {
  const model = () =>
    props.models.find(
      (entry) => entry.providerID === props.session?.model?.providerID && entry.id === props.session?.model?.id,
    )

  const tokens = () => {
    const value = props.session?.tokens
    if (!value) return 0
    return value.input + value.output + value.reasoning + value.cache.read + value.cache.write
  }

  const contextLimit = () => model()?.limit?.context
  const used = () => {
    const limit = contextLimit()
    if (!limit) return undefined
    return Math.min(100, Math.round((tokens() / limit) * 100))
  }

  const completed = () => props.todos.filter((todo) => todo.status === "completed").length

  return (
    <aside class="fc-rightaside" style={{ width: `${props.width}px` }}>
      <div
        class="fc-rightaside-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize context panel")}
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
            <span>{formatTokens(tokens())} tokens</span>
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
            <span>${(props.session?.cost ?? 0).toFixed(2)}</span>
          </div>
        </section>

        <section class="fc-aside-section">
          <h3 class="fc-aside-title">
            {t("Tasks")}
            <Show when={props.todos.length > 0}>
              <span class="fc-aside-count">
                {completed()}/{props.todos.length}
              </span>
            </Show>
          </h3>
          <Show when={props.todos.length > 0} fallback={<div class="fc-empty">{t("No tasks")}</div>}>
            <ul class="fc-aside-todos">
              <For each={props.todos}>
                {(todo) => (
                  <li class="fc-aside-todo" classList={{ "fc-aside-todo-done": todo.status === "completed" }}>
                    <span class="fc-aside-todo-mark">{mark(todo.status)}</span>
                    <span>{todo.content}</span>
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
