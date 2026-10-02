import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { createHarnessClient } from "../client"
import { createResource } from "../resource"
import {
  LENSES,
  UNKNOWN,
  basisLabel,
  costText,
  known,
  lensMeaning,
  lensMoney,
  lensName,
  lensTotals,
  money,
  purposeName,
  rankOf,
  tokenCount,
} from "../cost"
import { formatTokens } from "../metrics"
import { runTitle } from "../run-title"
import { CostFigure } from "./CostFigure"
import { BudgetsBlock } from "./BudgetsBlock"
import { PanelFailure } from "./PanelBoundary"
import type { Run, UsageBucket, UsageDimension, UsageGroup, UsageSummary } from "../types"

type UsagePanelProps = {
  open: boolean
  serverUrl: string
  serverAvailable: boolean
  /** The project the app is in, offered first in the project selector. */
  directory?: string
  /** Why the harness refused this page (TI-14), which says more than the read's own failure. */
  refusal?: Error
  onRetryRefusal: () => void
  /** What the app knows of runs, routines and sessions, to name the ledger's ids. */
  runs: Run[]
  routineName: (id: string) => string | undefined
  /** The routines a standing budget can be for (UL-08). */
  routines: Array<{ id: string; name: string }>
  sessionTitle: (id: string) => string | undefined
  onOpenRuns: () => void
  onOpenSession: (id: string) => void
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

const folderName = (directory: string) => directory.split("/").filter(Boolean).at(-1) ?? directory

/** The dimensions the group-by switch offers. Runs and sessions have their own top lists below. */
export const GROUPINGS: UsageDimension[] = ["model", "provider", "agent", "workflow", "routine", "purpose", "directory"]

export const groupingName = (dimension: UsageDimension) =>
  ({
    model: t("Model"),
    provider: t("Provider"),
    agent: t("Agent"),
    workflow: t("Workflow"),
    routine: t("Routine"),
    purpose: t("Purpose"),
    directory: t("Project"),
  })[dimension as string] ?? dimension

/**
 * The local days from `from` to today, as the ledger names them (`YYYY-MM-DD`), so a day with no
 * rows is drawn as an empty slot rather than skipped and the series keeps its spacing.
 */
export function dayKeys(from: number, now: number) {
  const first = new Date(from)
  const last = new Date(now)
  const midnight = (at: Date, plus = 0) => new Date(at.getFullYear(), at.getMonth(), at.getDate() + plus)
  // Rounded, because a day across a clock change is 23 or 25 hours long.
  const count = Math.round((midnight(last).getTime() - midnight(first).getTime()) / 86_400_000) + 1
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const at = midnight(first, index)
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
  })
}

/** Where a period starts: midnight of the first of its days, so the first bar is a whole day. */
export function periodStart(days: number, now: number) {
  const today = new Date(now)
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime()
}

/**
 * The Cost screen (UL-06): what the work cost, on the usage ledger only.
 *
 * Period and project at the top; then the three money lenses of audit §8.4 side by side — estimated,
 * measured, notional — with what had no price apart; the daily money series; the spend grouped by
 * one dimension; and the runs and sessions that cost the most. Every figure is drawn by `CostFigure`
 * or the lens helpers of `cost.ts`, the same as on the composer and the run card.
 */
