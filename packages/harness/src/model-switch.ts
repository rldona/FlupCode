import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"

type ModelRef = { providerID: string; id: string }

/** The warning is on until the reader ticks "Don't ask again" in the dialog. */
export function modelSwitchWarningOn() {
  return readStorage(STORAGE_KEYS.confirmModelSwitch, true)
}

export function rememberModelSwitch(skipNextTime: boolean) {
  if (skipNextTime) writeStorage(STORAGE_KEYS.confirmModelSwitch, false)
}

/**
 * The engine reuses what the session already sent to its current model, so switching to another
 * model makes that one re-read the whole transcript on the next message and spend more of the
 * reader's limit. Warn before that happens, but only when there is something to re-read and the
 * session's current model is known: a session with no history switches for free, and a reader who
 * asked not to be told again means it.
 */
export function needsModelSwitchWarning(input: {
  enabled: boolean
  history: boolean
  current: ModelRef | undefined
  next: ModelRef
}) {
  if (!input.enabled || !input.history || !input.current) return false
  return input.current.providerID !== input.next.providerID || input.current.id !== input.next.id
}
