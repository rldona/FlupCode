/**
 * The values an action's tool was called with, made runnable (WA-2).
 *
 * A string input is passed through. An image input — a data URL or an artifact id — is materialized
 * to a `0600` file under a private temp folder, because `setInputFiles` takes a path, and the path
 * must not outlive the call. The agent never receives the path: the value it sees is `"<image>"`.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { ActionProfile } from "./actions"
import type { SqliteRoutineRepository } from "./repository"

export const ACTION_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export type ResolvedActionInputs = {
  values: Record<string, string>
  images: Record<string, string>
  cleanup(): void
}

export class ActionInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ActionInputError"
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type ArtifactRepository = Pick<SqliteRoutineRepository, "getArtifact">

export async function resolveActionInputs(input: {
  profile: ActionProfile
  provided: Record<string, unknown>
  repository: ArtifactRepository
  /**
   * A preview only materializes what it was given (WA-8).
   *
   * The editor previews a recipe before its inputs are filled; requiring them all would turn every
   * profile with an input into a 422. A missing one is left unset, so the step that would use it is
   * the one that reports, which is where the cut already is for a fill or an upload.
   */
  partial?: boolean
}): Promise<ResolvedActionInputs> {
  const values: Record<string, string> = {}
  const images: Record<string, string> = {}
  let tempDir: string | undefined
  let cleaned = false
  const ensureDir = () => (tempDir ??= mkdtempSync(join(tmpdir(), "flupcode-action-")))
  const cleanup = (): void => {
    if (cleaned || tempDir === undefined) return
    cleaned = true
    rmSync(tempDir, { recursive: true, force: true })
  }

  try {
    for (const [index, [name, kind]] of Object.entries(input.profile.inputs).entries()) {
      const value = input.provided[name]
      if (value === undefined || value === null) {
        if (input.partial === true) continue
        throw new ActionInputError("missing_input", `Input "${name}" is required`)
      }
      if (kind === "image") {
        // The temp file is named by position, never by the caller-facing name, so a name cannot shape
        // a path. `images[name]` still carries the path the runner uploads.
        images[name] = resolveImage(name, index, value, input.repository, ensureDir)
        values[name] = "<image>"
        continue
      }
      if (typeof value !== "string") throw new ActionInputError("invalid_input", `Input "${name}" must be a string`)
      values[name] = value
    }
    for (const [name, value] of Object.entries(input.provided)) {
      if (value === undefined) continue
      if (!(name in input.profile.inputs))
        throw new ActionInputError("unknown_input", `Input "${name}" is not declared by this action`)
    }
  } catch (cause) {
    cleanup()
    throw cause
  }

  return { values, images, cleanup }
}

function resolveImage(
  name: string,
  index: number,
  value: unknown,
  repository: ArtifactRepository,
  ensureDir: () => string,
): string {
  if (isPlainObject(value)) {
    if (typeof value.dataUrl === "string") return imageFromDataUrl(name, index, value.dataUrl, ensureDir)
    if (typeof value.artifactId === "string")
      return imageFromArtifact(name, index, value.artifactId, repository, ensureDir)
  }
  if (typeof value === "string" && value.startsWith("data:")) return imageFromDataUrl(name, index, value, ensureDir)
  throw new ActionInputError("invalid_input", `Input "${name}" must be a data URL or an artifact id`)
}

function imageFromDataUrl(name: string, index: number, value: string, ensureDir: () => string): string {
  const match = DATA_URL.exec(value)
  if (!match) throw new ActionInputError("invalid_input", `Input "${name}" is not a base64 image data URL`)
  const encoded = match[2]!
  // Base64 is a third longer than the bytes it carries, so this refuses before decoding allocates.
  if ((encoded.length * 3) / 4 > ACTION_IMAGE_MAX_BYTES)
    throw new ActionInputError("invalid_input", `Input "${name}" exceeds the image size limit`)
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > ACTION_IMAGE_MAX_BYTES)
    throw new ActionInputError("invalid_input", `Input "${name}" exceeds the image size limit`)
  return writeImage(name, index, bytes, match[1]!, ensureDir)
}

function imageFromArtifact(
  name: string,
  index: number,
  artifactId: string,
  repository: ArtifactRepository,
  ensureDir: () => string,
): string {
  const artifact = repository.getArtifact(artifactId)
  if (
    !artifact ||
    typeof artifact.path !== "string" ||
    !artifact.path ||
    typeof artifact.directory !== "string" ||
    !artifact.directory
  )
    throw new ActionInputError("invalid_input", `Artifact "${artifactId}" is not a file this server can use`)

  // The real path, not the recorded one: a symlink under `directory` must not point outside it.
  let root: string
  let source: string
  try {
    root = realpathSync(resolve(artifact.directory))
    source = realpathSync(resolve(root, artifact.path))
  } catch {
    throw new ActionInputError("invalid_input", `Artifact "${artifactId}" is not on disk`)
  }
  if (!source.startsWith(root + sep))
    throw new ActionInputError("invalid_input", `Artifact "${artifactId}" is outside its directory`)

  // Copied, not referenced: the original may be swept, moved or rewritten while the runner uses it.
  const bytes = readFileSync(source)
  if (bytes.byteLength > ACTION_IMAGE_MAX_BYTES)
    throw new ActionInputError("invalid_input", `Input "${name}" exceeds the image size limit`)
  return writeImage(name, index, bytes, artifact.mime, ensureDir)
}

function writeImage(name: string, index: number, bytes: Buffer, mime: string, ensureDir: () => string): string {
  const extension = IMAGE_EXTENSIONS[mime]
  if (!extension) throw new ActionInputError("unsupported_image", `Input "${name}" is not a supported image type`)
  const file = join(ensureDir(), `input-${index}.${extension}`)
  writeFileSync(file, bytes, { mode: 0o600 })
  return file
}
