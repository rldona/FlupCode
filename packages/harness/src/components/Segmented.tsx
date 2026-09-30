import { Index, type Component } from "solid-js"

export type SegmentedOption = { id: string; label: string; unavailable?: boolean }

type SegmentedProps = {
  /** The id of the heading that names the group. */
  labelledBy: string
  options: SegmentedOption[]
  value: string
  /** While a write is in flight every option waits, but keeps its focus and stays in the tab order. */
  locked?: boolean
  onSelect: (id: string) => void
}

/**
 * A single choice among a few, as a radio group (AH-E06): one Tab stop, the arrows and Home/End walk
 * the available options, and Space or Enter picks the focused one.
 *
 * Focus does not select on its own, unlike a plain radio group: every pick here writes the reader's
 * config file and some open a confirmation, so walking past an option must not write it. An option
 * that cannot be picked is `aria-disabled` rather than `disabled`, so it is still read out with the
 * others and a pick in flight does not throw the focus back to the page.
 */
export const Segmented: Component<SegmentedProps> = (props) => {
  const buttons: HTMLButtonElement[] = []
  const tabStop = () => {
    if (props.options.some((option) => option.id === props.value)) return props.value
    return props.options.find((option) => !option.unavailable)?.id
  }
  const blocked = (option: SegmentedOption) => props.locked === true || option.unavailable === true
  return (
    <div class="fc-adaptive-segments" role="radiogroup" aria-labelledby={props.labelledBy}>
      {/* By position, not by option: every write answers a fresh view, and new nodes would drop the focus. */}
      <Index each={props.options}>
        {(option, index) => (
          <button
            ref={(node) => (buttons[index] = node)}
            class="fc-adaptive-segment"
            type="button"
            role="radio"
            aria-checked={props.value === option().id}
            aria-disabled={blocked(option())}
            tabIndex={tabStop() === option().id ? 0 : -1}
            onClick={() => !blocked(option()) && props.value !== option().id && props.onSelect(option().id)}
            onKeyDown={(event) => {
              const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
              const target = segmentTarget(
                props.options.map((entry) => !entry.unavailable),
                index,
                rtl ? mirrored(event.key) : event.key,
              )
              if (target === undefined) return
              event.preventDefault()
              buttons[target]?.focus()
            }}
          >
            {option().label}
          </button>
        )}
      </Index>
    </div>
  )
}

/**
 * The option a key moves the focus to, or undefined when the key is not a move. `available` says
 * which options can be picked: the arrows skip the others and wrap around, like any radio group.
 */
export function segmentTarget(available: readonly boolean[], current: number, key: string): number | undefined {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0
  const order = available.flatMap((ok, index) => (ok ? [index] : []))
  if (order.length === 0) return undefined
  if (key === "Home") return order[0]
  if (key === "End") return order[order.length - 1]
  if (step === 0) return undefined
  const count = available.length
  const next = Array.from({ length: count }, (_, offset) => (current + step * (offset + 1) + count * count) % count)
  return next.find((index) => available[index])
}

/** In a right-to-left page the arrow keys point the other way along the row. */
function mirrored(key: string) {
  if (key === "ArrowLeft") return "ArrowRight"
  if (key === "ArrowRight") return "ArrowLeft"
  return key
}
