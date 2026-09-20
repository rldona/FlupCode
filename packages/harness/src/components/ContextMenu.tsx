import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { cssPx } from "../text-size"

export type MenuItem = {
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

type ContextMenuProps = {
  /** Viewport pixels, as from pointer events or getBoundingClientRect(). */
  x: number
  y: number
  /** Preferred side. The menu flips to the other one when this side has no room. */
  placement?: "below" | "above"
  /** Viewport pixels; defaults to the menu's own width. */
  width?: number
  items: MenuItem[]
  onClose: () => void
}

/** Keeps the menu this far from every window edge. */
const MARGIN = 8

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const close = () => props.onClose()
  let element: HTMLDivElement | undefined
  const [placed, setPlaced] = createSignal<{ left: number; top: number }>()

  // A menu opened at the pointer runs off the bottom when the pointer is near it, and a session row
  // low in the sidebar is exactly that. Prefer the caller's side, flip when it does not fit, and
  // keep the whole menu inside the window either way.
  const place = () => {
    if (!element) return
    // Layout size, not the bounding box: the drop-in animation transforms the box while it runs.
    const width = props.width ?? element.offsetWidth
    const height = element.offsetHeight
    const requested = props.placement ?? "below"
    const roomBelow = window.innerHeight - props.y
    const roomAbove = props.y
    const placement =
      requested === "below" && roomBelow < height + MARGIN && roomAbove > roomBelow
        ? "above"
        : requested === "above" && roomAbove < height + MARGIN && roomBelow > roomAbove
          ? "below"
          : requested
    const top =
      placement === "above"
        ? Math.max(MARGIN, props.y - height)
        : Math.min(props.y, Math.max(MARGIN, window.innerHeight - MARGIN - height))
    const left = Math.min(
      Math.max(MARGIN, props.x),
      Math.max(MARGIN, window.innerWidth - MARGIN - width),
    )
    setPlaced({ left, top })
  }

  onMount(() => {
    place()
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest(".fc-menu")) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div
      ref={(node) => (element = node)}
      class="fc-menu"
      style={{
        left: `${cssPx(placed()?.left ?? props.x)}px`,
        top: `${cssPx(placed()?.top ?? props.y)}px`,
        // Hidden for the one frame it takes to measure, so it never flashes at the wrong corner.
        visibility: placed() ? "visible" : "hidden",
        ...(props.width ? { width: `${cssPx(props.width)}px` } : {}),
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={props.items}>
        {(item) => (
          <button
            class="fc-menu-item"
            classList={{ "fc-menu-item-danger": item.danger }}
            type="button"
            disabled={item.disabled}
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
