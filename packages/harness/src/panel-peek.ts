import { createSignal } from "solid-js"

export type PanelPeek = ReturnType<typeof createPanelPeek>

/**
 * Reveals a side panel while the pointer rests on its toggle or inside the panel itself, and keeps
 * it up while focus is inside it, so typing in a revealed panel does not need the pointer parked on
 * it. Clicking the toggle is what pins the panel: a peek never outlives the pointer and the focus.
 */
export function createPanelPeek() {
  const [peeking, setPeeking] = createSignal(false)
  let anchor: HTMLElement | undefined
  let panel: HTMLElement | undefined

  const holds = (node: Node | null | undefined) => !!node && (!!anchor?.contains(node) || !!panel?.contains(node))

  return {
    peeking,
    /** The toggle the pointer rests on to reveal the panel. */
    anchor: (element: HTMLElement) => (anchor = element),
    /** The revealed panel: the pointer may move into it and stay. */
    panel: (element: HTMLElement) => (panel = element),
    show: () => setPeeking(true),
    hide: (event: MouseEvent) => {
      // Moving between the toggle and the panel keeps the peek: only leaving both ends it.
      if (holds(event.relatedTarget as Node | null)) return
      if (panel?.contains(document.activeElement)) return
      setPeeking(false)
    },
    hideUnfocused: () => {
      // Focus leaving the panel ends the peek unless the pointer is still on it.
      if (panel?.matches(":hover")) return
      setPeeking(false)
    },
    /** A click settles the panel for good; the peek must not survive it. */
    clear: () => setPeeking(false),
  }
}
