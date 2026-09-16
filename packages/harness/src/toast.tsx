import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "./i18n"

export type ToastVariant = "info" | "success" | "error"

export type ToastAction = { label: string; run: () => void }

type ToastItem = {
  id: number
  message: string
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
  message: string,
  variant: ToastVariant = "info",
  options?: { action?: ToastAction; key?: string },
) {
  const id = ++nextId
  const item: ToastItem = { id, message, variant, action: options?.action, key: options?.key }
  setToasts((list) => [...list.filter((existing) => !item.key || existing.key !== item.key), item])
  if (!item.action) setTimeout(() => dismiss(id), 4000)
  return () => dismiss(id)
}

/** Removes a persistent toast once the condition it reported is gone. */
export function clearToast(key: string) {
  setToasts((list) => list.filter((item) => item.key !== key))
}

export const Toaster: Component = () => (
  <div class="fc-toaster" role="status" aria-live="polite">
    <For each={toasts()}>
      {(item) => (
        <div
          class="fc-toast"
          classList={{
            "fc-toast-success": item.variant === "success",
            "fc-toast-error": item.variant === "error",
          }}
        >
          <span class="fc-toast-message">{item.message}</span>
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
          <Show when={item.action}>
            <button class="fc-toast-close" type="button" aria-label={t("Dismiss")} onClick={() => dismiss(item.id)}>
              ×
            </button>
          </Show>
        </div>
      )}
    </For>
  </div>
)