export const UsagePanel: Component<UsagePanelProps> = (props) => {
  const [days, setDays] = createSignal<number | undefined>(30)
  const [directory, setDirectory] = createSignal<string>()
  const [groupBy, setGroupBy] = createSignal<UsageDimension>("model")
  const [pickedDay, setPickedDay] = createSignal<string>()

  // One key for every read of the screen; the group-by only changes the grouped read.
  const scope = () => {
    if (!props.open || !props.serverAvailable) return undefined
    return [props.serverUrl, days() ?? 0, directory() ?? ""].join("\n")
  }
  const read = (key: string, extra: { groupBy: UsageDimension; limit?: number }) => {
    const [serverUrl = "", period = "0", folder = ""] = key.split("\n")
    return createHarnessClient(serverUrl).usageSummary({
      ...extra,
      ...(Number(period) ? { from: periodStart(Number(period), Date.now()) } : {}),
      ...(folder ? { directory: folder } : {}),
    })
  }
  const [grouped, { refetch: refetchGrouped }] = createResource(
    () => scope() && `${scope()}\n${groupBy()}`,
    (key) => read(key, { groupBy: key.split("\n")[3] as UsageDimension, limit: 12 }),
  )
  const [series, { refetch: refetchSeries }] = createResource(scope, (key) => read(key, { groupBy: "day" }))
  const [topRuns, { refetch: refetchRuns }] = createResource(scope, (key) => read(key, { groupBy: "run", limit: 6 }))
  const [topSessions, { refetch: refetchSessions }] = createResource(scope, (key) =>
    read(key, { groupBy: "session", limit: 6 }),
  )
  // The projects that spent anything in the period, for the selector: never narrowed by itself.
  const [projects, { refetch: refetchProjects }] = createResource(
    () => props.open && props.serverAvailable && `${props.serverUrl}\n${days() ?? 0}\n`,
    (key) => read(key, { groupBy: "directory", limit: 50 }),
  )
  const retry = () => {
    if (props.refusal) return props.onRetryRefusal()
    void refetchGrouped()
    void refetchSeries()
    void refetchRuns()
    void refetchSessions()
    void refetchProjects()
  }
  const failure = () =>
    props.refusal ??
    grouped.failure() ??
    series.failure() ??
    topRuns.failure() ??
    topSessions.failure() ??
    projects.failure()
  const loading = () => grouped.loading || series.loading
  const total = () => grouped()?.total

  const projectOptions = createMemo(() => {
    const listed = (projects()?.groups ?? []).flatMap((group) => (group.key ? [group.key] : []))
    const current = props.directory && !listed.includes(props.directory) ? [props.directory] : []
    const picked = directory() && ![...listed, ...current].includes(directory()!) ? [directory()!] : []
    return [...current, ...listed, ...picked]
  })

  const groupLabel = (dimension: UsageDimension, group: UsageGroup) => {
    if (group.key === null) return dimension === "agent" ? t("No agent") : t("Not attributed")
    if (dimension === "directory") return folderName(group.key)
    if (dimension === "purpose") return purposeName(group.key)
    if (dimension === "routine") return props.routineName(group.key) ?? group.key
    if (dimension === "workflow") return String(group.fields.workflowName ?? group.key)
    return group.key
  }
  const runLabel = (id: string) => {
    const run = props.runs.find((entry) => entry.id === id)
    return run ? runTitle(run) : id
  }

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Cost")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Cost")}</h1>
            <p>{t("What your work cost, every session and run, from the usage ledger.")}</p>
          </div>
        </div>

        <div class="fc-routines-toolbar fc-usage-toolbar">
          <div class="fc-routines-tabs">
            <For each={[7, 30, undefined] as const}>
              {(option) => (
                <button
                  class="fc-routines-tab"
                  classList={{ "fc-routines-tab-active": days() === option }}
                  type="button"
                  onClick={() => setDays(option)}
                >
                  {option === undefined ? t("All") : t("{n} days", { n: option })}
                </button>
              )}
            </For>
          </div>
          <label class="fc-usage-select">
            <span>{t("Project")}</span>
            <select value={directory() ?? ""} onChange={(event) => setDirectory(event.currentTarget.value || undefined)}>
              <option value="">{t("All projects")}</option>
              <For each={projectOptions()}>{(entry) => <option value={entry}>{folderName(entry)}</option>}</For>
            </select>
          </label>
        </div>

        <Show when={!props.serverAvailable && !failure()}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>
        <Show when={failure()}>
          {(error) => (
            <PanelFailure
              inline
              // A failed refresh keeps the last answer on screen, and says that is what it is.
              title={
                total()
                  ? t("Refresh failed: these are the last figures read.")
                  : t("{name} could not be read", { name: t("The cost report") })
              }
              error={error()}
              onRetry={retry}
            />
          )}
        </Show>

        <Show
          when={known(total()) ? total() : undefined}
          fallback={
            <Show when={loading() || !failure()}>
              <div class="fc-runs-empty">{loading() ? t("Reading…") : t("Nothing recorded in this period.")}</div>
            </Show>
          }
        >
          {(bucket) => (
            <div class="fc-usage">
              <LensTiles bucket={bucket()} />

              <section class="fc-usage-block" aria-labelledby="fc-usage-series">
                <h2 id="fc-usage-series">{t("By day")}</h2>
                <DaySeries
                  groups={series()?.groups ?? []}
                  from={days() ? periodStart(days()!, Date.now()) : undefined}
                  picked={pickedDay()}
                  onPick={(day) => setPickedDay((current) => (current === day ? undefined : day))}
                />
              </section>

              <section class="fc-usage-block" aria-labelledby="fc-usage-grouped">
                <div class="fc-usage-block-head">
                  <label class="fc-usage-select">
                    <h2 id="fc-usage-grouped">{t("Group by")}</h2>
                    <select
                      value={groupBy()}
                      onChange={(event) => setGroupBy(event.currentTarget.value as UsageDimension)}
                    >
                      <For each={GROUPINGS}>{(entry) => <option value={entry}>{groupingName(entry)}</option>}</For>
                    </select>
                  </label>
                </div>
                <GroupRows
                  summary={grouped()}
                  label={(group) => groupLabel(grouped()?.groupBy ?? groupBy(), group)}
                />
              </section>

              <div class="fc-usage-tops">
                <section class="fc-usage-block" aria-labelledby="fc-usage-runs">
                  <h2 id="fc-usage-runs">{t("Top runs")}</h2>
                  <GroupRows
                    summary={topRuns()}
                    skipUnattributed
                    label={(group) => runLabel(group.key!)}
                    onOpen={() => props.onOpenRuns()}
                    empty={t("No run spent anything in this period.")}
                  />
                </section>
                <section class="fc-usage-block" aria-labelledby="fc-usage-sessions">
                  <h2 id="fc-usage-sessions">{t("Top sessions")}</h2>
                  <GroupRows
                    summary={topSessions()}
                    skipUnattributed
                    label={(group) => props.sessionTitle(group.key!) ?? group.key!}
                    onOpen={(group) => props.onOpenSession(group.key!)}
                    empty={t("No session spent anything in this period.")}
                  />
                </section>
              </div>
            </div>
          )}
        </Show>

        {/* The budgets over this spend (UL-08), under the figures they are about. Shown with nothing
            spent yet too, so one can be set before it is needed. */}
        <div class="fc-usage">
          <BudgetsBlock
            serverUrl={props.serverUrl}
            serverAvailable={props.serverAvailable}
            routines={props.routines}
            workflows={[...new Set(props.runs.flatMap((run) => (run.workflow ? [run.workflow.name] : [])))]}
          />
        </div>
      </section>
    </Show>
  )
}

