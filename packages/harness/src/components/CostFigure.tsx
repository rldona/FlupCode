import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { t } from "../i18n"
import { UNKNOWN, basisLabel, costText, known, lensMoney, lensTotals, money, tokenCount } from "../cost"
import { formatTokens } from "../metrics"
import type { UsageBucket } from "../types"

type CostFigureProps = {
  /** The ledger's figure; undefined while it is not known, which draws a dash. */
  bucket: UsageBucket | undefined
  /** Why there is no figure, for the dash's tooltip. */
  unknownReason?: string
}

/**
 * A cost from the ledger, drawn the one way the app draws costs (UL-06): each lens on its own
 * (estimated `~`, measured, notional, unpriced) and never added across. One click opens the basis
 * of every line — whose price and how it was paid for — so no figure is without its source.
 */
export const CostFigure: Component<CostFigureProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLSpanElement | undefined

  onMount(() => {
    const away = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", away)
    document.addEventListener("keydown", escape)
    onCleanup(() => {
      document.removeEventListener("mousedown", away)
      document.removeEventListener("keydown", escape)
    })
  })

  return (
    <Show
      when={known(props.bucket) ? props.bucket : undefined}
      fallback={
        <span class="fc-cost fc-cost-unknown" title={props.unknownReason ?? t("Nothing recorded")}>
          {UNKNOWN}
        </span>
      }
    >
      {(bucket) => (
        <span class="fc-cost" ref={root}>
          <button
            class="fc-cost-figure"
            type="button"
            aria-expanded={open()}
            aria-label={`${t("Cost")}: ${costText(bucket())}. ${t("Show basis")}`}
            onClick={(event) => {
              // A figure inside a clickable row opens its basis, not the row.
              event.stopPropagation()
              setOpen((value) => !value)
            }}
          >
            <For each={lensTotals(bucket())}>
              {(entry) => (
                <span class="fc-cost-lens" data-lens={entry.lens}>
                  {lensMoney(entry.lens, entry.usd)}
                </span>
              )}
            </For>
            <Show when={bucket().unpriced.events > 0}>
              <span class="fc-cost-lens" data-lens="unpriced">
                {t("{n} unpriced", { n: bucket().unpriced.events })}
              </span>
            </Show>
          </button>
          <Show when={open()}>
            <span class="fc-cost-basis" role="note">
              <For each={bucket().money}>
                {(line) => (
                  <span class="fc-cost-basis-row">
                    <span>{money(line.usd)}</span>
                    <span>{basisLabel(line)}</span>
                  </span>
                )}
              </For>
              <Show when={bucket().unpriced.events > 0}>
                <span class="fc-cost-basis-row">
                  <span>{UNKNOWN}</span>
                  <span>
                    {t("Unpriced · {n} model calls, {tokens} tokens, no price for the model", {
                      n: bucket().unpriced.events,
                      tokens: formatTokens(tokenCount(bucket().unpriced.tokens)),
                    })}
                  </span>
                </span>
              </Show>
            </span>
          </Show>
        </span>
      )}
    </Show>
  )
}
