import { For, Show, type Component } from "solid-js"
import { t } from "../i18n"
import { createResource } from "../resource"
import { adaptiveSurfaces, createHarnessClient } from "../client"
import { formatTokens, money } from "../metrics"
import type { Percentiles, SessionCost, ToolTotal } from "../types"
import { sizeLabel } from "./ConfigFilesPanel"
import { PanelFailure } from "./PanelBoundary"
import { duration, share } from "./UsagePanel"

type SessionCostsProps = {
  open: boolean
  serverUrl: string
  capabilities: string[]
  /** How far back to look, in days; undefined is everything there is. */
  days: number | undefined
  /** The project folder to keep to, or undefined for every project. */
  directory?: string
  /** The engine's title for a session, when the session list still has it. */
  titleOf: (sessionID: string) => string | undefined
  onOpenSession: (sessionID: string) => void
}

/**
 * What the resource is keyed on, or nothing when it must not ask: a closed screen, or a server that
 * did not announce `adaptive-metrics` — an older sidecar would answer a 404 into the console.
 */
export function sessionCostKey(input: {
  open: boolean
  capabilities: readonly string[]
  serverUrl: string
  directory?: string
  days?: number
}) {
  if (!input.open || !adaptiveSurfaces(input.capabilities).metrics) return undefined
  return `${input.serverUrl}\n${input.directory ?? ""}\n${input.days ?? 0}`
}

/** The window's start, in epoch milliseconds; no window is no bound. */
export const sinceFor = (days: number | undefined, now: number) => (days ? now - days * 86_400_000 : undefined)

/** A cached share as a whole percentage. */
export const cachedText = (fraction: number) => `${share(fraction, 1)}%`

