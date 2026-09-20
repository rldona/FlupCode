import type { Artifact } from "./types"

/** How an artifact's body is drawn, chosen from what the server said it is. */
export type ArtifactViewer = "markdown" | "html" | "image" | "pdf" | "text"

/**
 * Which viewer an artifact wants (H-14).
 *
 * The server keeps a `mime`, so the choice is a mapping and not a guess. A page is drawn in a
 * sandbox, an image and a PDF by the browser itself, markdown rendered, and everything else as the
 * text it is.
 */
export function viewerFor(artifact: Pick<Artifact, "mime">): ArtifactViewer {
  const mime = artifact.mime ?? ""
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown"
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html"
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  return "text"
}

/** Whether the viewer needs the bytes themselves rather than the text the server kept. */
export function viewerNeedsRaw(viewer: ArtifactViewer) {
  return viewer === "image" || viewer === "pdf"
}
