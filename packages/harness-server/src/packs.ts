/**
 * What a run hands to its tasks besides the prompt (H-31).
 *
 * A context pack is a named set of references. The ones that name a file in the project become `file`
 * parts, which the engine reads into the turn; anything else (an artifact, an agent) is kept as text,
 * because there is no part that means it. Resolving that is here, away from the runner's loop.
 */

import { readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { confinedPath } from "./project-roots"
import type { SqliteRoutineRepository } from "./repository"
import type { Artifact, ArtifactKind, ContextPack } from "./types"

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
export function packFiles(refs: string[], directory: string): { files: string[]; others: string[] } {
  const root = resolve(directory)
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

/** Past this many characters an artifact said in a prompt is cut, and the quote says so (UX-05). */
export const QUOTE_LIMIT = 100_000

/**
 * Artifact refs said as their content (HF-6).
 *
 * `@artifact:<id>` names one artifact; `@artifact:<kind>` names the newest of that kind the lookup
 * returns. Anything the lookup cannot answer stays literal, so a typo is visible rather than silent.
 */
export function expandArtifactRefs(refs: string[], lookup: (key: string) => ArtifactQuote | undefined): string[] {
  return refs.map((ref) => quoteRef(ref, lookup)?.text ?? ref)
}

/** One artifact ref as its quoted content, cut past `QUOTE_LIMIT`; `undefined` when there is none. */
export function quoteRef(ref: string, lookup: (key: string) => ArtifactQuote | undefined) {
  if (!ref.startsWith("@artifact:")) return undefined
  const key = ref.slice("@artifact:".length).trim()
  if (!key) return undefined
  const found = lookup(key)
  const content = found?.content?.trim()
  if (!found || !content) return undefined
  const cut = content.length > QUOTE_LIMIT
  // Blank lines around the content, so a transcript that renders it as Markdown draws the closing
  // `---` as a rule and not as an underline that turns the last line into a heading.
  return {
    text: [
      `--- ${found.title} (${found.kind}) ---`,
      cut ? content.slice(0, QUOTE_LIMIT) : content,
      ...(cut ? [`[Cut: the first ${QUOTE_LIMIT} of ${content.length} characters]`] : []),
      `---`,
    ].join("\n\n"),
    cut,
  }
}

/**
 * What an artifact key names, for a run's packs and the composer's chips alike (HF-6, UX-05): the
 * artifact with that id, or else the newest of that kind in the run, or else in the folder. A
 * document kept by its path is read from disk, as the artifact viewer reads it.
 */
export function artifactQuote(
  repository: Pick<SqliteRoutineRepository, "getArtifact" | "listArtifacts">,
  key: string,
  scope: { runID?: string; directory?: string },
): ArtifactQuote | undefined {
  const kind = key as ArtifactKind
  const found =
    repository.getArtifact(key) ??
    (scope.runID ? repository.listArtifacts({ kind, runID: scope.runID })[0] : undefined) ??
    (scope.directory ? repository.listArtifacts({ kind, directory: scope.directory })[0] : undefined)
  if (!found) return undefined
  return { title: found.title, kind: found.kind, content: found.content ?? fileText(found) }
}

/** A ref as the engine should get it: a file part, a quoted block, or nothing it can find (UX-05). */
export type ResolvedRef =
  | { ref: string; uri: string; name: string }
  | { ref: string; quote: string; cut: boolean }
  | { ref: string; missing: true }

/**
 * The composer's chips resolved on send (UX-05), by the same rules a run's packs follow: a file in
 * the folder becomes a file part the engine reads, an artifact its quoted content. A ref that is
 * neither is reported missing, so the composer can say so before anything is sent.
 */
export function resolveRefs(
  refs: string[],
  directory: string | undefined,
  lookup: (key: string) => ArtifactQuote | undefined,
): ResolvedRef[] {
  return refs.map((ref) => {
    const quoted = quoteRef(ref, lookup)
    if (quoted) return { ref, quote: quoted.text, cut: quoted.cut }
    const file = directory ? packFiles([ref], directory).files[0] : undefined
    if (file) return { ref, uri: pathToFileURL(file).href, name: ref.replace(/^@/, "") }
    return { ref, missing: true as const }
  })
}

/** A document's text from disk: only text, only inside its folder, and nothing when it is gone. */
function fileText(artifact: Artifact) {
  if (!artifact.path || !artifact.directory || !/^(text\/|application\/(json|xml))/.test(artifact.mime)) return undefined
  const full = confinedPath(artifact.directory, artifact.path)
  if (!full) return undefined
  try {
    return readFileSync(full, "utf8")
  } catch {
    return undefined
  }
}
