import { createSignal } from "solid-js"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"

/** Most prompts kept; older ones fall off. */
export const PROMPT_HISTORY_LIMIT = 200

/** Adds a sent prompt at the end, moving a repeated one there instead of keeping both. */
export function appendPrompt(history: string[], prompt: string, limit = PROMPT_HISTORY_LIMIT) {
  const text = prompt.trim()
  if (!text) return history
  return [...history.filter((item) => item !== text), text].slice(-limit)
}

/**
 * One step through the history, like a shell: `up` goes to older prompts, `down` to newer ones and,
 * past the newest, back to the draft (`undefined`). `index` is the prompt shown, or undefined for the draft.
 */
export function stepHistory(length: number, index: number | undefined, direction: "up" | "down") {
  if (length === 0) return undefined
  if (direction === "up") return index === undefined ? length - 1 : Math.max(0, index - 1)
  if (index === undefined) return undefined
  return index + 1 >= length ? undefined : index + 1
}

const [history, setHistory] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.promptHistory, []))

export const promptHistory = history

export function recordPrompt(prompt: string) {
  const next = appendPrompt(history(), prompt)
  if (next === history()) return
  setHistory(next)
  writeStorage(STORAGE_KEYS.promptHistory, next)
}
