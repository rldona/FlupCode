import { Show, createContext, onCleanup, onMount, useContext, type JSX } from "solid-js"
import { t } from "../i18n"
import { holdModalFocus } from "../modal-focus"
import { Icon } from "./Icon"

type ModalProps = {
  /** Shown while true. Leave it out when a `<Show>` around the modal already decides that. */
  open?: boolean
  /** Escape, a click on the backdrop and the close button all end here. */
  onClose?: () => void
  /** The dialog's accessible name. */
  label: string
  describedBy?: string
  /** `alertdialog` for a dialog that only reports something and waits to be read. */
  role?: "dialog" | "alertdialog"
  /** The panel's classes; the backdrop's, for the sheets that rise from the bottom. */
  class?: string
  backdropClass?: string
  /**
   * A step that has to be answered, such as the first-run welcome before a server is connected:
   * neither Escape nor a click outside closes it. It still holds the focus.
   */
  required?: boolean
  /** Where the focus goes back to on close, when that is not simply what had it before. */
  returnFocus?: () => HTMLElement | null | undefined
  /** Keys the dialog answers itself, such as Enter to confirm. */
  onKeyDown?: JSX.EventHandler<HTMLDivElement, KeyboardEvent>
  children: JSX.Element
}

/**
 * The app's one dialog (UX-03).
 *
 * Every dialog behaves the same from the keyboard because they are all this: the focus moves into it
 * as it opens and back to what opened it as it closes, Tab and Shift+Tab stay inside it, and Escape
 * closes the one on top, in any language (it calls `onClose`, rather than looking for a button by
 * its label). A field that uses Escape for itself first, such as a key being recorded or a list of
 * suggestions, keeps it by calling `preventDefault`.
 *
 * It plays its own exit: a closed dialog is gone from the page at once, and a copy of it, hidden from
 * assistive technology and from the pointer, fades out where it was. The motion comes from the motion
 * tokens, so reduced motion is honoured where they are defined.
 */
export function Modal(props: ModalProps) {
  return (
    <Show when={props.open ?? true}>
      <ModalLayer {...props} />
    </Show>
  )
}

const CloseContext = createContext<() => void>()

/** The labelled close button, for a dialog's header. It closes the dialog it is in. */
export function ModalClose(props: { class?: string; title?: string; onClick?: () => void }) {
  const close = useContext(CloseContext)
  return (
    <button
      class={props.class ?? "fc-icon-button"}
      type="button"
      aria-label={t("Close")}
      title={props.title}
      onClick={() => (props.onClick ?? close)?.()}
    >
      <Icon name="close" />
    </button>
  )
}

/** The dialogs open now, oldest first: the keyboard belongs to the last one. */
const layers: Array<{ panel: HTMLElement; close: () => void }> = []

/** Whether a dialog is open: a screen that leaves on Escape leaves that Escape to it. */
export function modalOpen() {
  return layers.length > 0
}

function ModalLayer(props: ModalProps) {
  let backdrop: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined
  const close = () => {
    if (!props.required) props.onClose?.()
  }

  onMount(() => {
    if (!backdrop || !panel) return
    const layer = { panel, close }
    layers.push(layer)
    if (layers.length === 1) window.addEventListener("keydown", onKey)
    const release = holdModalFocus(panel, props.returnFocus)
    const leaving = backdrop
    const held = holdFocusThroughRenders(layer)
    onCleanup(() => {
      held.disconnect()
      layers.splice(layers.indexOf(layer), 1)
      if (layers.length === 0) window.removeEventListener("keydown", onKey)
      release()
      playExit(leaving)
    })
  })

  return (
    <CloseContext.Provider value={close}>
      <div ref={backdrop} class={props.backdropClass ?? "fc-modal-backdrop"} data-modal="open" onClick={close}>
        <div
          ref={panel}
          class={props.class ?? "fc-modal"}
          role={props.role ?? "dialog"}
          aria-modal="true"
          aria-label={props.label}
          aria-describedby={props.describedBy}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => props.onKeyDown?.(event)}
        >
          {props.children}
        </div>
      </div>
    </CloseContext.Provider>
  )
}

