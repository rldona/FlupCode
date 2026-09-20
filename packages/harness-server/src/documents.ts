/**
 * Documents the agent produced and kept (H-14).
 *
 * A plan is a file the agent wrote; so is a report turned into a page, an image, or a PDF. Those
 * live under `.flupcode/artifacts/` in the project — the one folder the reader can point at and say
 * "generated documents go here" — and nothing registers them, for the same reason nothing registered
 * plans: the harness never produced them.
 *
 * Registration is lazy, exactly like plans: it happens while somebody is looking at the artifacts of
 * a folder, which is when a document is worth indexing and the only time the folder is known. Text
 * that fits is kept inline so it can be read and searched; anything else (an image, a PDF, a page
 * too large to hold) is kept as a path, and the raw route serves it.
 *
 * The agent can also declare one directly with the `artifact.write` tool, which writes the document
 * into the same folder — so there is one place documents live and one pass that finds them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join, relative } from "node:path"
import { artifactHash, type ArtifactRepository } from "./repository"
import type { Artifact } from "./types"

/** Where a project's generated documents live. */
const DOCUMENTS_DIRECTORY = join(".flupcode", "artifacts")

/** Documents at or below this are kept in full; anything larger is served from its path. */
const MAX_INLINE = 256 * 1024

type DocumentType = { mime: string; text: boolean }

/**
 * The kinds of file that count as a document. The list is an allowlist on purpose: a page that ships
 * with its own `style.css` and `app.js` should not turn every asset into a row in the list.
 */
const TYPES: Record<string, DocumentType> = {
  ".md": { mime: "text/markdown", text: true },
  ".markdown": { mime: "text/markdown", text: true },
  ".html": { mime: "text/html", text: true },
  ".htm": { mime: "text/html", text: true },
  ".txt": { mime: "text/plain", text: true },
  ".log": { mime: "text/plain", text: true },
  ".csv": { mime: "text/csv", text: true },
  ".json": { mime: "application/json", text: true },
  ".svg": { mime: "image/svg+xml", text: true },
  ".pdf": { mime: "application/pdf", text: false },
  ".png": { mime: "image/png", text: false },
  ".jpg": { mime: "image/jpeg", text: false },
  ".jpeg": { mime: "image/jpeg", text: false },
  ".webp": { mime: "image/webp", text: false },
  ".gif": { mime: "image/gif", text: false },
}

export function documentType(name: string): DocumentType | undefined {
  return TYPES[extname(name).toLowerCase()]
}

export type LocalDocument = {
  /** Relative to the project directory, so the raw route can resolve it back. */
  path: string
  title: string
  mime: string
  /** Present only when the document is text and fits in `MAX_INLINE`. */
  content?: string
  /** Identity of what was found, so the same document read twice adds nothing (H-14). */
  hash: string
}

/** The first heading, `<title>`, or the file's name: enough to recognise a document in a list. */
function titleOf(content: string | undefined, mime: string, path: string) {
  if (content !== undefined) {
    if (mime === "text/html") {
      const captured = /<title[^>]*>([^<]+)<\/title>/i.exec(content)?.[1]
      if (captured?.trim()) return captured.trim()
    }
    const heading = content.split("\n").find((line) => /^#\s+\S/.test(line))
    if (heading) return heading.replace(/^#\s+/, "").trim()
  }
  return basename(path).replace(/\.[^.]+$/, "")
}

function walk(root: string, at: string, out: LocalDocument[]) {
  const entries = (() => {
    try {
      return readdirSync(at, { withFileTypes: true })
    } catch {
      return undefined
    }
  })()
  if (!entries) return
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(at, entry.name)
    if (entry.isDirectory()) {
      walk(root, full, out)
      continue
    }
    if (!entry.isFile()) continue
    const type = documentType(entry.name)
    if (!type) continue
    let size: number
    let modified: number
    try {
      const stat = statSync(full)
      size = stat.size
      modified = stat.mtimeMs
    } catch {
      continue
    }
    const path = relative(root, full)
    let content: string | undefined
    if (type.text && size <= MAX_INLINE) {
      try {
        const buffer = readFileSync(full)
        // A NUL byte in the first chunk is the cheap, standard way to tell binary from text.
        if (!buffer.subarray(0, 8000).includes(0)) content = buffer.toString("utf8")
      } catch {
        continue
      }
    }
    out.push({
      path,
      title: titleOf(content, type.mime, path),
      mime: type.mime,
      ...(content !== undefined ? { content } : {}),
      // Text hashes its words; anything else hashes what can change without the words changing.
      hash: content !== undefined ? artifactHash(content) : artifactHash(`${size}:${modified}`),
    })
  }
}

/** Every document under a project's `.flupcode/artifacts`, in path order. Absent folder is empty. */
export function discoverDocuments(directory: string): LocalDocument[] {
  const root = join(directory, DOCUMENTS_DIRECTORY)
  const out: LocalDocument[] = []
  walk(root, root, out)
  return out
}

/**
 * Indexes the documents of a folder that are not indexed yet, and returns the ones it added.
 *
 * Deduplicated by path **and** identity: reading the same document twice adds nothing, but one that
 * was rewritten is kept as a new snapshot rather than silently leaving the old one on screen.
 */
export function registerDocuments(repository: ArtifactRepository, directory: string): Artifact[] {
  const known = new Set(
    repository
      .listArtifacts({ directory, kind: "document" })
      .filter((artifact) => artifact.path && artifact.hash)
      .map((artifact) => `${artifact.path}\0${artifact.hash}`),
  )
  const added: Artifact[] = []
  for (const document of discoverDocuments(directory)) {
    if (known.has(`${document.path}\0${document.hash}`)) continue
    added.push(
      repository.addArtifact({
        kind: "document",
        title: document.title,
        producer: "agent",
        mime: document.mime,
        path: document.path,
        directory,
        ...(document.content !== undefined
          ? { content: document.content }
          : { hash: document.hash }),
      }),
    )
  }
  return added
}
