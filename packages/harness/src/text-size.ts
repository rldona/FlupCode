import { createSignal } from "solid-js"
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage"

export const TEXT_SIZES = [
  { id: "small", label: "Small", scale: 0.9 },
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.1 },
  { id: "xlarge", label: "Extra large", scale: 1.25 },
] as const

export type TextSize = (typeof TEXT_SIZES)[number]["id"]

const scaleOf = (id: string) => TEXT_SIZES.find((size) => size.id === id)?.scale ?? 1

const [appTextSize, setAppTextSizeSignal] = createSignal<string>(readStorage(STORAGE_KEYS.appTextSize, "default"))
const [chatTextSize, setChatTextSizeSignal] = createSignal<string>(readStorage(STORAGE_KEYS.chatTextSize, "default"))

export { appTextSize, chatTextSize }

// The app size zooms the whole page; the chat size zooms the transcript on top of it.
function apply() {
  if (typeof document === "undefined") return
  const root = document.documentElement
  const app = scaleOf(appTextSize())
  root.style.zoom = app === 1 ? "" : String(app)
  root.style.setProperty("--fc-chat-zoom", String(scaleOf(chatTextSize())))
}

apply()

export function setAppTextSize(id: string) {
  setAppTextSizeSignal(id)
  writeStorage(STORAGE_KEYS.appTextSize, id)
  apply()
}

export function setChatTextSize(id: string) {
  setChatTextSizeSignal(id)
  writeStorage(STORAGE_KEYS.chatTextSize, id)
  apply()
}

/**
 * Pointer coordinates and getBoundingClientRect() are viewport pixels, while inline `left`/`width`
 * values are scaled by the page zoom: convert before positioning or sizing with them.
 */
export const cssPx = (viewportPx: number) => viewportPx / scaleOf(appTextSize())
