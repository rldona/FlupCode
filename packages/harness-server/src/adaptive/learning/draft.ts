/**
 * The small model that drafts one learned skill (FH-032).
 *
 * Jev only classifies: *whether* a lesson is reusable and *what* change it calls for. The text is
 * written here, by the small model, through a throwaway engine session — the same pattern
 * `Engine.commitMessage`/`handoff` already use, because `harness-server` has no LLM client of its own
 * (ADR-0016 §2). The seam is narrow on purpose: `DraftEngine` is the slice of `Engine` this needs, so
 * a test injects a fake and never starts a real engine or touches the network.
 *
 * The contract is **never throws**: a timeout, a parse failure or a missing answer is `undefined`, so
 * the caller drops the proposal instead of branching on an error. The input is swept through the
 * caller's redactor (`EgressGuard.redact`) and then bounded before it leaves, so a known secret never
 * reaches the model (ADR-0020 §5) and one straddling the bound cannot survive the cut.
 */

import type { Model } from "../../policy"
import { parseModelKey } from "../../policy"
import { NAME } from "../../skills"
import { NO_TOOLS, type PermissionRule } from "../../engine"
import { isAbsolute } from "node:path"
import type { LearningConfig } from "../config"

export type SkillDraft = { name: string; description: string; body: string }

/** The shape checks a draft must pass; the numbers are policy, the caller may override them. */
export type DraftLimits = {
  minBodyChars: number
  maxBodyChars: number
  maxDescriptionChars: number
  maxBodyLines: number
  maxNameChars: number
}

export const DRAFT_LIMITS: DraftLimits = {
  minBodyChars: 80,
  maxBodyChars: 4_000,
  maxDescriptionChars: 200,
  maxBodyLines: 60,
  maxNameChars: 48,
}

/** How much of the observed transcript is handed to the model; the instruction is never trimmed. */
export const DEFAULT_MAX_INPUT_CHARS = 8_000

export type SkillDraftRequest = {
  /**
   * The project the draft belongs to; the throwaway session runs inside it. Required and absolute: a
   * draft with no directory — or a relative one such as `"local"`, as a local project gets — would run
   * wherever the harness process happens to be, so the drafter refuses instead.
   */
  directory: string
  objective: string
  signals: string[]
  /** Evidence slices, already read from the episode; the drafter bounds and redacts them. */
  evidence: string[]
  /** For a `patch`, the skill being updated, so the draft can improve it rather than replace it. */
  existing?: { name: string; description: string; body: string }
}

export type SkillDrafter = {
  /** Never throws: any failure resolves `undefined`, which means no draft and no proposal. */
  draft(input: SkillDraftRequest): Promise<SkillDraft | undefined>
}

/** The slice of `Engine` the drafter needs; the real `Engine` satisfies it structurally. */
export type DraftEngine = {
  createSession(input: {
    directory?: string
    title?: string
    /** The session's own permission rules; the drafter denies every tool (see `NO_TOOLS`). */
    permission?: PermissionRule[]
  }): Promise<{ id: string }>
  prompt(input: { sessionID: string; text: string; directory?: string; model?: Model }): Promise<unknown>
  waitForIdle(sessionID: string, options?: { directory?: string; timeoutMs?: number }): Promise<void>
  lastAnswer(sessionID: string, directory?: string): Promise<{ text?: string } | undefined>
}

/** The reason a draft is skipped when no model is resolved; the manager records it as-is. */
export const NO_MODEL_REASON = "no-model"

/**
 * The drafting model: `adaptive.learning.model`, then the global `small_model`, then nothing.
 *
 * A malformed key falls through rather than being guessed at, and no key at all is `undefined` —
 * which is the honest `no-model`, not a silent fallback to some other model (ADR-0020 §6).
 */
export function learningModel(
  learning: Pick<LearningConfig, "model">,
  smallModel?: () => string | undefined,
): Model | undefined {
  return parseModelKey(learning.model) ?? parseModelKey(smallModel?.())
}

// ---- the defensive parser ----------------------------------------------------------------------

const FENCE = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/g
/** "User:"/"Assistant:"/"Human:"/"System:" lines mean the model pasted a transcript, not a skill. */
const TRANSCRIPT_LINE = /^(?:user|assistant|human|system)\s*:/i

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Every fenced block, newest last, plus the whole text when it looks like JSON (the `findings.ts` style). */
function candidates(text: string): string[] {
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = FENCE.exec(text)) !== null) if (match[1]) blocks.push(match[1])
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) blocks.push(trimmed)
  // Last first: an answer that explains and then drafts ends with the draft.
  return blocks.reverse()
}

