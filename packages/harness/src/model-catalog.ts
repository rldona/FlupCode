import type { ModelInfo } from "./engine-types"

type ModelRef = { providerID: string; id: string }

/** The key a model is named by, in favourites and in `provider/model`: the same shape a policy uses. */
export function modelKey(model: ModelRef) {
  return `${model.providerID}/${model.id}`
}

/**
 * The catalog as a picker draws it: what the search kept, grouped by provider, with favourites
 * first and models on their way out below the ones still being released.
 *
 * Shared so a second picker cannot order the same catalog differently — H-44's best-of-n picks
 * several models at once and has to agree with the one that picks a single one.
 */
export function groupedModels(models: ModelInfo[], query: string, favorites: string[]) {
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? models.filter((model) => `${model.name} ${model.id} ${model.providerID}`.toLowerCase().includes(needle))
    : models
  const byProvider = new Map<string, ModelInfo[]>()
  for (const model of filtered) {
    byProvider.set(model.providerID, [...(byProvider.get(model.providerID) ?? []), model])
  }
  return [...byProvider.entries()].map(([providerID, items]) => ({
    providerID,
    items: [...items].sort((a, b) => {
      const aFav = favorites.includes(modelKey(a)) ? 0 : 1
      const bFav = favorites.includes(modelKey(b)) ? 0 : 1
      if (aFav !== bFav) return aFav - bFav
      if (isDeprecated(a) !== isDeprecated(b)) return isDeprecated(a) ? 1 : -1
      return a.name.localeCompare(b.name)
    }),
  }))
}

/** The engine drops a model from its catalog; a session pinned to it fails on its next turn. */
export function hasModel(models: ModelInfo[], ref: ModelRef | undefined) {
  if (!ref) return false
  return models.some((model) => model.providerID === ref.providerID && model.id === ref.id)
}

/** Deprecated models still run, but they are on their way out and the engine no longer suggests them. */
export function isDeprecated(model: Pick<ModelInfo, "status">) {
  return model.status === "deprecated"
}

/**
 * Closest replacement for a model the catalog dropped, staying inside the same provider: another
 * one may not even be connected, and its cost and limits are not the reader's. Candidates share a
 * name fragment with the retired id, closest name first, and a deprecated model never replaces one.
 */
export function replacementModel(ref: ModelRef, models: ModelInfo[]) {
  const wanted = tokens(ref.id)
  const [best] = models
    .filter((model) => model.providerID === ref.providerID && !isDeprecated(model))
    .map((model) => ({ model, score: matchScore(wanted, model.id) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        lengthDelta(a.model.id, ref.id) - lengthDelta(b.model.id, ref.id) ||
        b.model.time.released - a.model.time.released,
    )
  return best?.model
}

const tokens = (id: string) =>
  id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const lengthDelta = (a: string, b: string) => Math.abs(a.length - b.length)

function matchScore(wanted: string[], id: string) {
  const parts = new Set(tokens(id))
  // Weighing fragments by length keeps this free of a per-provider table: the family part of the
  // name ("flash") then counts for more than a version shared with it ("v4").
  return wanted.filter((token) => parts.has(token)).reduce((total, token) => total + token.length, 0)
}
