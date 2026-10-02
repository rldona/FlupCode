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
 * The agent can also declare one directly with the `artifact_write` tool, which writes the document
 * into the same folder — so there is one place documents live and one pass that finds them. That
 * tool also reports the write as it happens (RP-03), so the document is indexed at once and says
 * which session and message wrote it; the run and task are the server's to work out from the session.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join, relative, sep } from "node:path"
import { confinedPath } from "./project-roots"
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
    const document = readDocument(root, full)
    if (document) out.push(document)
  }
}

/** One file as a document, or nothing when it is not a kind of document or cannot be read. */
function readDocument(root: string, full: string): LocalDocument | undefined {
  const type = documentType(full)
  if (!type) return undefined
  let size: number
  let modified: number
  try {
    const stat = statSync(full)
    if (!stat.isFile()) return undefined
    size = stat.size
    modified = stat.mtimeMs
  } catch {
    return undefined
  }
  const path = join(DOCUMENTS_DIRECTORY, relative(root, full))
  let content: string | undefined
  if (type.text && size <= MAX_INLINE) {
    try {
      const buffer = readFileSync(full)
      // A NUL byte in the first chunk is the cheap, standard way to tell binary from text.
      if (!buffer.subarray(0, 8000).includes(0)) content = buffer.toString("utf8")
    } catch {
      return undefined
    }
  }
  return {
    path,
    title: titleOf(content, type.mime, path),
    mime: type.mime,
    ...(content !== undefined ? { content } : {}),
    // Text hashes its words; anything else hashes what can change without the words changing.
    hash: content !== undefined ? artifactHash(content) : artifactHash(`${size}:${modified}`),
  }
}

/** Every document under a project's `.flupcode/artifacts`, in path order. Absent folder is empty. */
export function discoverDocuments(directory: string): LocalDocument[] {
  const root = join(directory, DOCUMENTS_DIRECTORY)
  const out: LocalDocument[] = []
  // The walk skips links, but the folder itself could be one: a `.flupcode/artifacts` pointing out
  // of the project would index whatever it points at (TI-11).
  if (!confinedPath(directory, DOCUMENTS_DIRECTORY)) return out
  walk(root, root, out)
  return out
}

/**
 * Indexes the documents of a folder whose current state is not indexed yet, and returns the ones it
 * added.
 *
 * Each file is one document (RP-03): reading it again unchanged adds nothing, and one that was
 * rewritten since its newest version is kept as the next version, not as an unrelated row.
 */
export function registerDocuments(repository: ArtifactRepository, directory: string): Artifact[] {
  return discoverDocuments(directory).flatMap((document) => {
    const kept = repository.keepVersion({
      kind: "document",
      title: document.title,
      producer: "agent",
      mime: document.mime,
      path: document.path,
      directory,
      hash: document.hash,
      ...(document.content !== undefined ? { content: document.content } : {}),
    })
    return kept.added ? [kept.artifact] : []
  })
}

/** What the engine's plugin reports when its `artifact_write` tool keeps a document (RP-03). */
export type DocumentWrite = {
  directory: string
  path: string
  title?: string
  sessionID: string
  messageID?: string
}

/**
 * Indexes the one document a session just wrote, with what wrote it. The file is read here, from the
 * project's documents folder only: the caller names a file, never its contents, so a report cannot
 * index text that is not on disk or a file outside that folder. The run and task come from the
 * session's attribution, never from the caller (P7). Undefined when there is no such document.
 */
export function indexDocument(
  repository: ArtifactRepository,
  write: DocumentWrite,
  attribution: { runID?: string; taskID?: string } | undefined,
) {
  const root = confinedPath(write.directory, DOCUMENTS_DIRECTORY)
  const full = confinedPath(write.directory, write.path)
  if (!root || !full || !full.startsWith(root + sep)) return undefined
  const document = readDocument(root, full)
  if (!document) return undefined
  return repository.keepVersion({
    kind: "document",
    // The title the agent gave wins over one read from the file, as the tool's description promises.
    title: write.title?.trim() || document.title,
    producer: "agent",
    mime: document.mime,
    path: document.path,
    directory: write.directory,
    hash: document.hash,
    sessionID: write.sessionID,
    ...(write.messageID ? { messageID: write.messageID } : {}),
    ...(attribution?.runID ? { runID: attribution.runID } : {}),
    ...(attribution?.taskID ? { taskID: attribution.taskID } : {}),
    ...(document.content !== undefined ? { content: document.content } : {}),
  })
}
