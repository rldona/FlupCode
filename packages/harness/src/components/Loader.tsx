import { Show, createSignal, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"

type LoaderProps = {
  tokens?: { input: number; output: number; reasoning: number }
  cost?: number
  startedAt?: number
  class?: string
  label?: string
  /** Tool calls in progress, shown as "1 running task". */
  tasks?: number
}

const phrases = ["Thinking…", "Generating…", "Writing…", "Working…", "Loading information…"]

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

export const Loader: Component<LoaderProps> = (props) => {
  const mountedAt = Date.now()
  const started = () => props.startedAt ?? mountedAt
  const [index, setIndex] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const phraseTimer = setInterval(() => setIndex((value) => (value + 1) % phrases.length), 2200)
  const clockTimer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    clearInterval(phraseTimer)
    clearInterval(clockTimer)
  })

  const label = () => props.label ?? t(phrases[index()] ?? phrases[0]!)
  const elapsed = () => {
    const seconds = Math.max(0, Math.round((now() - started()) / 1000))
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }
  const total = () => {
    const tokens = props.tokens
    if (!tokens) return undefined
    return tokens.input + tokens.output + tokens.reasoning
  }

  return (
    <div class={`fc-loader ${props.class ?? ""}`} role="status" aria-live="polite">
      <span class="fc-loader-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span class="fc-loader-time">{elapsed()}</span>
      <Show when={(total() ?? 0) > 0}>
        <span class="fc-loader-sep">·</span>
        <span class="fc-loader-meta">
          {formatTokens(total()!)} {t("tokens")}
        </span>
      </Show>
      <Show when={(props.tasks ?? 0) > 0}>
        <span class="fc-loader-sep">·</span>
        <span class="fc-loader-meta">
          {props.tasks === 1 ? t("1 running task") : t("{n} running tasks", { n: props.tasks ?? 0 })}
        </span>
      </Show>
      <Show when={props.cost !== undefined && props.cost > 0}>
        <span class="fc-loader-sep">·</span>
        <span class="fc-loader-meta">${props.cost!.toFixed(4)}</span>
      </Show>
      <Show when={label()}>
        <span class="fc-loader-sep">·</span>
        <span class="fc-loader-text">{label()}</span>
      </Show>
    </div>
  )
}
