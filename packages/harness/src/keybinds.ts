/**
 * Editable keyboard shortcuts (H-24).
 *
 * A binding is `mod+shift+alt+key`, in any order, where `mod` is Cmd on macOS and Ctrl elsewhere.
 * Pure functions over strings, so the matching and formatting can be tested without a keyboard.
 */

export type KeybindAction =
  | "palette"
  | "newSession"
  | "toggleSidebar"
  | "toggleContextPanel"
  | "settings"
  | "compact"
  | "split"

export type Keybinds = Record<KeybindAction, string>

/** The bindings a fresh install has. An empty string means the action has no key. */
export const DEFAULT_KEYBINDS: Keybinds = {
  palette: "mod+k",
  toggleSidebar: "mod+b",
  toggleContextPanel: "mod+alt+b",
  settings: "mod+,",
  newSession: "",
  compact: "",
  split: "",
}

/** The actions offered in Settings, in the order they are listed. */
export const KEYBIND_ACTIONS: KeybindAction[] = [
  "palette",
  "newSession",
  "toggleSidebar",
  "toggleContextPanel",
  "settings",
  "compact",
  "split",
]

export type KeyEventLike = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** The parts of a binding, in a fixed order: mod, alt, shift, then the key. */
export function normalizeKeybind(binding: string): string {
  const parts = binding
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  const key = parts.filter((part) => !["mod", "alt", "shift"].includes(part)).at(-1)
  if (!key) return ""
  return [parts.includes("mod") ? "mod" : "", parts.includes("alt") ? "alt" : "", parts.includes("shift") ? "shift" : "", key]
    .filter(Boolean)
    .join("+")
}

/** Whether this event is exactly the binding: every modifier matches, and no extra one is held. */
export function matchesKeybind(binding: string, event: KeyEventLike): boolean {
  const parts = normalizeKeybind(binding).split("+")
  const key = parts.at(-1)
  if (!key) return false
  if (event.key.toLowerCase() !== key) return false
  const mod = event.metaKey || event.ctrlKey
  if (parts.includes("mod") !== mod) return false
  if (parts.includes("alt") !== event.altKey) return false
  if (parts.includes("shift") !== event.shiftKey) return false
  return true
}

/** A binding as a person reads it: `mod+k` is `⌘K`. */
export function formatKeybind(binding: string): string {
  const parts = normalizeKeybind(binding).split("+")
  if (parts.length === 0 || parts[0] === "") return ""
  const symbols: Record<string, string> = { mod: "⌘", alt: "⌥", shift: "⇧" }
  return parts.map((part) => symbols[part] ?? part.toUpperCase()).join("")
}

/**
 * Sets one action's binding, and nothing else's.
 *
 * A binding is one action's: taking one that another action holds clears the other, so two actions
 * never fire on the same key and there is no invisible conflict to debug.
 */
export function withKeybind(bindings: Keybinds, action: KeybindAction, binding: string): Keybinds {
  const next: Keybinds = { ...bindings, [action]: binding }
  if (!binding) return next
  for (const other of KEYBIND_ACTIONS) {
    if (other !== action && next[other] === binding) next[other] = ""
  }
  return next
}

/** The binding a key event would make, or undefined for a bare modifier. */
export function keybindFromEvent(event: KeyEventLike): string | undefined {
  const key = event.key.toLowerCase()
  if (["meta", "control", "alt", "shift"].includes(key)) return undefined
  return normalizeKeybind(
    [event.metaKey || event.ctrlKey ? "mod" : "", event.altKey ? "alt" : "", event.shiftKey ? "shift" : "", key].join(
      "+",
    ),
  )
}

/** The stored bindings, with defaults for anything unset and an old palette key carried over. */
export function loadKeybinds(stored: Partial<Keybinds> | undefined, legacyPaletteKey?: string): Keybinds {
  const next = { ...DEFAULT_KEYBINDS, ...(stored ?? {}) }
  // The palette key used to be stored on its own; keep it until the map replaces it.
  if (legacyPaletteKey && !stored?.palette) next.palette = legacyPaletteKey
  return next
}
