/**
 * Reading a file to look at it (H-19).
 *
 * The engine can write and the harness can read the files it is about, but neither offered a plain
 * "show me this file". The engine's own read route answers bytes with a mime and takes the path in
 * the URL; this reads text, confined to one folder, with a cap — a viewer is not a download.
 */

import { readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"

export type FileText = {
  path: string
  content: string
  bytes: number
  /** The file is longer than the cap; only the beginning is here. */
  truncated: boolean
  /** It has a NUL byte, so it is not text and is not shown as any. */
  binary: boolean
}

/** Half a megabyte is plenty to read and small enough not to stall a phone. */
export const MAX_BYTES = 512 * 1024

export class FileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "FileError"
  }
}

export function readProjectFile(input: { directory: string; path: string; maxBytes?: number }): FileText {
  const root = resolve(input.directory)
  const absolute = resolve(root, input.path)
  // The path arrives from a browser. A `..` or an absolute path is refused before anything is read.
  if (!(absolute === root || absolute.startsWith(root + sep))) {
    throw new FileError("That path is outside the folder")
  }
  let size: number
  try {
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new FileError("That is not a file")
    size = stat.size
  } catch (cause) {
    if (cause instanceof FileError) throw cause
    throw new FileError("No such file", 404)
  }
  const max = input.maxBytes ?? MAX_BYTES
  const buffer = readFileSync(absolute)
  // A NUL byte in the first chunk is the cheap, standard way to tell binary from text.
  if (buffer.subarray(0, 8000).includes(0)) {
    return { path: input.path, content: "", bytes: size, truncated: false, binary: true }
  }
  const slice = buffer.subarray(0, max)
  return {
    path: input.path,
    content: slice.toString("utf8"),
    bytes: size,
    truncated: size > max,
    binary: false,
  }
}