export function parseSkillDraft(text: string | undefined, limits: Partial<DraftLimits> = {}): SkillDraft | undefined {
  if (!text) return undefined
  const resolved = { ...DRAFT_LIMITS, ...limits }
  for (const block of candidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    if (!isPlainObject(parsed)) continue
    const draft = readDraft(parsed, resolved)
    if (draft) return draft
  }
  return undefined
}

function readDraft(entry: Record<string, unknown>, limits: DraftLimits): SkillDraft | undefined {
  const name = typeof entry.name === "string" ? entry.name.trim() : ""
  if (!name || name.length > limits.maxNameChars || !NAME.test(name)) return undefined

  const description = typeof entry.description === "string" ? entry.description.trim() : ""
  if (!description || description.includes("\n") || description.length > limits.maxDescriptionChars) return undefined

  const body = typeof entry.body === "string" ? entry.body.trim() : ""
  if (isRejectedBody(body, limits)) return undefined

  return { name, description, body }
}

/** A body over the altitude cap, or shaped like a transcript, is not a skill. */
function isRejectedBody(body: string, limits: DraftLimits): boolean {
  if (body.length < limits.minBodyChars || body.length > limits.maxBodyChars) return true
  const lines = body.split("\n")
  if (lines.length > limits.maxBodyLines) return true
  return lines.some((line) => TRANSCRIPT_LINE.test(line.trim()))
}

// ---- the engine-backed implementation ----------------------------------------------------------

/** The instruction before the bounded, redacted transcript; exported so its wording is testable. */
export const DRAFT_INSTRUCTION = [
  "Write one reusable SKILL.md for future tasks.",
  "Answer ONLY with a fenced json block:",
  '{"name": "<slug>", "description": "<one line, trigger first>", "body": "<markdown, >=80 and <=4000 chars>"}',
  "Do not include a transcript. Do not include secrets.",
].join("\n")

/** The untrusted part of the prompt: objective, bounded signals and the evidence it may cite. */
function buildTranscript(input: SkillDraftRequest): string {
  return [
    `Objective: ${input.objective}`,
    ...(input.signals.length > 0 ? [`Signals: ${input.signals.join("; ")}`] : []),
    ...(input.evidence.length > 0 ? ["Evidence:", ...input.evidence.map((slice) => `- ${slice}`)] : []),
    ...(input.existing
      ? ["", `Existing skill "${input.existing.name}": ${input.existing.description}`, input.existing.body]
      : []),
  ].join("\n")
}

/**
 * A `SkillDrafter` backed by a throwaway engine session.
 *
 * The transcript is redacted first and bounded second, so a secret that straddles the input cap is
 * swept before the cut rather than surviving it (the `egress.prepare` order). The session is created
 * **inside the request's project directory** and under `NO_TOOLS`: the prompt carries untrusted
 * observed content, and a session with the default agent would let that content invoke tools. A
 * request with no directory — or a relative one — is refused with `undefined` rather than opening a
 * session elsewhere. Everything is inside one `try`, so the contract holds: any failure is `undefined`.
 */
export function createEngineSkillDrafter(deps: {
  engine: DraftEngine
  model: Model
  timeoutMs: number
  /** The caller's redactor (`EgressGuard.redact`); applied to the transcript before it leaves. */
  redact?: (value: unknown) => unknown
  maxInputChars?: number
  limits?: Partial<DraftLimits>
}): SkillDrafter {
  const maxInputChars = deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  const limits = { ...DRAFT_LIMITS, ...deps.limits }
  const redact = (text: string): string => {
    if (!deps.redact) return text
    const value = deps.redact(text)
    return typeof value === "string" ? value : text
  }

  return {
    async draft(input) {
      const directory = input.directory
      // A relative directory (`projectID: "local"`) would run the session wherever the process is, so
      // only an absolute one is accepted; anything else is refused before a session is opened.
      if (!directory || !isAbsolute(directory)) return undefined
      try {
        // Redact, then bound: a secret cut by the cap is not a secret the sweep can still see.
        const transcript = redact(buildTranscript(input)).slice(0, maxInputChars)
        const session = await deps.engine.createSession({
          directory,
          title: "Skill draft",
          permission: NO_TOOLS,
        })
        await deps.engine.prompt({
          sessionID: session.id,
          text: `${DRAFT_INSTRUCTION}\n\n${transcript}`,
          directory,
          model: deps.model,
        })
        await deps.engine.waitForIdle(session.id, { directory, timeoutMs: deps.timeoutMs })
        const answer = await deps.engine.lastAnswer(session.id, directory)
        return parseSkillDraft(answer?.text, limits)
      } catch {
        return undefined
      }
    },
  }
}