/** The three money lenses of audit §8.4 and what had no price, each named and explained. */
const LensTiles: Component<{ bucket: UsageBucket }> = (props) => {
  const byLens = () => lensTotals(props.bucket)
  return (
    <div class="fc-usage-tiles">
      <For each={LENSES}>
        {(lens) => {
          const entry = () => byLens().find((item) => item.lens === lens)
          return (
            <div class="fc-usage-tile" data-lens={lens}>
              <span class="fc-usage-tile-value fc-cost-lens" data-lens={lens}>
                {/* The tile's label names the lens, so the figure is the money alone (an estimate keeps its ~). */}
                {entry() ? (lens === "estimated" ? lensMoney(lens, entry()!.usd) : money(entry()!.usd)) : UNKNOWN}
              </span>
              <span class="fc-usage-tile-label">{lensName(lens)}</span>
              <span class="fc-usage-tile-note">{lensMeaning(lens)}</span>
              <Show when={entry()}>
                <details class="fc-usage-tile-basis">
                  <summary>{t("Basis")}</summary>
                  <For each={entry()!.lines}>
                    {(line) => (
                      <span class="fc-cost-basis-row">
                        <span>{money(line.usd)}</span>
                        <span>{basisLabel(line)}</span>
                      </span>
                    )}
                  </For>
                </details>
              </Show>
            </div>
          )
        }}
      </For>
      <div class="fc-usage-tile" data-lens="unpriced">
        <span class="fc-usage-tile-value fc-cost-lens" data-lens="unpriced">
          {props.bucket.unpriced.events > 0
            ? t("{n} model calls", { n: props.bucket.unpriced.events })
            : UNKNOWN}
        </span>
        <span class="fc-usage-tile-label">{lensName("unpriced")}</span>
        <span class="fc-usage-tile-note">
          {props.bucket.unpriced.events > 0
            ? t("{tokens} tokens with no price for the model, so never counted as $0", {
                tokens: formatTokens(tokenCount(props.bucket.unpriced.tokens)),
              })
            : lensMeaning("unpriced")}
        </span>
      </div>
      <div class="fc-usage-tile">
        <span class="fc-usage-tile-value">{formatTokens(tokenCount(props.bucket.tokens))}</span>
        <span class="fc-usage-tile-label">{t("Tokens")}</span>
        <span class="fc-usage-tile-note">
          {t("Cache included: {cache} read or written from cache", {
            cache: formatTokens(props.bucket.tokens.cacheRead + props.bucket.tokens.cacheWrite),
          })}
        </span>
      </div>
    </div>
  )
}

/**
 * Money per day, each lens a segment of its own colour and never stacked into one sum's colour; a
 * day that also had unpriced calls carries a mark. A bar opens that day's figure with its basis.
 */
