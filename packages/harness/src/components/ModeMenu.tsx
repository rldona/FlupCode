import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { t } from "../i18n"
import { PERMISSION_MODES, permissionMode } from "../permission-modes"

type ModeMenuProps = {
  value: string
  onChange: (id: string) => void
}

export const ModeMenu: Component<ModeMenuProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  // A mode that grants what the agent would otherwise ask about is picked twice: the first click
  // turns its row into the warning, the second one applies it.
  const [confirming, setConfirming] = createSignal<string>()
  let root: HTMLDivElement | undefined

  const close = () => {
    setOpen(false)
    setConfirming(undefined)
  }

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) close()
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const pick = (mode: (typeof PERMISSION_MODES)[number]) => {
    if (mode.dangerous && confirming() !== mode.id) return setConfirming(mode.id)
    props.onChange(mode.id)
    close()
  }

  return (
    <div class="fc-mode" ref={root}>
      <button class="fc-mode-button" type="button" onClick={() => (open() ? close() : setOpen(true))}>
        {t(permissionMode(props.value).label)}
        <span class="fc-mode-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="fc-mode-popover">
          <div class="fc-mode-title">{t("Mode")}</div>
          <For each={PERMISSION_MODES}>
            {(mode) => (
              <button
                class="fc-mode-item"
                classList={{
                  "fc-mode-item-active": props.value === mode.id,
                  "fc-mode-item-danger": !!mode.dangerous,
                  "fc-mode-item-confirming": confirming() === mode.id,
                }}
                type="button"
                data-mode={mode.id}
                onClick={() => pick(mode)}
              >
                <span class="fc-mode-item-label">
                  {t(mode.label)}
                  <Show when={mode.id === "auto"}>
                    <span class="fc-mode-badge">{t("Start")}</span>
                  </Show>
                </span>
                <span class="fc-mode-item-desc">
                  {confirming() === mode.id ? t("Click again to confirm") : t(mode.description)}
                </span>
                <Show when={props.value === mode.id}>
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
