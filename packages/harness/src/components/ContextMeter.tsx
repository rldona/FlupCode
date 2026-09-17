import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { compactionNear } from "../metrics"
import { t } from "../i18n"

type ContextMeterProps = {
  used: number
  limit: number
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
  /** The figure sizes the text the engine will send next, not a finished step: after a compaction,
   *  until the next step reports tokens. */
  estimated?: boolean
  /** What the engine counts and where it folds the session, so the meter can warn before it does. */
  compaction?: { at: number; count: number }
}

export const ContextMeter: Component<ContextMeterProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const percent = () => (props.limit > 0 ? Math.min(100, (props.used / props.limit) * 100) : 0)
  const circumference = 2 * Math.PI * 9
  const format = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
    return String(Math.round(value))
  }
  const due = () => !!props.compaction && props.compaction.count >= props.compaction.at
  const left = () => Math.max(0, (props.compaction?.at ?? 0) - (props.compaction?.count ?? 0))
  const warning = () => (due() ? t("The engine folds this session on the next step") : t("Compaction is close"))

  return (
    <div class="fc-context" classList={{ "fc-context-near": compactionNear(props.compaction) }} ref={root}>
      <button
        class="fc-context-button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={compactionNear(props.compaction) ? warning() : t("Context")}
      >
        <svg class="fc-context-ring" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--fc-border)" stroke-width="3" />
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="var(--fc-accent)"
            stroke-width="3"
            stroke-linecap="round"
            stroke-dasharray={`${(percent() / 100) * circumference} ${circumference}`}
            transform="rotate(-90 12 12)"
          />
        </svg>
      </button>
      <Show when={open()}>
        <div class="fc-context-popover">
          <div class="fc-context-row">
            <span>{t("Context window")}</span>
            <span class="fc-context-strong" title={props.estimated ? t("Estimated") : undefined}>
              {props.estimated ? "~" : ""}
              {format(props.used)} / {format(props.limit)} ({Math.round(percent())}%)
            </span>
          </div>
          <div class="fc-context-bar">
            <span style={{ width: `${percent()}%` }} />
          </div>
          <Show when={props.tokens}>
            <div class="fc-context-row">
              <span>{t("Input")}</span>
              <span class="fc-context-muted">{format(props.tokens!.input)}</span>
            </div>
            <div class="fc-context-row">
              <span>{t("Output")}</span>
              <span class="fc-context-muted">{format(props.tokens!.output)}</span>
            </div>
            <div class="fc-context-row">
              <span>{t("Reasoning")}</span>
              <span class="fc-context-muted">{format(props.tokens!.reasoning)}</span>
            </div>
          </Show>
          {/* Where the window really ends: the engine stops sending a session once this much of it is
              full, which is a good deal before the model's own window is. */}
          <Show when={props.compaction}>
            <div class="fc-context-row fc-context-compaction">
              <span>{due() ? t("Compaction") : t("Compaction at")}</span>
              <span class="fc-context-muted">
                {due() ? t("next step") : `${format(props.compaction!.at)} · ${format(left())} ${t("left")}`}
              </span>
            </div>
          </Show>
          <Show when={props.cost !== undefined && props.cost > 0}>
            <div class="fc-context-row">
              <span>{t("Spent")}</span>
              <span class="fc-context-muted">${props.cost!.toFixed(4)}</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
