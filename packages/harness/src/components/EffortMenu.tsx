import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { ModelVariant } from "../engine-types"
import { t } from "../i18n"
import { effortLabel } from "../effort"

type EffortMenuProps = {
  value: string | undefined
  variants: ModelVariant[]
  disabled?: boolean
  onChange: (id: string) => void
}

export const EffortMenu: Component<EffortMenuProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const steps = () => ["", ...props.variants.map((variant) => variant.id)]
  const index = () => Math.max(0, steps().indexOf(props.value ?? ""))
  const current = () => (props.value ? effortLabel(props.value) : t("Default"))

  return (
    <div class="fc-effort" ref={root}>
      <button
        class="fc-effort-button"
        type="button"
        disabled={props.disabled || props.variants.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        {current()}
        <span class="fc-mode-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="fc-effort-popover">
          <div class="fc-effort-head">
            <span class="fc-effort-title">{t("Effort")}</span>
            <span class="fc-effort-value">{current()}</span>
          </div>
          <div class="fc-effort-ends">
            <span>{t("Faster")}</span>
            <span>{t("Smarter")}</span>
          </div>
          <div class="fc-effort-track">
            <span class="fc-effort-dots" aria-hidden="true">
              <For each={steps()}>{() => <span />}</For>
            </span>
            <input
              class="fc-effort-range"
              aria-label={t("Effort")}
              type="range"
              min="0"
              max={Math.max(0, steps().length - 1)}
              step="1"
              value={index()}
              onInput={(event) => props.onChange(steps()[Number(event.currentTarget.value)] ?? "")}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
