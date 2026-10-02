import type { Engine } from "../engine"
import type { SqliteRoutineRepository } from "../repository"
import { quotaAdapter, type QuotaRead, type QuotaWindow } from "./adapters"
import { forecastOf } from "./forecast"

/** How often a provider is read when its last read worked. */
export const QUOTA_INTERVAL_MS = 5 * 60_000
/** The longest wait after failures in a row, which double the interval each time. */
export const QUOTA_MAX_BACKOFF_MS = 60 * 60_000
/** How far back a forecast reads. */
const FORECAST_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * Reads the quota of the providers that are connected (UL-07), on the server, and keeps each reading.
 *
 * Only an integration the engine lists with a connection, and that has an adapter, is ever read: a
 * provider nobody connected is never called. Each is read every `intervalMs` while that works; after
 * a failure the wait doubles up to `maxBackoffMs`, and the failure is kept beside the last good
 * reading, which stays on screen. The screen reads what is stored (`report`), never the provider, so
 * opening it costs the provider nothing.
 */
export function createQuotaPoller(input: {
  engine: Pick<Engine, "connectedIntegrations" | "readQuota">
  repository: Pick<SqliteRoutineRepository, "addQuotaSamples" | "quotaSamples">
  intervalMs?: number
  maxBackoffMs?: number
  now?: () => number
}) {
  const interval = input.intervalMs ?? QUOTA_INTERVAL_MS
  const maxBackoff = input.maxBackoffMs ?? QUOTA_MAX_BACKOFF_MS
  const now = input.now ?? Date.now
  // The connected providers with an adapter, as last listed; kept as they were when the engine cannot answer.
  let providers: Array<{ integrationID: string; name: string }> = []
  const state = new Map<string, { nextAt: number; failures: number; skipped?: boolean; error?: { message: string; at: number } }>()
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const read = async (provider: { integrationID: string; name: string }) => {
    const id = provider.integrationID
    const at = now()
    const failed = (message: string) => {
      const failures = (state.get(id)?.failures ?? 0) + 1
      state.set(id, { failures, nextAt: at + Math.min(interval * 2 ** failures, maxBackoff), error: { message, at } })
    }
    const answer: QuotaRead = await input.engine
      .readQuota(id)
      .catch((cause: unknown) => ({ status: "failed" as const, account: "", message: messageOf(cause) }))
    // A sign-in rather than a key, or a connection gone since the listing: nothing to read, nothing to show.
    if (answer.status === "unsupported" || answer.status === "unconfigured")
      return void state.set(id, { failures: 0, nextAt: at + interval, skipped: true })
    if (answer.status === "failed") return failed(answer.message)
    if (answer.httpStatus !== 200) return failed(providerError(provider.name, answer.httpStatus, answer.body))
    const adapter = quotaAdapter(id)!
    const windows = (() => {
      try {
        return adapter.windows(answer.body, at)
      } catch (cause) {
        return messageOf(cause)
      }
    })()
    if (typeof windows === "string") return failed(windows)
    input.repository.addQuotaSamples({ providerID: id, account: answer.account, at, source: adapter.docs, windows })
    state.set(id, { failures: 0, nextAt: at + interval })
  }

  const pass = async () => {
    const listed = await input.engine.connectedIntegrations().catch(() => undefined)
    if (listed) providers = listed.filter((provider) => quotaAdapter(provider.integrationID))
    for (const id of [...state.keys()])
      if (!providers.some((provider) => provider.integrationID === id)) state.delete(id)
    const due = providers.filter((provider) => (state.get(provider.integrationID)?.nextAt ?? 0) <= now())
    await Promise.all(due.map(read))
  }

  /** One pass: lists the connected providers and reads those that are due. Never two at once. */
  const tick = () => (running ??= pass().finally(() => (running = undefined)))

  return {
    tick,
    start: (everyMs = 60_000) => {
      void tick()
      timer = setInterval(() => void tick(), everyMs)
    },
    stop: () => clearInterval(timer),
    /**
     * Each connected provider with an adapter: its windows as last read, when that was, a forecast
     * per window, and the last failure when the latest read failed.
     */
    report: () =>
      providers.flatMap((provider) => {
        const id = provider.integrationID
        const status = state.get(id)
        if (status?.skipped) return []
        const samples = input.repository.quotaSamples(id, now() - FORECAST_WINDOW_MS)
        const sampledAt = samples.at(-1)?.at ?? null
        const latest = samples.filter((sample) => sample.at === sampledAt)
        return [
          {
            providerID: id,
            name: provider.name,
            docs: quotaAdapter(id)!.docs,
            sampledAt,
            ...(status?.error ? { error: status.error } : {}),
            windows: latest.map((sample) => ({
              ...sample.window,
              forecast:
                forecastOf(
                  samples
                    .filter((entry) => entry.window.id === sample.window.id)
                    .map((entry) => ({ at: entry.at, ...pick(entry.window) })),
                ) ?? null,
            })),
          },
        ]
      }),
  }
}

export type QuotaPoller = ReturnType<typeof createQuotaPoller>
export type QuotaReport = ReturnType<QuotaPoller["report"]>

const pick = (window: QuotaWindow) => ({
  used: window.used,
  limit: window.limit,
  remaining: window.remaining,
  resetAt: window.resetAt,
})

/** The provider's own words for a refusal when it gave any (`{error: {message}}`), else its status. */
function providerError(name: string, status: number, body: unknown) {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return typeof message === "string" && message ? `${name} answered ${status}: ${message}` : `${name} answered ${status}`
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
