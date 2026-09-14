import type { MemoryInfo } from "@opencode-ai/sdk/v2/client"

/** User-facing scope name: global memory belongs to the user, not a project. */
export const memoryScopeLabel = (scope: MemoryInfo["scope"]) => (scope === "global" ? "user" : scope)

export const memoryConfidenceLabel = (value: number) => `${Math.round(value * 100)}%`

export const formatMemoryTime = (value?: number) => (value === undefined ? "-" : new Date(value).toLocaleString())

export type MemoryFilters = {
  text?: string
  scope?: MemoryInfo["scope"] | "all"
  status?: MemoryInfo["status"] | "all"
}

/** Deterministic client-side filtering for the manager list. */
export function filterMemories(items: ReadonlyArray<MemoryInfo>, filters: MemoryFilters): MemoryInfo[] {
  const needle = filters.text?.trim().toLowerCase()
  return items.filter((memory) => {
    if (filters.scope && filters.scope !== "all" && memory.scope !== filters.scope) return false
    if (filters.status && filters.status !== "all" && memory.status !== filters.status) return false
    if (!needle) return true
    return `${memory.title} ${memory.content} ${memory.tags.join(" ")}`.toLowerCase().includes(needle)
  })
}

export const pendingCandidates = (items: ReadonlyArray<MemoryInfo>) =>
  items.filter((memory) => memory.status === "candidate").length
