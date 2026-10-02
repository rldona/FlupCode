import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { compactionNear } from "../metrics"
import { t } from "../i18n"
import { CostFigure } from "./CostFigure"
import type { UsageSessionReport } from "../types"

/** What the session spent, from the usage ledger (UL-06), and whether the last read of it failed. */
export type SessionSpend = { report?: UsageSessionReport; failure?: Error; refresh?: () => void }

type ContextMeterProps = {
  used: number
  limit: number
  /** Absent where the harness cannot be asked (no server): the meter then says nothing about cost. */
  spend?: SessionSpend
  tokens?: { input: number; output: number; reasoning: number }
  /** The figure sizes the text the engine will send next, not a finished step: after a compaction,
   *  until the next step reports tokens. */
  estimated?: boolean
  /** What the engine counts and where it folds the session, so the meter can warn before it does. */
  compaction?: { at: number; count: number }
}

/** Why a figure is a dash: the read failed, or the ledger has nothing for it yet. */
const reason = (spend: SessionSpend) =>
  spend.failure && !spend.report ? t("The cost could not be read") : t("Nothing recorded")

/** Green, yellow and red in three equal thirds — solid blocks, no blend between them. */
const meterColor = (percent: number) => {
  const p = Math.max(0, Math.min(100, percent))
  if (p < 100 / 3) return "hsl(120 75% 50%)"
  if (p < 200 / 3) return "hsl(45 75% 50%)"
  return "hsl(0 75% 50%)"
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
        onClick={() => {
          // Opened, the figures are read again: the last step's row may have landed since.
          if (!open()) props.spend?.refresh?.()
          setOpen((value) => !value)
        }}
        title={compactionNear(props.compaction) ? warning() : t("Context")}
      >
        <svg class="fc-context-ring" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--fc-border)" stroke-width="3" />
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke={meterColor(percent())}
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
            <span style={{ width: `${percent()}%`, background: meterColor(percent()) }} />
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
          {/* What it cost (UL-06), from the ledger like every other cost: the turn in progress, then
              the session with its subagents and by agent. A dash where the ledger has nothing. */}
          <Show when={props.spend}>
            {(spend) => (
              <div class="fc-context-spend">
                <div class="fc-context-row">
                  <span>{t("This turn")}</span>
                  <CostFigure bucket={spend().report?.since} unknownReason={reason(spend())} />
                </div>
                <div class="fc-context-row">
                  <span>
                    {(spend().report?.sessions.length ?? 0) > 1
                      ? t("Session and {n} subagents", { n: spend().report!.sessions.length - 1 })
                      : t("Session")}
                  </span>
                  <CostFigure bucket={spend().report?.total} unknownReason={reason(spend())} />
                </div>
                <Show when={(spend().report?.byAgent.length ?? 0) > 1}>
                  <For each={spend().report!.byAgent}>
                    {(group) => (
                      <div class="fc-context-row fc-context-agent">
                        <span>{group.key ?? t("No agent")}</span>
                        <CostFigure bucket={group} />
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={spend().failure && spend().report}>
                  <div class="fc-context-row fc-context-muted">{t("Refresh failed: this is the last figure read.")}</div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
