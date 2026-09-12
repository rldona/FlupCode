import { For, Show, onCleanup, onMount, type Component } from "solid-js"

export type MenuItem = {
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean
  onSelect: () => void
}

type ContextMenuProps = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const close = () => props.onClose()

  onMount(() => {
    const onDown = () => close()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div
      class="fc-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={props.items}>
        {(item) => (
          <button
            class="fc-menu-item"
            classList={{ "fc-menu-item-danger": item.danger }}
            type="button"
            onClick={() => {
              item.onSelect()
              close()
            }}
          >
            <span class="fc-menu-icon">{item.icon ?? ""}</span>
            <span class="fc-menu-label">{item.label}</span>
            <Show when={item.shortcut}>
              <span class="fc-menu-shortcut">{item.shortcut}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}
