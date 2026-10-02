import { For, Show, createSignal, type Component, type JSX } from "solid-js"
import { formatTokens, type ActivityDay } from "../metrics"
import { UNKNOWN, favoriteModel, known, share, tokenCount } from "../cost"
import { t } from "../i18n"
import { sessionTitle } from "../session-title"
import type { SessionInfo } from "../engine-types"
import type { SessionStats } from "../engine/contract"
import type { UsageSummary } from "../types"
import { ActivityHeatmap } from "./ActivityHeatmap"
import { CostFigure } from "./CostFigure"

type HomeCanvasProps = {
  displayName: string
  /** The period in days, or all of it; the same periods as the Cost screen. */
  range: number | undefined
  /** The usage ledger's figures for the period, grouped by model: what the Cost screen reads. */
  usage: UsageSummary | undefined
  /** The engine's stats for the period: sessions, active days and the longest streak. */
  stats: SessionStats | undefined
  /** The last year, a day per cell, counted in model calls. */
  activity: ActivityDay[]
  /** The sessions working right now. Empty renders nothing; the list has no heading of its own. */
  activeSessions: SessionInfo[]
  onOpenSession: (sessionID: string) => void
  error: string | undefined
  onRangeChange: (range: number | undefined) => void
}

/** The Cost screen's periods, in its order and with its words. */
const RANGES = [7, 30, undefined] as const

/** Every model the ledger saw in the period, by tokens (cache included) and what it cost. */
const ModelUsage: Component<{ usage: UsageSummary }> = (props) => {
  const total = () => tokenCount(props.usage.total.tokens)
  const models = () =>
    props.usage.groups
      .filter((group) => group.key !== null)
      .toSorted((a, b) => tokenCount(b.tokens) - tokenCount(a.tokens))
  return (
    <ul class="fc-model-legend">
      <For each={models()}>
        {(model) => (
          <li class="fc-model-legend-row">
            <span class="fc-legend-name" title={model.key!}>
              {model.key}
            </span>
            <span class="fc-legend-tokens">{t("{n} tokens", { n: formatTokens(tokenCount(model.tokens)) })}</span>
            <span class="fc-legend-share">{share(tokenCount(model.tokens), total())}%</span>
            <span class="fc-legend-cost">
              <CostFigure bucket={model} />
            </span>
          </li>
        )}
      </For>
      <Show when={props.usage.rest}>
        {(rest) => (
          <li class="fc-model-legend-row">
            <span class="fc-legend-name">{t("{n} more", { n: rest().groups })}</span>
            <span class="fc-legend-tokens">{t("{n} tokens", { n: formatTokens(tokenCount(rest().tokens)) })}</span>
            <span class="fc-legend-share">{share(tokenCount(rest().tokens), total())}%</span>
            <span class="fc-legend-cost">
              <CostFigure bucket={rest()} />
            </span>
          </li>
        )}
      </Show>
    </ul>
  )
}

export const HomeCanvas: Component<HomeCanvasProps> = (props) => {
  const [tab, setTab] = createSignal<"summary" | "models">("summary")
  const greeting = () =>
    props.displayName.trim() ? t("What's next, {name}?", { name: props.displayName.trim() }) : t("What's next?")

  const total = () => props.usage?.total
  const cache = () => (total() ? total()!.tokens.cacheRead + total()!.tokens.cacheWrite : 0)
  const count = (value: number | undefined, suffix = "") => (value === undefined ? UNKNOWN : `${value}${suffix}`)
  // The tokens, cost and favorite model are the ledger's; the rest, the engine's. A dash is a figure
  // that could not be read, never a zero.
  const stats = (): Array<{ label: string; value: JSX.Element; note?: string; wide?: boolean }> => [
    { label: t("Sessions"), value: count(props.stats?.sessions) },
    { label: t("Active days"), value: count(props.stats?.activeDays) },
    { label: t("Longest streak"), value: count(props.stats?.streak, "d") },
    {
      label: t("Tokens"),
      value: total() ? formatTokens(tokenCount(total()!.tokens)) : UNKNOWN,
      note: total()
        ? t("Cache included: {cache} read or written from cache", { cache: formatTokens(cache()) })
        : undefined,
    },
    // Wide, like the model: a cost can be several lenses side by side.
    { label: t("Cost"), value: <CostFigure bucket={total()} />, wide: true },
    { label: t("Favorite model"), value: favoriteModel(props.usage?.groups ?? [])?.key ?? UNKNOWN, wide: true },
  ]

  return (
    <section class="fc-canvas">
      <h1 class="fc-greeting">{greeting()}</h1>
      <p class="fc-subtitle">{t("Your FlupCode activity at a glance.")}</p>

      <Show when={props.error}>
        <div class="fc-error">{props.error}</div>
      </Show>

      <div class="fc-card">
        <div class="fc-card-header">
          <div class="fc-tabs">
            <button
              class="fc-tab"
              classList={{ "fc-tab-active": tab() === "summary" }}
              type="button"
              onClick={() => setTab("summary")}
            >
              {t("Summary")}
            </button>
            <button
              class="fc-tab"
              classList={{ "fc-tab-active": tab() === "models" }}
              type="button"
              onClick={() => setTab("models")}
            >
              {t("Models")}
            </button>
          </div>
          <div class="fc-range">
            <For each={RANGES}>
              {(days) => (
                <button
                  class="fc-range-button"
                  classList={{ "fc-range-button-active": props.range === days }}
                  type="button"
                  onClick={() => props.onRangeChange(days)}
                >
                  {days === undefined ? t("All") : t("{n} days", { n: days })}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show
          when={tab() === "summary"}
          fallback={
            <Show
              when={known(props.usage?.total) ? props.usage : undefined}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">{props.usage ? t("Nothing recorded in this period.") : UNKNOWN}</span>
                </div>
              }
            >
              {(usage) => <ModelUsage usage={usage()} />}
            </Show>
          }
        >
          <div class="fc-stat-grid">
            <For each={stats()}>
              {(stat) => (
                <div class="fc-stat" classList={{ "fc-stat-wide": stat.wide }}>
                  <span class="fc-stat-value">{stat.value}</span>
                  <span class="fc-stat-label">{stat.label}</span>
                  <Show when={stat.note}>
                    <span class="fc-stat-note">{stat.note}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <ActivityHeatmap days={props.activity} />
        </Show>
      </div>

      <Show when={props.activeSessions.length > 0}>
        <ul class="fc-active-sessions">
          <For each={props.activeSessions}>
            {(session) => (
              <li>
                <button class="fc-active-session" type="button" onClick={() => props.onOpenSession(session.id)}>
                  <span class="fc-session-dot fc-session-dot-running" aria-hidden="true" />
                  <span class="fc-session-title">{sessionTitle(session) || t("New session")}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
