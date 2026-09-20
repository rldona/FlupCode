/**
 * What a run hands to its tasks besides the prompt (H-31).
 *
 * A context pack is a named set of references. The ones that name a file in the project become `file`
 * parts, which the engine reads into the turn; anything else (an artifact, an agent) is kept as text,
 * because there is no part that means it. Resolving that is here, away from the runner's loop.
 */

import { statSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { ContextPack } from "./types"

/** The refs of the named packs, in name order, without repeats. A name nobody saved contributes none. */
export function packRefs(packs: ContextPack[], names: string[] | undefined): string[] {
  if (!names || names.length === 0) return []
  const refs: string[] = []
  for (const name of names) {
    const pack = packs.find((entry) => entry.name === name)
    if (pack) refs.push(...pack.refs)
  }
  return [...new Set(refs)]
}

/**
 * The refs split into files the engine can read and the rest.
 *
 * A file ref is `@src/a.ts`; the leading `@` is the composer's syntax, not part of the path. A ref
 * with a scheme (`@artifact:report`), an absolute path, or a `..` is never opened — it is text.
 */
export function packFiles(refs: string[], directory: string): { files: string[]; others: string[] } {  const root = resolve(directory)
  const files: string[] = []
  const others: string[] = []
  for (const ref of refs) {
    const path = ref.startsWith("@") ? ref.slice(1) : ref
    if (!path || path.includes(":") || path.startsWith("/") || path.includes("..")) {
      others.push(ref)
      continue
    }
    const absolute = resolve(root, path)
    if (!absolute.startsWith(root + sep)) {
      others.push(ref)
      continue
    }
    try {
      if (statSync(absolute).isFile()) {
        files.push(absolute)
        continue
      }
    } catch {
      // A ref that is not there is still worth saying; it may be an artifact or a typo.
    }
    others.push(ref)
  }
  return { files, others }
}

/** What an artifact ref can resolve to: enough to quote it in a prompt (HF-6). */
export type ArtifactQuote = { title: string; kind: string; content?: string }

/**
 * Artifact refs said as their content (HF-6).
 *
 * `@artifact:<id>` names one artifact; `@artifact:<kind>` names the newest of that kind the lookup
 * returns. Anything the lookup cannot answer stays literal, so a typo is visible rather than silent.
 */
export function expandArtifactRefs(refs: string[], lookup: (key: string) => ArtifactQuote | undefined): string[] {
  return refs.map((ref) => {
    if (!ref.startsWith("@artifact:")) return ref
    const key = ref.slice("@artifact:".length).trim()
    if (!key) return ref
    const found = lookup(key)
    if (!found?.content?.trim()) return ref
    return [`--- ${found.title} (${found.kind}) ---`, found.content.trim(), `---`].join("\n")
  })
}
