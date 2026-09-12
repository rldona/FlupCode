import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { t } from "../i18n"
import { PERMISSION_MODES, permissionMode } from "../permission-modes"

type ModeMenuProps = {
  value: string
  onChange: (id: string) => void
}

export const ModeMenu: Component<ModeMenuProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  return (
    <div class="fc-mode" ref={root}>
      <button class="fc-mode-button" type="button" onClick={() => setOpen((value) => !value)}>
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
                classList={{ "fc-mode-item-active": props.value === mode.id }}
                type="button"
                onClick={() => {
                  props.onChange(mode.id)
                  setOpen(false)
                }}
              >
                <span class="fc-mode-item-label">
                  {t(mode.label)}
                  <Show when={mode.id === "auto"}>
                    <span class="fc-mode-badge">{t("Start")}</span>
                  </Show>
                </span>
                <span class="fc-mode-item-desc">{t(mode.description)}</span>
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
