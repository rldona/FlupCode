/**
 * Where else skills come from (H-27).
 *
 * The engine reads its own folders; `skills.paths` and `skills.urls` in the configuration add more,
 * a folder on this machine or a URL to fetch from. Writing them is a `PATCH /config`, so the rules
 * about what counts as a source and how the two lists merge live here, away from the form.
 */

export type SkillSources = { paths: string[]; urls: string[] }

export type SkillSourceKind = "path" | "url"

export const EMPTY_SOURCES: SkillSources = { paths: [], urls: [] }

/** Whatever the config holds, as two lists of strings. Anything else is ignored, not guessed at. */
export function normalizeSources(raw: unknown): SkillSources {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SOURCES
  const record = raw as { paths?: unknown; urls?: unknown }
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  return { paths: list(record.paths), urls: list(record.urls) }
}

const deduped = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

/** Adds one, trimmed, and does not add it twice. */
export function addSource(sources: SkillSources, kind: SkillSourceKind, value: string): SkillSources {
  const trimmed = value.trim()
  if (!trimmed) return sources
  return kind === "path"
    ? { ...sources, paths: deduped([...sources.paths, trimmed]) }
    : { ...sources, urls: deduped([...sources.urls, trimmed]) }
}

export function removeSource(sources: SkillSources, kind: SkillSourceKind, value: string): SkillSources {
  return kind === "path"
    ? { ...sources, paths: sources.paths.filter((entry) => entry !== value) }
    : { ...sources, urls: sources.urls.filter((entry) => entry !== value) }
}

export const hasSources = (sources: SkillSources) => sources.paths.length > 0 || sources.urls.length > 0
