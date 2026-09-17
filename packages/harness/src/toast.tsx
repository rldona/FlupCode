import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "./i18n"

export type ToastVariant = "info" | "success" | "error"

export type ToastAction = { label: string; run: () => void }

type ToastItem = {
  id: number
  /** The one line that says what happened, in the variant's colour. */
  title: string
  /** What it was, or what to do next: the sentence under the title. */
  description?: string
  variant: ToastVariant
  action?: ToastAction
  /** Replaces the toast with the same key instead of stacking another copy of it. */
  key?: string
}

const [toasts, setToasts] = createSignal<ToastItem[]>([])
let nextId = 0

const dismiss = (id: number) => setToasts((list) => list.filter((item) => item.id !== id))

/**
 * A toast with an action stays until the reader deals with it: those carry something to retry or
 * undo, and four seconds is not long enough to notice one, read it and decide.
 */
export function toast(
  title: string,
  variant: ToastVariant = "info",
  options?: { description?: string; action?: ToastAction; key?: string },
) {
  const id = ++nextId
  const item: ToastItem = {
    id,
    title,
    description: options?.description,
    variant,
    action: options?.action,
    key: options?.key,
  }
  setToasts((list) => [...list.filter((existing) => !item.key || existing.key !== item.key), item])
  if (!item.action) setTimeout(() => dismiss(id), 4000)
  return () => dismiss(id)
}

/** Removes a persistent toast once the condition it reported is gone. */
export function clearToast(key: string) {
  setToasts((list) => list.filter((item) => item.key !== key))
}

/**
 * The mark cut out of the variant's disc. A filled disc in the variant colour with the mark in the
 * surface colour is what reads at a glance and keeps its contrast on every palette.
 */
const MARKS: Record<ToastVariant, string> = {
  success: "m4.7 8.3 2.2 2.2 4.5-4.7",
  error: "M8 4.7v4.4M8 11.5v.01",
  info: "M8 7.2v4.6M8 4.7v.01",
}

const ToastIcon: Component<{ variant: ToastVariant }> = (props) => (
  <svg class="fc-toast-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="8" fill="currentColor" />
    <path
      d={MARKS[props.variant]}
      fill="none"
      stroke="var(--fc-bg-elevated)"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export const Toaster: Component = () => (
  <div class="fc-toaster" role="status" aria-live="polite">
    <For each={toasts()}>
      {(item) => (
        <div class="fc-toast" classList={{ [`fc-toast-${item.variant}`]: true }}>
          <ToastIcon variant={item.variant} />
          <div class="fc-toast-body">
            <span class="fc-toast-title">{item.title}</span>
            <Show when={item.description}>
              {(description) => <span class="fc-toast-description">{description()}</span>}
            </Show>
          </div>
          <Show when={item.action}>
            {(action) => (
              <button
                class="fc-toast-action"
                type="button"
                onClick={() => {
                  dismiss(item.id)
                  action().run()
                }}
              >
                {action().label}
              </button>
            )}
          </Show>
          {/* Always offered, not only on the toasts that wait: reading one should never be a race. */}
          <button class="fc-toast-close" type="button" aria-label={t("Dismiss")} onClick={() => dismiss(item.id)}>
            ×
          </button>
        </div>
      )}
    </For>
  </div>
)
