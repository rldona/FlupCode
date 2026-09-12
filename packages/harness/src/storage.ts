export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

export const STORAGE_KEYS = {
  pinnedProjects: "openharness.pinnedProjects",
  displayName: "openharness.displayName",
  sidebarCollapsed: "openharness.sidebarCollapsed",
  serverUrl: "openharness.serverUrl",
  stashedPrompts: "openharness.stashedPrompts",
} as const
