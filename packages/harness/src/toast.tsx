import { For, createSignal, type Component } from "solid-js"

export type ToastVariant = "info" | "success" | "error"

type ToastItem = {
  id: number
  message: string
  variant: ToastVariant
}

const [toasts, setToasts] = createSignal<ToastItem[]>([])
let nextId = 0

export function toast(message: string, variant: ToastVariant = "info") {
  const id = ++nextId
  setToasts((list) => [...list, { id, message, variant }])
  setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4000)
}

export const Toaster: Component = () => (
  <div class="oh-toaster" role="status" aria-live="polite">
    <For each={toasts()}>
      {(item) => (
        <div
          class="oh-toast"
          classList={{
            "oh-toast-success": item.variant === "success",
            "oh-toast-error": item.variant === "error",
          }}
        >
          {item.message}
        </div>
      )}
    </For>
  </div>
)
