/**
 * The HTTP contract of the recoverable tool-output trim (AH-D02).
 *
 * `api.ts` guards both routes with the dedicated `adaptive-token` bearer, like the relevance and
 * guardrails routes: only the installed engine plugin holds it, never a browser page.
 *
 * - `POST /harness/adaptive/tool-trim` takes one finished tool output. When the config says to trim
 *   it, the whole output is stored first and the answer carries the replacement; any other answer
 *   (disabled, exempt, below the threshold, too large, a store that failed) says `trimmed: false`
 *   and the plugin leaves the output exactly as it was. The answer always carries the live policy,
 *   so the plugin stops posting outputs that could never be trimmed.
 * - `POST /harness/adaptive/evidence/read` returns a range of a stored output, only to the session
 *   that stored it. It answers whether or not the trim is on now, so a ref handed out earlier stays
 *   readable after the switch is turned off.
 *
 * The output is stored as the tool produced it, not redacted: the evidence store keeps raw text on
 * the loopback (FH-006) and redaction applies where state leaves the machine (`egress.ts`). A trimmed
 * output only ever goes back to the session that produced it, which had the whole text already.
 */

import type { AdaptiveConfig } from "./config"
import { armFor } from "./holdout"
import { TOOL_EVIDENCE_REF_PATTERN, evidenceRange, trimSkip, trimmedOutput } from "./tool-trim"

export type ToolEvidenceStore = {
  putToolEvidence(input: { sessionID: string; tool: string; content: string }): { ref: string } | undefined
  getToolEvidence(sessionID: string, ref: string): { content: string } | undefined
}

export type ToolTrimDeps = {
  store: ToolEvidenceStore
  config: () => AdaptiveConfig
  /** The session override (AH-E02): a paused session's outputs are left whole from its next tool call. */
  paused?: (sessionID: string) => boolean
}

/** How long the plugin may stay quiet while the trim is off; the switch still reacts within it. */
export const TOOL_TRIM_RETRY_AFTER_MS = 60_000

/** Engine-shaped ids and tool names are short; the caps keep a caller from handing the store a key. */
const ID_LIMIT = 200
const TOOL_LIMIT = 200
/** A range is a few digits and a prefix; anything longer is not one of ours. */
const RANGE_LIMIT = 64

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

export async function handleToolTrimRequest(request: Request, deps: ToolTrimDeps): Promise<Response> {
  const body = await readBody(request)
  const sessionID = boundedString(body, "sessionID", ID_LIMIT)
  const tool = boundedString(body, "tool", TOOL_LIMIT)
  const output = body?.output
  if (sessionID === undefined || tool === undefined || typeof output !== "string")
    return error("A tool-trim request needs sessionID, tool and a string output", "bad_request", 400)

  const adaptive = deps.config()
  const config = { ...adaptive.toolTrim, enabled: adaptive.enabled && adaptive.toolTrim.enabled }
  const policy = { thresholdBytes: config.thresholdBytes, maxStoredBytes: config.maxStoredBytes, exempt: config.exempt }
  const skip = trimSkip(config, tool, Buffer.byteLength(output, "utf8"))
  if (skip === "disabled")
    return json({ data: { trimmed: false, reason: skip, policy, retryAfterMs: TOOL_TRIM_RETRY_AFTER_MS } })
  if (skip !== undefined) return json({ data: { trimmed: false, reason: skip, policy } })
  // No `retryAfterMs`: the plugin's back-off is global, and a pause holds for this session only.
  if (deps.paused?.(sessionID)) return json({ data: { trimmed: false, reason: "session-paused", policy } })
  // The control arm (AH-B05, AH-G01): the output reaches the model whole, so the live evaluation can
  // compare trimmed sessions against untouched ones. Nothing is stored for a control session.
  if (armFor(sessionID, "toolTrim", adaptive.holdout.fraction) === "control")
    return json({ data: { trimmed: false, reason: "holdout", policy } })

  // The replacement is rendered only after the store confirmed the whole output: no ref is handed out
  // that does not read back.
  const stored = deps.store.putToolEvidence({ sessionID, tool, content: output })
  if (!stored) return json({ data: { trimmed: false, reason: "store-failed", policy } })
  return json({
    data: { trimmed: true, ref: stored.ref, replacement: trimmedOutput(output, stored.ref, config), policy },
  })
}

export async function handleEvidenceReadRequest(request: Request, deps: ToolTrimDeps): Promise<Response> {
  const body = await readBody(request)
  const sessionID = boundedString(body, "sessionID", ID_LIMIT)
  const ref = typeof body?.ref === "string" ? body.ref.trim().replace(/^evidence:/, "") : undefined
  const range = typeof body?.range === "string" ? body.range : ""
  if (sessionID === undefined || ref === undefined)
    return error("An evidence read needs sessionID and ref", "bad_request", 400)
  if (!TOOL_EVIDENCE_REF_PATTERN.test(ref)) return error("The ref is not an evidence ref", "bad_ref", 400)
  if (range.length > RANGE_LIMIT) return error("The range is past its limit", "bad_request", 400)
  // Another session's ref and an evicted one read the same: nothing tells a caller the ref exists.
  const stored = deps.store.getToolEvidence(sessionID, ref)
  if (!stored) return error(`evidence:${ref} is not available to this session`, "evidence_not_found", 404)
  return json({ data: { text: evidenceRange(stored.content, ref, range, deps.config().toolTrim.readBytes) } })
}

function boundedString(body: Record<string, unknown> | undefined, key: string, limit: number): string | undefined {
  const value = body?.[key]
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const parsed: unknown = await request.json().catch(() => undefined)
  return isPlainObject(parsed) ? parsed : undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