/** What a key does to the dialog on top. Listened for on the window, after everything inside has had it. */
function onKey(event: KeyboardEvent) {
  const top = layers.at(-1)
  if (!top) return
  if (closesModal(event)) {
    event.preventDefault()
    top.close()
    return
  }
  if (event.key !== "Tab") return
  const focusable = focusables(top.panel)
  const active = document.activeElement
  const target = trapTarget(focusable.length, focusable.indexOf(active as HTMLElement), event.shiftKey)
  if (target === undefined) return
  event.preventDefault()
  ;(focusable[target] ?? top.panel).focus()
}

/**
 * A dialog whose content renders again (a list whose results arrive late, say) can remove the very
 * control that has the focus, and the browser then hands the focus to the page behind the dialog.
 * This puts it back, on the control that now stands where the removed one was, or on the dialog.
 */
function holdFocusThroughRenders(layer: { panel: HTMLElement }) {
  let place = -1
  layer.panel.addEventListener("focusin", (event) => {
    place = focusables(layer.panel).indexOf(event.target as HTMLElement)
  })
  const observer = new MutationObserver(() => {
    if (layers.at(-1) !== layer) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const list = focusables(layer.panel)
    ;(list[restoreTarget(place, list.length)] ?? layer.panel).focus({ preventScroll: true })
  })
  observer.observe(layer.panel, { childList: true, subtree: true })
  return observer
}

/** The control to put a lost focus back on: the one now at the same place, or the last one. -1 for none. */
export function restoreTarget(place: number, count: number) {
  if (place < 0 || count === 0) return -1
  return Math.min(place, count - 1)
}

function focusables(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node.getClientRects().length > 0,
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Escape closes a dialog unless something inside used it first, or it ends an input method's
 * composition (a Japanese or Chinese word being typed). `key` is "Escape" on every keyboard layout.
 */
export function closesModal(event: Pick<KeyboardEvent, "key" | "isComposing" | "defaultPrevented">) {
  return event.key === "Escape" && !event.isComposing && !event.defaultPrevented
}

/**
 * Where Tab sends the focus so it stays inside the dialog: the index of the control to focus, -1 for
 * the dialog itself (it has nothing to focus), or undefined when the browser's own step stays inside.
 * `index` is -1 when the focus is on the dialog itself or outside it.
 */
export function trapTarget(count: number, index: number, backward: boolean) {
  if (count === 0) return -1
  if (index === -1) return backward ? count - 1 : 0
  if (backward && index === 0) return count - 1
  if (!backward && index === count - 1) return 0
  return undefined
}

/**
 * Plays a closed dialog's exit on a copy of it. The copy goes in the app's root, so it keeps the
 * layout variables and zoom, and is removed when its animations end: at once under reduced motion,
 * where the motion tokens are zero.
 */
function playExit(backdrop: HTMLElement) {
  // A hidden page plays no animation until it is shown again: there is nothing to see, so no copy.
  if (!backdrop.isConnected || document.hidden) return
  const ghost = backdrop.cloneNode(true) as HTMLElement
  ghost.dataset.modal = "closing"
  ghost.setAttribute("aria-hidden", "true")
  ghost.inert = true
  // A copy does not carry what was typed or ticked, only the markup: put it back so nothing blinks.
  const fields = backdrop.querySelectorAll<HTMLInputElement>("input, textarea, select")
  ghost.querySelectorAll<HTMLInputElement>("input, textarea, select").forEach((field, index) => {
    const source = fields[index]
    if (!source) return
    field.value = source.value
    field.checked = source.checked
  })
  ghost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"))
  ;(document.querySelector(".fc-app") ?? document.body).append(ghost)
  void Promise.allSettled(ghost.getAnimations({ subtree: true }).map((animation) => animation.finished)).then(() =>
    ghost.remove(),
  )
}
