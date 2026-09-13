import { createSignal } from "solid-js"
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage"

/**
 * The usage dashboard counts sessions created from this moment on. Sessions live in the engine and
 * are never touched: resetting only moves this mark, and restoring clears it.
 */
const [usageResetAt, setUsageResetAt] = createSignal<number>(readStorage(STORAGE_KEYS.usageResetAt, 0))

export { usageResetAt }

export function resetUsage() {
  const now = Date.now()
  setUsageResetAt(now)
  writeStorage(STORAGE_KEYS.usageResetAt, now)
}

export function restoreUsage() {
  setUsageResetAt(0)
  writeStorage(STORAGE_KEYS.usageResetAt, 0)
}
