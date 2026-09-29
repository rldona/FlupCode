/**
 * The filesystem primitives a config writer needs, without any policy about *what* may be written.
 *
 * Two writers edit the same global `opencode.json(c)` from this process: the action-profile writer
 * (WA-8) and the adaptive settings writer (FH-070). If each kept its own serial queue, two writes
 * could read the same text and one would silently lose the other's edit. So the queue is one
 * module-global here, shared by both, and `applyEditsToFile` reads the text *inside* that queue:
 * edit positions belong to the text read there, not to anything a caller saw earlier.
 *
 * Nothing in this module decides which keys are editable. It reads, refuses to edit a malformed
 * document, writes through a temp file renamed in place, and serializes. The allowlist, the guards
 * and the file choice live with the writers.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"

/** A filesystem failure a config writer reports, with the status and the code of its contract. */
export class ConfigWriteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "config_write_error",
  ) {
    super(message)
    this.name = "ConfigWriteError"
  }
}

/** The `code` a Node filesystem error carries, when it carries one. */
export function errorCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * The text of a config file, or an empty document when it does not exist yet.
 *
 * A missing file is a fresh config to create, so it reads as empty. Any other failure means the file
 * is there but cannot be read, and writing a new document over it would lose what it held, so it is
 * refused rather than treated as empty. `undefined` is that refusal, told apart from an empty file.
 */
export function tryReadConfigText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (cause) {
    return errorCodeOf(cause) === "ENOENT" ? "" : undefined
  }
}

/** The text of a config file, an empty document when missing, or a `config_unreadable` failure. */
export function readConfigText(path: string): string {
  const text = tryReadConfigText(path)
  if (text === undefined) throw new ConfigWriteError(`The config file could not be read: ${path}`, 500, "config_unreadable")
  return text
}

/** Refuses to edit a file this cannot read: rewriting a malformed config would only make it worse. */
export function requireReadable(text: string, path: string): void {
  if (!text.trim()) return
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ConfigWriteError(`The config file is not valid JSONC: ${path}`, 422, "invalid_config")
}

/** Whether the path is an existing file, rather than a missing one or a directory. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// One write at a time across every writer in this process. Module-global on purpose: the action
// writer and the adaptive writer must share it or two reads can race and lose an update.
let writeQueue: Promise<unknown> = Promise.resolve()

/** Runs `work` after every write already queued, and queues what comes next behind it. */
export function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Writes through a temp file renamed in place, so a crash never leaves a half-written config. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${process.pid}.tmp`)
  try {
    await Bun.write(temp, text)
    renameSync(temp, path)
  } catch (cause) {
    rmSync(temp, { force: true })
    throw cause
  }
}

/**
 * Reads a config file, hands its text to `edit`, and writes back what `edit` returns — all inside the
 * shared queue, so a concurrent writer cannot read the same text and lose this update.
 *
 * `edit` receives the text read under the queue (not anything the caller saw before) because edit
 * positions are relative to it. Missing files start from an empty document; a malformed one is
 * refused rather than rewritten.
 */
export async function applyEditsToFile(path: string, edit: (text: string) => string): Promise<void> {
  await serial(async () => {
    const text = readConfigText(path)
    requireReadable(text, path)
    await writeAtomic(path, edit(text))
  })
}
