import { bundledLanguagesInfo } from "shiki"
import { getFilename } from "@opencode-ai/core/util/path"
import type { FilePart } from "@opencode-ai/sdk/v2"

export function attached(part: FilePart) {
  return part.url.startsWith("data:") && !inline(part)
}

export function inline(part: FilePart) {
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}

export function isToolImageAttachment(value: unknown): value is FilePart {
  if (!value || typeof value !== "object") return false
  const mime = (value as { mime?: unknown }).mime
  const url = (value as { url?: unknown }).url
  if (typeof mime !== "string" || typeof url !== "string" || !url) return false
  return kind(value as FilePart) === "image"
}

// Tool outputs may carry FilePart-shaped attachments (v1 and v2 are structurally
// compatible here); only completed tools expose them, so anything else short-circuits
// without touching the attachments array.
export function toolImageAttachments(state: unknown): FilePart[] {
  if (!state || typeof state !== "object") return []
  if ((state as { status?: unknown }).status !== "completed") return []
  const attachments = (state as { attachments?: unknown }).attachments
  if (!Array.isArray(attachments)) return []
  return attachments.filter(isToolImageAttachment)
}

// language metadata only; grammars stay behind shiki's lazy imports
const LANGUAGE_NAMES = new Map<string, string>(
  bundledLanguagesInfo.flatMap((info) =>
    [info.id, ...(info.aliases ?? [])].map((alias) => [alias, info.name] as [string, string]),
  ),
)

// attachments carry text/plain for all text files, so the label comes from the extension;
// filename may be an absolute path, so extract the basename before looking for one
export function typeLabel(filename: string, mime: string, fallback: string) {
  if (mime === "application/pdf") return "PDF"
  const base = getFilename(filename)
  // idx 0 is a dotfile like .gitignore, not an extension
  const idx = base.lastIndexOf(".")
  const suffix = idx <= 0 ? "" : base.slice(idx + 1).toLowerCase()
  if (!suffix) return fallback
  return LANGUAGE_NAMES.get(suffix) ?? suffix.toUpperCase()
}
