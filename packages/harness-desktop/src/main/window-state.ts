import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { decodeWindowStates, type WindowBounds } from "./window-bounds"

/**
 * Where the windows were (H-36).
 *
 * One entry per window, not one for the app: with several windows open, a single set of bounds is
 * the last one to close, and every window then reopens on top of the others. An older file held a
 * single object and is still read.
 */

function stateFile() {
  return join(app.getPath("userData"), "window-state.json")
}

export function loadWindowStates(): WindowBounds[] {
  try {
    if (!existsSync(stateFile())) return []
    return decodeWindowStates(JSON.parse(readFileSync(stateFile(), "utf8")))
  } catch {
    return []
  }
}

export function saveWindowState(index: number, bounds: WindowBounds) {
  try {
    const states = loadWindowStates()
    states[index] = bounds
    writeFileSync(stateFile(), JSON.stringify(states))
  } catch {
    return
  }
}

export { DEFAULT_BOUNDS, type WindowBounds } from "./window-bounds"
