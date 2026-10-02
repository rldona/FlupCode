import type { Engine } from "./engine"
import type { SqliteRoutineRepository } from "./repository"
import type { Billing, UsageEvent } from "./usage-ledger"

/**
 * What a ledger row's money is (UL-05, audit §8.4 "Tres lentes de dinero").
 *
 * The engine prices every step at its list price and says nothing else: a model nobody priced is
 * reported at $0, the same as a free one, and a step paid by a subscription carries the same cost as
 * one paid per token. The server can tell some of that apart from what the engine says now:
 *
 * - **Cost basis.** A model whose `ModelInfo.cost` is empty has no price; its $0 rows are unpriced.
 *   A free model lists a $0 tier and stays priced at $0. A row with a cost had a price when it ran.
 * - **Billing.** A provider calling a loopback host is `local`. Otherwise its integration's
 *   connections decide: a key (stored or from the environment, or one in the provider's config) is
 *   `metered`; an OAuth sign-in is a `subscription` only for the integrations whose sign-in is a plan
 *   (below). Any other OAuth sign-in, several connections that disagree, or no connection at all is
 *   `unknown`, because the engine does not say which one paid.
 *
 * Billing is about the connection when the row happened, which the engine does not record. So a row
 * is billed only when it happened while the server was watching that same connection (refreshed
 * every `ttlMs`, with that much slack on each side); a backfilled row from before stays `unknown`.
 */
export function createUsagePricing(input: {
  engine: Pick<Engine, "usageCatalog">
  repository: Pick<SqliteRoutineRepository, "markUnpriced">
  ttlMs?: number
  now?: () => number
}) {
  const ttl = input.ttlMs ?? 60_000
  const now = input.now ?? Date.now
  const catalogs = new Map<string, { at: number; catalog: Promise<UsageCatalog | undefined> }>()
  // Per folder and provider: the billing its connections give, and when that was first and last seen.
  const watched = new Map<string, { billing: Billing; first: number; last: number }>()
  const unpriced = new Set<string>()

  const observe = (directory: string, catalog: UsageCatalog) => {
    const at = now()
    for (const provider of catalog.providers) {
      const key = `${directory}\0${provider.providerID}`
      const billing = billingOf(catalog, provider.providerID)
      const seen = watched.get(key)
      if (seen && seen.billing === billing) seen.last = at
      else watched.set(key, { billing, first: at, last: at })
    }
    // Rows stored before the server knew the model has no price are re-labelled once per model.
    const fresh = catalog.models.filter(
      (model) => !model.priced && !unpriced.has(`${model.providerID}\0${model.modelID}`),
    )
    for (const model of fresh) unpriced.add(`${model.providerID}\0${model.modelID}`)
    input.repository.markUnpriced(fresh)
  }

  const catalogFor = (directory = "") => {
    const cached = catalogs.get(directory)
    if (cached && now() - cached.at < ttl) return cached.catalog
    // An engine that cannot answer leaves the rows as they came, and is asked again after `ttlMs`.
    const catalog = input.engine.usageCatalog(directory || undefined).then(
      (answer) => {
        observe(directory, answer)
        return answer
      },
      () => undefined,
    )
    catalogs.set(directory, { at: now(), catalog })
    return catalog
  }

  return {
    /** The events with their basis and billing as the server can tell them; the rest unchanged. */
    classify: async <T extends UsageEvent>(events: T[]) => {
      const out: T[] = []
      for (const event of events) {
        const catalog = await catalogFor(event.directory)
        out.push(
          catalog
            ? priced(billed(event, watched.get(`${event.directory ?? ""}\0${event.providerID}`), ttl), catalog)
            : event,
        )
      }
      return out
    },
  }
}

export type UsageCatalog = Awaited<ReturnType<Engine["usageCatalog"]>>

/**
 * Integrations whose sign-in is a subscription plan on the pinned engine (2.0.18): GitHub Copilot
 * (any connection: Copilot has no pay-per-token plan), ChatGPT Pro/Plus and SuperGrok by OAuth. Their
 * other OAuth sign-ins elsewhere (DigitalOcean, Snowflake, GitLab, Poe, the OpenCode console) may be
 * an account billed per use or a plan, and are left unknown.
 */
const SUBSCRIPTION_SIGN_IN: Record<string, "any" | "oauth"> = {
  "github-copilot": "any",
  openai: "oauth",
  xai: "oauth",
}

/** How a provider's calls are paid for, as far as its connections tell. */
export function billingOf(catalog: UsageCatalog, providerID: string): Billing {
  const provider = catalog.providers.find((entry) => entry.providerID === providerID)
  if (!provider) return "unknown"
  if (provider.baseURL && isLoopback(provider.baseURL)) return "local"
  const integrationID = provider.integrationID ?? providerID
  const connections = catalog.integrations.find((entry) => entry.integrationID === integrationID)?.connections ?? []
  const billings = new Set(connections.map((method) => connectionBilling(integrationID, method)))
  if (billings.size === 1) return [...billings][0]!
  if (billings.size > 1) return "unknown"
  if (SUBSCRIPTION_SIGN_IN[integrationID] === "any") return "subscription"
  return provider.configKey ? "metered" : "unknown"
}

function connectionBilling(integrationID: string, method: "key" | "oauth" | "env"): Billing {
  const plan = SUBSCRIPTION_SIGN_IN[integrationID]
  if (plan === "any" || (plan === "oauth" && method === "oauth")) return "subscription"
  return method === "oauth" ? "unknown" : "metered"
}

function priced<T extends UsageEvent>(event: T, catalog: UsageCatalog): T {
  if (event.costBasis !== "engine-list-price" || (event.costUSD ?? 0) > 0) return event
  const model = catalog.models.find((entry) => entry.providerID === event.providerID && entry.modelID === event.modelID)
  if (!model || model.priced) return event
  const { costUSD: _reported, ...rest } = event
  return { ...rest, costBasis: "unpriced" } as T
}

function billed<T extends UsageEvent>(
  event: T,
  seen: { billing: Billing; first: number; last: number } | undefined,
  slack: number,
): T {
  const at = event.endedAt ?? event.startedAt
  if (event.billing !== "unknown" || !seen || seen.billing === "unknown" || at === undefined) return event
  if (at < seen.first - slack || at > seen.last + slack) return event
  return { ...event, billing: seen.billing }
}

function isLoopback(url: string) {
  const host = URL.parse(url)?.hostname.replace(/^\[|\]$/g, "")
  if (!host) return false
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host === "0.0.0.0"
  )
}