/** A latency in the unit a reader uses: milliseconds, then seconds, then minutes. */
export function msText(ms: number | undefined) {
  if (ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return duration(ms)
}

/** p50 and p95 side by side, or a dash when no turn measured it. */
export const percentilesText = (value: Percentiles) =>
  value.p50 === undefined ? "—" : `${msText(value.p50)} / ${msText(value.p95)}`

/** A session is named by its title when the engine still has it, else by its id. */
export const sessionLabel = (session: SessionCost, title: string | undefined) => title || session.sessionID

const folder = (directory: string) => directory.split("/").filter(Boolean).at(-1) ?? directory

/**
 * What each session cost (AH-B02).
 *
 * The runs above are only what the harness started; this is every session, chat or run, measured
 * turn by turn by the metrics plugin. It asks for nothing when the server did not announce the
 * surface, and says so instead of showing an empty page that looks like nothing was spent.
 */
export const SessionCosts: Component<SessionCostsProps> = (props) => {
  const available = () => adaptiveSurfaces(props.capabilities).metrics
  const [report, actions] = createResource(
    () =>
      sessionCostKey({
        open: props.open,
        capabilities: props.capabilities,
        serverUrl: props.serverUrl,
        directory: props.directory,
        days: props.days,
      }),
    () =>
      createHarnessClient(props.serverUrl).adaptive.metrics.sessions({
        since: sinceFor(props.days, Date.now()),
        directory: props.directory,
      }),
  )
  const totals = () => report()?.totals

  return (
    <section class="fc-usage-block fc-session-costs" aria-label={t("Sessions")}>
      <h2>{t("Sessions")}</h2>
      <p class="fc-usage-note">{t("Every session, chat or run, measured turn by turn.")}</p>
      <Show
        when={available()}
        fallback={<div class="fc-routines-notice">{t("This server does not record session metrics.")}</div>}
      >
        <Show when={!report.loading && report.failure()}>
          {(error) => (
            <PanelFailure
              inline
              title={t("{name} could not be read", { name: t("Session cost") })}
              error={error()}
              onRetry={() => void actions.refetch()}
            />
          )}
        </Show>
        <Show
          when={(totals()?.sessions ?? 0) > 0}
          fallback={
            <Show when={!report.failure() || report.loading}>
              <div class="fc-runs-empty">
                {report.loading ? t("Reading…") : t("No session has been measured in this window.")}
              </div>
            </Show>
          }
        >
          <div class="fc-usage-tiles">
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value">{money(totals()!.cost)}</span>
              <span class="fc-usage-tile-label">{t("Spent")}</span>
            </div>
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value">{totals()!.sessions}</span>
              <span class="fc-usage-tile-label">{t("Sessions")}</span>
            </div>
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value">{formatTokens(totals()!.tokens.total)}</span>
              <span class="fc-usage-tile-label">{t("Tokens")}</span>
            </div>
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value">{cachedText(totals()!.cached)}</span>
              <span class="fc-usage-tile-label">{t("Cached")}</span>
            </div>
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value fc-session-cost-pair">{percentilesText(totals()!.turnMs)}</span>
              <span class="fc-usage-tile-label">{t("Turn p50 / p95")}</span>
            </div>
            <div class="fc-usage-tile">
              <span class="fc-usage-tile-value fc-session-cost-pair">{percentilesText(totals()!.firstTokenMs)}</span>
              <span class="fc-usage-tile-label">{t("First token p50 / p95")}</span>
            </div>
          </div>

          <div class="fc-session-cost-table" role="table" aria-label={t("Cost per session")}>
            <div class="fc-session-cost-row fc-session-cost-head" role="row">
              <span role="columnheader">{t("Session")}</span>
              <span role="columnheader">{t("Turns")}</span>
              <span role="columnheader">{t("Tokens")}</span>
              <span role="columnheader">{t("Cached")}</span>
              <span role="columnheader">{t("Turn p50 / p95")}</span>
              <span role="columnheader">{t("First token")}</span>
              <span role="columnheader">{t("Cost")}</span>
            </div>
            <For each={report()?.sessions ?? []}>
              {(session) => (
                <div class="fc-session-cost-row" role="row">
                  <span class="fc-session-cost-name" role="cell">
                    <button
                      class="fc-session-cost-open"
                      type="button"
                      title={session.sessionID}
                      onClick={() => props.onOpenSession(session.sessionID)}
                    >
                      {sessionLabel(session, props.titleOf(session.sessionID))}
                    </button>
                    <span class="fc-session-cost-meta">
                      {[session.modelID, session.projectID ? folder(session.projectID) : undefined]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span role="cell">{session.turns}</span>
                  <span role="cell">{formatTokens(session.tokens.total)}</span>
                  <span role="cell">{cachedText(session.cached)}</span>
                  <span role="cell">{percentilesText(session.turnMs)}</span>
                  <span role="cell">{percentilesText(session.firstTokenMs)}</span>
                  <span class="fc-session-cost-money" role="cell">
                    {money(session.cost)}
                  </span>
                </div>
              )}
            </For>
          </div>

          <ToolRows tools={report()?.topTools ?? []} />
        </Show>
      </Show>
    </section>
  )
}

/** The tools whose output filled the context most, which is where the input tokens came from. */
const ToolRows: Component<{ tools: ToolTotal[] }> = (props) => (
  <Show when={props.tools.length > 0}>
    <div class="fc-session-cost-tools">
      <h2>{t("Top tools by output")}</h2>
      <For each={props.tools}>
        {(tool) => (
          <div class="fc-usage-row">
            <span class="fc-usage-key">{tool.tool}</span>
            <span class="fc-usage-bar" aria-hidden="true">
              <span style={{ width: `${share(tool.bytes, props.tools[0]!.bytes || 1)}%` }} />
            </span>
            <span class="fc-usage-tokens">{t("{n} calls", { n: tool.calls })}</span>
            <span class="fc-usage-cost">{sizeLabel(tool.bytes)}</span>
          </div>
        )}
      </For>
    </div>
  </Show>
)
