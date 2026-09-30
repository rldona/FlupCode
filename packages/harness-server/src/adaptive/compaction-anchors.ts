/**
 * Compaction anchors (AH-D04).
 *
 * Summarising stays in the engine (audit §10.4): FlupCode only hands its `.compacting` prompt a small
 * block of facts a generative summary tends to lose — the session's goal, the files it edited and
 * read, and the errors that are still open — so the work can continue after compaction without
 * re-reading or re-discovering them.
 *
 * Everything is derived from what the session already left: the edited paths and failing shells in
 * `episode-signals` (FH-003), the tool errors in `events` (FH-004), and the goal and read paths the
 * plugin captured in the engine. The window is the session, not one episode: the engine compacts a
 * session, and the signal ring already keeps only its newest 200 calls. Newest facts come first so the
 * cap drops the oldest.
 *
 * The block is redacted and capped at `ANCHOR_BLOCK_LIMIT` bytes, so the prompt it joins cannot grow
 * by more than a few hundred tokens. The plugin re-checks the shape and the cap before using it.
 */

import { isAbsolute } from "node:path"
import { locate } from "../failures"
import { episodeEvents } from "./events"
import type { EpisodeEvent, EpisodeEvents } from "./events"
import { redactText } from "./redaction"
import { episodeEvidence, episodeSignals } from "./signals"
import type { EpisodeSignal, EpisodeSignals } from "./signals"

/** The whole block, tags included. Kept in step with the plugin's own check in engine-plugins.ts. */
export const ANCHOR_BLOCK_LIMIT = 1536
export const ANCHOR_PREFIX = "<compaction_anchors>\n"
export const ANCHOR_SUFFIX = "\n</compaction_anchors>"

const INSTRUCTION =
  "Carry these anchors into the summary: they say what the work is for, which files it already " +
  "touched and which errors are still open, so it can continue without re-reading or re-discovering them."

const HEADINGS = new Set(["Files edited:", "Files read:", "Open errors:"])
/** The tools whose failure is the work's to fix and whose later success closes it. */
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])

const GOAL_LIMIT = 300
const ITEM_LIMIT = 200
const MOST_FILES = 15
const MOST_READS = 15
const MOST_ERRORS = 5
/** The plugin sends at most this many read paths; the route refuses a wider list. */
export const MOST_READ_PATHS = 30
const ID_LIMIT = 200
const PATH_LIMIT = 1000
const PROJECT_LIMIT = 4096

export type CompactionAnchors = { goal?: string; edited: string[]; read: string[]; errors: string[] }

/** The anchors a session's evidence supports, newest first and deduplicated. Pure. */
export function compactionAnchors(input: {
  goal?: string
  reads: string[]
  signals: EpisodeSignal[]
  events: EpisodeEvent[]
  directory: string
}): CompactionAnchors {
  const open = openSignals(input.signals)
  // Reversed so the first-seen order `episodeEvidence` keeps is newest first.
  const evidence = episodeEvidence(open.toReversed(), input.directory)
  const edited = evidence.files.slice(0, MOST_FILES)
  const read = [...new Set(input.reads.map((path) => locate(path, input.directory)))]
    .filter((path) => !edited.includes(path))
    .slice(0, MOST_READS)
  const failures = evidence.failures.map((failure) =>
    failure.file
      ? `${failure.file}${failure.line !== undefined ? `:${failure.line}` : ""} ${failure.summary}`
      : failure.summary,
  )
  // A failing shell whose output no reader recognised still says something is broken.
  const commands = open
    .filter((signal) => signal.tool === "bash" && signal.exit !== undefined && signal.exit !== 0 && signal.command)
    .toReversed()
    .map((signal) => `\`${signal.command}\` exits ${signal.exit}`)
  const toolErrors = openToolErrors(input.events, input.signals)
    .toReversed()
    .map((event) => (event.message ? `${event.tool} failed: ${event.message}` : `${event.tool} failed`))
  return {
    ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    edited,
    read,
    errors: [...new Set([...failures, ...commands, ...toolErrors])].slice(0, MOST_ERRORS),
  }
}

/**
 * The block the compaction prompt receives, or `undefined` when there is nothing to anchor. Every
 * value is redacted, stripped of angle brackets (so it cannot close the block) and bounded; lines are
 * added in order until the next one would pass the cap.
 */
