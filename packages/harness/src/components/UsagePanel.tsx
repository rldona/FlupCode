import { For, Show, createMemo, type Component } from "solid-js"
import { t } from "../i18n"
import { formatTokens } from "../metrics"
import type { Spend, UsageReport } from "../types"

type UsagePanelProps = {
  open: boolean
  report: UsageReport | undefined
  loading: boolean
  error?: string
  /** How far back it is looking, in days; undefined is everything there is. */
  days: number | undefined
  onDays: (days: number | undefined) => void
  /** The folder it is looking at, or undefined for every project at once. */
  directory?: string
  onlyProject: boolean
  onOnlyProject: (only: boolean) => void
  serverAvailable: boolean
  onOpenRuns: () => void
}

/**
 * Money, to the cent when it is money and to four places when it is not yet.
 *
 * A run that cost $0.0034 shows as $0.00 at two places, which reads as free. It was not free — it
 * is the number that turns into real money once it happens two hundred times.
 */
export function money(value: number) {
  if (value === 0) return "$0"
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/** A duration a person reads, not a number of milliseconds. */
export function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** What a slice is of the whole, as a percentage, with nothing divided by nothing. */
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

const name = (directory: string) => directory.split("/").filter(Boolean).at(-1) ?? directory

/**
 * The biggest day, which every other bar is drawn against.
 *
 * Not `Math.max(1, …)`, which is what this was: a day's cost is usually a fraction of a dollar, so
 * the 1 wins and every bar is drawn at a few per cent of the box. The floor is only there to stop a
 * division by zero.
 */
export function scaleOf(days: Array<{ cost: number; tokens: number }>) {
  const most = days.reduce((top, day) => Math.max(top, day.cost || day.tokens), 0)
  return most > 0 ? most : 1
}

const Rows: Component<{ title: string; rows: Array<Spend & { key: string }>; total: number; label?: (key: string) => string }> = (
  props,
) => (
  <Show when={props.rows.length > 0}>
    <section class="fc-usage-block">
      <h2>{props.title}</h2>
      <For each={props.rows}>
        {(entry) => (
          <div class="fc-usage-row">
            <span class="fc-usage-key">{props.label ? props.label(entry.key) : entry.key}</span>
            <span class="fc-usage-bar" aria-hidden="true">
              <span style={{ width: `${share(entry.cost || entry.tokens, props.total || 1)}%` }} />
            </span>
            <span class="fc-usage-tokens">{formatTokens(entry.tokens)}</span>
            <span class="fc-usage-cost">{money(entry.cost)}</span>
          </div>
        )}
      </For>
    </section>
  </Show>
)

/**
 * What the runs cost (H-16).
 *
 * The home screen counts tokens and has never shown a price, a model or an agent. This does, and it
 * splits out the one number that was impossible to see: what was spent doing something a second
 * time. A bounded retry is a new task by design, so work attempted twice is billed twice.
 *
 * Runs only, and it says so on screen. The harness does not see an ordinary chat turn, and adding
 * the engine's session totals on top would count every run task twice — a task *is* a session.
 */
export const UsagePanel: Component<UsagePanelProps> = (props) => {
  const totals = () => props.report?.totals
  const retries = () => props.report?.retries
  const busiest = createMemo(() => scaleOf(props.report?.byDay ?? []))

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Cost")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Cost")}</h1>
            <p>{t("Every run the harness has recorded — not ordinary chat turns, which it never sees.")}</p>
          </div>
        </div>

        <div class="fc-routines-toolbar">
          <div class="fc-routines-tabs">
            <For each={[7, 30, undefined] as const}>
              {(days) => (
                <button
                  class="fc-routines-tab"
                  classList={{ "fc-routines-tab-active": props.days === days }}
                  type="button"
                  onClick={() => props.onDays(days)}
                >
                  {days === undefined ? t("All") : t("{n} days", { n: days })}
                </button>
              )}
            </For>
          </div>
          <Show when={props.directory}>
            {(directory) => (
              <label class="fc-usage-only">
                <input
                  type="checkbox"
                  checked={props.onlyProject}
                  onChange={(event) => props.onOnlyProject(event.currentTarget.checked)}
                />
                {t("Only {project}", { project: name(directory()) })}
              </label>
            )}
          </Show>
        </div>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>
        <Show when={props.error}>{(error) => <div class="fc-routines-notice">{error()}</div>}</Show>

        <Show
          when={totals() && totals()!.tasks > 0}
          fallback={
            <div class="fc-runs-empty">{props.loading ? t("Reading…") : t("Nothing has run in this window.")}</div>
          }
        >
          <div class="fc-usage">
            <div class="fc-usage-tiles">
              <div class="fc-usage-tile">
                <span class="fc-usage-tile-value">{money(totals()!.cost)}</span>
                <span class="fc-usage-tile-label">{t("Spent")}</span>
              </div>
              <div class="fc-usage-tile">
                <span class="fc-usage-tile-value">{formatTokens(totals()!.tokens)}</span>
                <span class="fc-usage-tile-label">{t("Tokens")}</span>
              </div>
              <div class="fc-usage-tile">
                <span class="fc-usage-tile-value">{totals()!.runs}</span>
                <span class="fc-usage-tile-label">{t("Runs")}</span>
              </div>
              <div class="fc-usage-tile">
                <span class="fc-usage-tile-value">{duration(totals()!.ms)}</span>
                <span class="fc-usage-tile-label">{t("Time")}</span>
              </div>
              {/*
                The one that was impossible to see. A retry is a new task by design, so anything
                attempted twice was paid for twice — and it was mixed into the first number.
              */}
              <div class="fc-usage-tile fc-usage-tile-warn" classList={{ "fc-usage-tile-quiet": retries()!.tasks === 0 }}>
                <span class="fc-usage-tile-value">{money(retries()!.cost)}</span>
                <span class="fc-usage-tile-label">
                  {t("On retries ({n}%)", { n: share(retries()!.cost, totals()!.cost) })}
                </span>
              </div>
            </div>

            <Show when={(props.report?.byDay.length ?? 0) > 1}>
              <section class="fc-usage-block">
                <h2>{t("By day")}</h2>
                <div class="fc-usage-days">
                  <For each={props.report?.byDay ?? []}>
                    {(day) => (
                      <div class="fc-usage-day" title={`${day.day} · ${money(day.cost)}`}>
                        <span
                          class="fc-usage-day-bar"
                          style={{ height: `${Math.max(2, share(day.cost || day.tokens, busiest()))}%` }}
                        />
                        <span class="fc-usage-day-label">{day.day.slice(5)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Rows title={t("By model")} rows={props.report?.byModel ?? []} total={totals()!.cost || totals()!.tokens} />
            <Rows title={t("By agent")} rows={props.report?.byAgent ?? []} total={totals()!.cost || totals()!.tokens} />
            <Show when={!props.onlyProject}>
              <Rows
                title={t("By project")}
                rows={props.report?.byProject ?? []}
                total={totals()!.cost || totals()!.tokens}
                label={name}
              />
            </Show>

            <Show when={(props.report?.slowest.length ?? 0) > 0}>
              <section class="fc-usage-block">
                <h2>{t("Longest tasks")}</h2>
                <p class="fc-usage-note">{t("Where the time went, which is not always where the money went.")}</p>
                <For each={props.report?.slowest ?? []}>
                  {(task) => (
                    <div class="fc-usage-row">
                      <span class="fc-usage-key">{task.name}</span>
                      <span class="fc-usage-cost">{duration(task.ms)}</span>
                    </div>
                  )}
                </For>
                <button class="fc-button" type="button" onClick={props.onOpenRuns}>
                  {t("Open Runs")}
                </button>
              </section>
            </Show>
          </div>
        </Show>
      </section>
    </Show>
  )
}
