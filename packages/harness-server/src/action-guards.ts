/**
 * Product-owned guards for web actions (WA-2).
 *
 * The same contract delivery profiles use: modules under the configuration directory export a
 * `guards` array, and the first refusal stops the action. A safety gate must not disappear quietly,
 * so a module that cannot be loaded, one that exports no guards, or one whose `assess` throws is a
 * refusal rather than a skip.
 */

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type ActionGuardInput = {
  action: string
  tool: string
  origin: string
  inputs: Record<string, string>
}

export type ActionGuardVerdict = { allow: true } | { allow: false; code: string; message: string }

type Guard = { assess: (input: ActionGuardInput) => unknown }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isGuard = (value: unknown): value is Guard => isPlainObject(value) && typeof value.assess === "function"

export async function runActionGuards(input: {
  guards: string[]
  configDir: string
  input: ActionGuardInput
}): Promise<ActionGuardVerdict> {
  const loaded: Guard[] = []
  for (const entry of input.guards) {
    if (typeof entry !== "string" || !entry) continue
    let module: unknown
    try {
      module = await import(pathToFileURL(resolve(input.configDir, entry)).href)
    } catch {
      return { allow: false, code: "GUARD_LOAD_ERROR", message: entry }
    }
    if (!isPlainObject(module) || !Array.isArray(module.guards))
      return { allow: false, code: "GUARD_LOAD_ERROR", message: entry }
    // A malformed entry is a module that failed to load, not a guard to skip: a typo such as
    // `{ id, check }` would otherwise delete the barrier while the run looks guarded.
    for (const candidate of module.guards) {
      if (!isGuard(candidate)) return { allow: false, code: "GUARD_LOAD_ERROR", message: entry }
      loaded.push(candidate)
    }
  }

  for (const candidate of loaded) {
    let verdict: unknown
    try {
      verdict = await candidate.assess(input.input)
    } catch (cause) {
      return {
        allow: false,
        code: "GUARD_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      }
    }
    if (verdict && typeof verdict === "object" && (verdict as { allow?: unknown }).allow === false) {
      const denied = verdict as { code?: unknown; reason?: unknown }
      return {
        allow: false,
        code: typeof denied.code === "string" ? denied.code : "GUARD_DENIED",
        message: typeof denied.reason === "string" ? denied.reason : "Denied",
      }
    }
  }

  return { allow: true }
}