const DaySeries: Component<{
  groups: UsageGroup[]
  from: number | undefined
  picked: string | undefined
  onPick: (day: string) => void
}> = (props) => {
  const byDay = createMemo(() => new Map(props.groups.flatMap((group) => (group.key ? [[group.key, group]] : []))))
  const days = createMemo(() => {
    // "All" starts on the first day the ledger has, which it answers oldest first.
    const oldest = props.groups.find((group) => group.key)?.key
    const start = props.from ?? (oldest ? new Date(`${oldest}T00:00:00`).getTime() : undefined)
    return start === undefined ? [] : dayKeys(start, Date.now())
  })
  // Scaled to the costliest day, so a month of pennies is not a row of slivers.
  const scale = () => Math.max(0, ...props.groups.map((group) => rankOf(group)))
  const pickedGroup = () => (props.picked ? byDay().get(props.picked) : undefined)
  return (
    <>
      <div class="fc-usage-legend" aria-hidden="true">
        <For each={LENSES}>
          {(lens) => (
            <span class="fc-usage-legend-item">
              <i data-lens={lens} />
              {lensName(lens)}
            </span>
          )}
        </For>
        <span class="fc-usage-legend-item">
          <i data-lens="unpriced" />
          {lensName("unpriced")}
        </span>
      </div>
      <div class="fc-usage-days">
        <For each={days()}>
          {(day, index) => {
            const group = () => byDay().get(day)
            return (
              <button
                class="fc-usage-day"
                classList={{ "fc-usage-day-picked": props.picked === day }}
                type="button"
                title={`${day} · ${costText(group())}`}
                aria-label={`${day}: ${costText(group())}`}
                aria-pressed={props.picked === day}
                onClick={() => props.onPick(day)}
              >
                <span class="fc-usage-day-stack">
                  <For each={lensTotals(group())}>
                    {(entry) => (
                      <span
                        class="fc-usage-day-bar"
                        data-lens={entry.lens}
                        style={{ height: `${share(entry.usd, scale())}%` }}
                      />
                    )}
                  </For>
                </span>
                <span class="fc-usage-day-mark" classList={{ "fc-usage-day-mark-on": (group()?.unpriced.events ?? 0) > 0 }} />
                {/* Every label on a wide screen; on a narrow one, a week apart counted from today. */}
                <span class="fc-usage-day-label" data-tick={(days().length - 1 - index()) % 7 === 0}>
                  {day.slice(5)}
                </span>
              </button>
            )
          }}
        </For>
      </div>
      <Show when={props.picked}>
        {(day) => (
          <div class="fc-usage-day-detail">
            <span>{day()}</span>
            <CostFigure bucket={pickedGroup()} />
            <Show when={pickedGroup()}>
              <For each={pickedGroup()!.money}>
                {(line) => (
                  <span class="fc-cost-basis-row">
                    <span>{money(line.usd)}</span>
                    <span>{basisLabel(line)}</span>
                  </span>
                )}
              </For>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

/**
 * One summary as rows: a name, a bar against the biggest group, its tokens and its cost. The groups
 * the limit cut are one more row, so the list still adds up to the total.
 */
const GroupRows: Component<{
  summary: UsageSummary | undefined
  label: (group: UsageGroup) => string
  onOpen?: (group: UsageGroup) => void
  /** Leave out the rows the dimension does not name, e.g. chats in a list of runs. */
  skipUnattributed?: boolean
  empty?: string
}> = (props) => {
  const groups = () => (props.summary?.groups ?? []).filter((group) => !props.skipUnattributed || group.key !== null)
  // A bar is money where there is any, tokens where nothing had a price.
  const priced = () => groups().some((group) => rankOf(group) > 0)
  const size = (group: UsageBucket) => (priced() ? rankOf(group) : tokenCount(group.tokens))
  const biggest = () => Math.max(0, ...groups().map(size))
  return (
    <Show when={groups().length > 0} fallback={<p class="fc-usage-note">{props.empty ?? t("Nothing recorded in this period.")}</p>}>
      <For each={groups()}>
        {(group) => (
          <div class="fc-usage-row">
            <Show when={props.onOpen} fallback={<span class="fc-usage-key" title={props.label(group)}>{props.label(group)}</span>}>
              <button
                class="fc-usage-key fc-usage-open"
                type="button"
                title={props.label(group)}
                onClick={() => props.onOpen!(group)}
              >
                {props.label(group)}
              </button>
            </Show>
            <span class="fc-usage-bar" aria-hidden="true">
              <span style={{ width: `${share(size(group), biggest())}%` }} />
            </span>
            <span class="fc-usage-tokens">{t("{n} tokens", { n: formatTokens(tokenCount(group.tokens)) })}</span>
            <span class="fc-usage-cost">
              <CostFigure bucket={group} />
            </span>
          </div>
        )}
      </For>
      <Show when={!props.skipUnattributed && props.summary?.rest}>
        {(rest) => (
          <div class="fc-usage-row fc-usage-rest">
            <span class="fc-usage-key">{t("{n} more", { n: rest().groups })}</span>
            <span class="fc-usage-bar" aria-hidden="true" />
            <span class="fc-usage-tokens">{t("{n} tokens", { n: formatTokens(tokenCount(rest().tokens)) })}</span>
            <span class="fc-usage-cost">
              <CostFigure bucket={rest()} />
            </span>
          </div>
        )}
      </Show>
    </Show>
  )
}