export function renderAnchors(anchors: CompactionAnchors): string | undefined {
  const clean = (value: string, limit: number) =>
    redactText(value).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit)
  const section = (heading: string, items: string[]) =>
    items.length > 0 ? [heading, ...items.map((item) => `- ${clean(item, ITEM_LIMIT)}`)] : []
  const lines = [
    ...(anchors.goal ? [`Goal: ${clean(anchors.goal, GOAL_LIMIT)}`] : []),
    ...section("Files edited:", anchors.edited),
    ...section("Files read:", anchors.read),
    ...section("Open errors:", anchors.errors),
  ]
  if (lines.length === 0) return undefined
  const fixed = Buffer.byteLength(ANCHOR_PREFIX + INSTRUCTION + ANCHOR_SUFFIX)
  const kept = lines.reduce(
    (acc, line) => {
      const size = Buffer.byteLength(`\n${line}`)
      if (acc.full || acc.bytes + size > ANCHOR_BLOCK_LIMIT) return { ...acc, full: true }
      return { lines: [...acc.lines, line], bytes: acc.bytes + size, full: false }
    },
    { lines: [] as string[], bytes: fixed, full: false },
  ).lines
  // A heading left without a single entry under it says nothing.
  const body = kept.filter((line, index) => !HEADINGS.has(line) || kept[index + 1]?.startsWith("- "))
  if (body.length === 0) return undefined
  return [ANCHOR_PREFIX + INSTRUCTION, ...body].join("\n") + ANCHOR_SUFFIX
}

export type CompactionAnchorDeps = {
  /** `compaction.anchors` composed with the adaptive kill switch; read on every request. */
  enabled: () => boolean
  /** The session override (AH-E02): a paused session gets no block, from its next compaction. */
  paused?: (sessionID: string) => boolean
  readSignals?: (sessionID: string) => EpisodeSignals
  readEvents?: (sessionID: string) => EpisodeEvents
  /** The session's stored episode objective, used when the plugin captured no goal. */
  objective?: (sessionID: string) => string | undefined
}

/**
 * The plugin's `POST`: `{ projectID?, sessionID, goal?, reads? }` → `{ data: { block? } }`. A `POST`
 * because the goal is the user's own words and must not travel in a URL. With the switch off, or
 * nothing to anchor, the answer carries no block and the prompt is left alone.
 */
export async function handleCompactionAnchorsRequest(request: Request, deps: CompactionAnchorDeps): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined)
  if (!isPlainObject(body)) return error("An anchors request needs a JSON body", "bad_request", 400)
  const sessionID = boundedString(body.sessionID, ID_LIMIT)
  if (sessionID === undefined) return error("An anchors request needs a sessionID", "bad_request", 400)
  if (!deps.enabled() || deps.paused?.(sessionID)) return json({ data: {} })
  const projectID = boundedString(body.projectID, PROJECT_LIMIT)
  const reads = Array.isArray(body.reads)
    ? body.reads.slice(0, MOST_READ_PATHS).flatMap((path) => {
        const value = boundedString(path, PATH_LIMIT)
        return value ? [value] : []
      })
    : []
  const goal = typeof body.goal === "string" ? body.goal.slice(0, GOAL_LIMIT) : undefined
  const block = renderAnchors(
    compactionAnchors({
      goal: goal?.trim() ? goal : deps.objective?.(sessionID),
      reads,
      signals: (deps.readSignals ?? episodeSignals)(sessionID).calls,
      events: (deps.readEvents ?? episodeEvents)(sessionID).events,
      // The coordinator's own fallback when the engine names no directory.
      directory: projectID && isAbsolute(projectID) ? projectID : "local",
    }),
  )
  return json({ data: block ? { block } : {} })
}

/** The signals minus the failing shells a later run of the same command fixed. */
function openSignals(signals: EpisodeSignal[]) {
  return signals.filter(
    (signal, index) =>
      signal.tool !== "bash" ||
      signal.exit === undefined ||
      signal.exit === 0 ||
      !signals
        .slice(index + 1)
        .some((later) => later.tool === "bash" && later.command === signal.command && later.exit === 0),
  )
}

/**
 * The failed edits no later successful edit with the same tool followed. A failed read or search is
 * not an open problem, and a provider's session error is not the work's to fix, so both are left out.
 */
function openToolErrors(events: EpisodeEvent[], signals: EpisodeSignal[]) {
  return events.flatMap((event) =>
    event.kind === "tool.error" &&
    EDIT_TOOLS.has(event.tool) &&
    !signals.some((signal) => signal.tool === event.tool && signal.ok && (signal.start ?? 0) > event.at)
      ? [event]
      : [],
  )
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

function boundedString(value: unknown, limit: number) {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
