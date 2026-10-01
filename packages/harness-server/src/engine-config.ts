/**
 * The engine's own configuration files, read and written here instead of through the engine (V2-24).
 *
 * OpenCode 1.x writes its config itself (`PATCH /config`, `PATCH /global/config`); OpenCode 2 only
 * writes its `shell`, and leaves keys it does not know (the `flupcode` block) out of `GET /api/config`.
 * Both still load an `opencode.json` written in 1.x shape (2.x migrates it as it reads it), so FlupCode
 * keeps writing that shape, here, and then asks the engine to reload.
 *
 * **Which file** is the one both lines read: in the global config folder `opencode.jsonc`, else
 * `opencode.json`, else a new `opencode.json`; in a folder, its `opencode.jsonc` or `opencode.json`.
 * 1.x also reads `config.json` (and wrote a folder's settings there), but 2.x reads neither, so a
 * write that has to reach both never goes to one.
 *
 * **How it writes** follows 1.x's `PATCH`: a deep merge, comments and formatting kept (the edit is
 * JSONC, not a re-serialized object), and each `provider` entry replaced whole, so dropping a model or
 * an option from one actually drops it. On top of 1.x, `null` removes a key, which is how a server
 * comes out of the `mcp` map. Every write goes through the queue the other config writers share.
 */

import { join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { readConfigText, requireReadable, serial, isFile, writeAtomic, ConfigWriteError } from "./config-write"
import { configDirectory } from "./context"

export type EngineConfigScope = "global" | "project"

const FORMAT = { insertSpaces: true, tabSize: 2 } as const

/** The file a scope reads and writes. A folder is required for the project scope. */
export function engineConfigPath(input: { scope: EngineConfigScope; directory?: string; configDir?: string }) {
  const folder = input.scope === "global" ? (input.configDir ?? configDirectory()) : input.directory?.trim()
  if (!folder)
    throw new ConfigWriteError("A folder is required to read or write a project config", 400, "invalid_request")
  const candidates = ["opencode.jsonc", "opencode.json"].map((name) => join(folder, name))
  return candidates.find(isFile) ?? candidates[1]!
}

/** The document as it is on disk, `{}` when the file does not exist yet. */
export function readEngineConfig(input: { scope: EngineConfigScope; directory?: string; configDir?: string }) {
  const path = engineConfigPath(input)
  const text = readConfigText(path)
  requireReadable(text, path)
  const config = text.trim() ? (parse(text, [], { allowTrailingComma: true }) as unknown) : {}
  return { path, config: isRecord(config) ? config : {} }
}

/** Merges `patch` into the scope's file and says whether anything changed. */
export async function patchEngineConfig(input: {
  scope: EngineConfigScope
  patch: Record<string, unknown>
  directory?: string
  configDir?: string
}) {
  const path = engineConfigPath(input)
  return serial(async () => {
    const before = readConfigText(path)
    requireReadable(before, path)
    const after = edits(before.trim() ? before : "{}", input.patch, [])
    if (after === before) return { path, changed: false }
    await writeAtomic(path, after)
    return { path, changed: true }
  })
}

/** One edit per leaf of the patch, so every key the patch does not name stays exactly as it was. */
function edits(text: string, patch: Record<string, unknown>, at: string[]): string {
  return Object.entries(patch).reduce((current, [key, value]) => {
    const path = [...at, key]
    // A provider is written as a unit (1.x does the same), anything that is not an object is a leaf,
    // and so is an object landing on a key that holds something else (`"permission": "allow"`).
    // `null` removes the key: `modify` drops a property set to `undefined`.
    const existing = path.reduce<unknown>(
      (node, part) => (isRecord(node) ? node[part] : undefined),
      parse(current, [], { allowTrailingComma: true }),
    )
    // Removing what is not there is nothing to do; `modify` would refuse it.
    if (value === null && existing === undefined) return current
    const whole =
      !isRecord(value) || (at.length === 1 && at[0] === "provider") || (existing !== undefined && !isRecord(existing))
    if (!whole) return edits(current, value, path)
    return applyEdits(current, modify(current, path, value === null ? undefined : value, { formattingOptions: FORMAT }))
  }, text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
