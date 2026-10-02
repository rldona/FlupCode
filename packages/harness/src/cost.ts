import { t } from "./i18n"
import type { LedgerTokens, MoneyLine, UsageBucket } from "./types"

/**
 * How every cost in the app is written (UL-06, audit §8.4). One module, so the same ledger figure
 * reads the same on the composer, the run card, the session and the Cost screen.
 *
 * A figure is never a bare number. The ledger keeps money per cost basis and billing and never adds
 * them across (UL-05); here each line falls into one of three lenses, each drawn its own way:
 *
 * - **estimated** — a list price (the engine's or FlupCode's) on usage that was paid per use, on this
 *   machine, or by a connection the server could not tell: what it would cost by API. Prefixed `~`,
 *   the app's mark for an estimate.
 * - **measured** — what a provider itself reported. Plain.
 * - **notional** — priced usage of a subscription: value drawn from the plan, not money spent.
 *
 * Rows with no price are counted apart as **unpriced** and never become `$0`. Nothing known at all is
 * a dash.
 */

export type Lens = "estimated" | "measured" | "notional"

export const LENSES: Lens[] = ["estimated", "measured", "notional"]

/** What the app writes where it does not know a figure. */
export const UNKNOWN = "—"

/**
 * Money, to the cent when it is money and to four places when it is not yet.
 *
 * A run that cost $0.0034 shows as $0.00 at two places, which reads as free. It was not free — it is
 * the number that turns into real money once it happens two hundred times.
 */
export function money(value: number) {
  if (value === 0) return "$0"
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/** Which lens a money line belongs to: the subscription decides first, then who priced it. */
export function lensOf(line: MoneyLine): Lens {
  if (line.billing === "subscription") return "notional"
  if (line.basis === "provider-reported") return "measured"
  return "estimated"
}

/** A bucket's money per lens, in the order the app always shows them; empty lenses are left out. */
export function lensTotals(bucket: UsageBucket | undefined) {
  return LENSES.flatMap((lens) => {
    const lines = (bucket?.money ?? []).filter((line) => lensOf(line) === lens)
    if (lines.length === 0) return []
    return [{ lens, usd: lines.reduce((sum, line) => sum + line.usd, 0), lines }]
  })
}

/** A lens's figure as it is drawn: an estimate carries `~`, notional money says so. */
export function lensMoney(lens: Lens, usd: number) {
  if (lens === "estimated") return `~${money(usd)}`
  if (lens === "notional") return t("{amount} notional", { amount: money(usd) })
  return money(usd)
}

export function lensName(lens: Lens | "unpriced") {
  return {
    estimated: t("Estimated"),
    measured: t("Measured"),
    notional: t("Notional"),
    unpriced: t("Unpriced"),
  }[lens]
}

/** What a lens is, in a sentence: the line under its figure on the Cost screen. */
export function lensMeaning(lens: Lens | "unpriced") {
  return {
    estimated: t("What it would cost by API, at list price"),
    measured: t("What a provider reported it charged"),
    notional: t("Covered by a subscription: value drawn, not money spent"),
    unpriced: t("No price for the model, so never counted as $0"),
  }[lens]
}

/** Whose price a line is and how it was paid for: what a figure's basis label says. */
export function basisLabel(line: MoneyLine) {
  const basis = {
    "engine-list-price": t("Engine list price"),
    "flupcode-priced": t("FlupCode price"),
    "provider-reported": t("Reported by the provider"),
  }[line.basis]
  const billing = {
    metered: t("pay per use"),
    subscription: t("subscription"),
    local: t("local model"),
    unknown: t("billing unknown"),
  }[line.billing]
  return `${lensName(lensOf(line))} · ${basis} · ${billing}`
}

/** What the harness spent on a purpose (audit §8.4): why a session was opened. */
export const purposeName = (purpose: string) =>
  ({
    chat: t("Chat"),
    "run-task": t("Run task"),
    handoff: t("Handoff"),
    "commit-message": t("Commit message"),
    suggestion: t("Reply suggestion"),
    adaptive: t("Adaptive"),
    title: t("Title"),
    compaction: t("Compaction"),
  })[purpose] ?? purpose

/** Every token of a bucket, cache included: the ledger counts them all. */
export function tokenCount(tokens: LedgerTokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

/** Whether a bucket says anything at all. A bucket with no rows is unknown, not free. */
export const known = (bucket: UsageBucket | undefined): bucket is UsageBucket => !!bucket && bucket.events > 0

/**
 * A bucket in one line of text, every part named: `~$0.42 · $0.30 notional · 3 unpriced`. A dash
 * when nothing is known. For a title, an aria label or a place with no room for the figure itself.
 */
export function costText(bucket: UsageBucket | undefined) {
  if (!known(bucket)) return UNKNOWN
  const parts = [
    ...lensTotals(bucket).map((entry) => lensMoney(entry.lens, entry.usd)),
    ...(bucket.unpriced.events > 0 ? [t("{n} unpriced", { n: bucket.unpriced.events })] : []),
  ]
  return parts.join(" · ")
}

/** What a bucket's priced money adds up to, used only to rank and to scale bars, never shown. */
export const rankOf = (bucket: UsageBucket) => bucket.money.reduce((sum, line) => sum + line.usd, 0)
