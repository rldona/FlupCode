import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { t } from "../i18n"
import type { Delivery } from "../pending-prompts"

/**
 * What the engine does with a prompt typed while a turn is already running. Both are real engine
 * deliveries: steering promotes the prompt at the next safe boundary of the current turn, so it
 * redirects the work in flight, while queueing holds it until the session would otherwise go idle.
 * FlupCode used to send everything as a steer and label it "Queued", which was the wrong promise.
 */
const OPTIONS: Array<{ id: Delivery; label: string; description: string }> = [
  { id: "steer", label: "Steer", description: "Redirect the turn that is running" },
  { id: "queue", label: "Queue", description: "Wait until the session is done" },
]

export const DeliveryMenu: Component<{ value: Delivery; onChange: (value: Delivery) => void }> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const current = () => OPTIONS.find((option) => option.id === props.value) ?? OPTIONS[0]!

  return (
    <div class="fc-mode fc-delivery" ref={root}>
      <button
        class="fc-mode-button"
        type="button"
        title={t("What happens to a prompt sent while the agent works")}
        onClick={() => setOpen((value) => !value)}
      >
        {t(current().label)}
        <span class="fc-mode-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="fc-mode-popover">
          <div class="fc-mode-title">{t("While the agent works")}</div>
          <For each={OPTIONS}>
            {(option) => (
              <button
                class="fc-mode-item"
                classList={{ "fc-mode-item-active": props.value === option.id }}
                type="button"
                data-delivery={option.id}
                onClick={() => {
                  props.onChange(option.id)
                  setOpen(false)
                }}
              >
                <span class="fc-mode-item-label">{t(option.label)}</span>
                <span class="fc-mode-item-desc">{t(option.description)}</span>
                <Show when={props.value === option.id}>
                  <span class="fc-mode-check">✓</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
