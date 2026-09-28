/**
 * The evidence an episode keeps, addressed by its content (FH-006).
 *
 * A capture derives failures and then forgets what they came from: the shell output and the event
 * message. This module is the pure half of keeping them — the bounds a slice lives under, the
 * content address that makes the same text one row, and the candidates a session offers. Nothing
 * here touches the store; `repository.ts` writes what these describe.
 */

import { createHash } from "node:crypto"
import type { EpisodeEvent } from "./events"
import type { EpisodeSignal } from "./signals"

/** How many characters of text one slice keeps: past it the slice is cut and says so. */
export const EVIDENCE_SLICE_LIMIT = 8_192

/** How many slices one episode keeps, besides the explicit overflow marker. */
export const EVIDENCE_EPISODE_SLICE_LIMIT = 20

/** How many bytes of evidence the store keeps in all, before the oldest is evicted. */
export const EVIDENCE_TOTAL_LIMIT = 64 * 1024 * 1024

/** The one slice a capped episode gets, so the cap is visible rather than silent. */
export const EVIDENCE_OVERFLOW_CONTENT = "[evidence capped: more failures than the episode keeps]"

export type EvidenceKind = "signal" | "event" | "overflow"

export type EvidenceInput = { content: string; truncated?: boolean }

export type EvidenceCandidate = EvidenceInput & { kind: EvidenceKind; source?: string }

export type EvidenceLink = { hash: string; kind: EvidenceKind; source?: string; position: number }

export type EvidenceSlice = {
  hash: string
  content: string
  bytes?: number
  truncated?: boolean
  kind?: EvidenceKind
  source?: string
  createdAt: number
}

/** The content address of a slice: sha256 in hex, over the text that is actually stored. */
export function evidenceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export const EVIDENCE_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Whether a value could be a content address of ours; anything else is a row to skip, not to trust. */
export function isEvidenceHash(value: string): boolean {
  return typeof value === "string" && EVIDENCE_HASH_PATTERN.test(value)
}

/**
 * The stored form of a slice: cut to the character limit, told how big the original was in UTF-8
 * bytes, and marked truncated if it was cut or already said so. `bytes` is the real size so a reader
 * knows what was lost and the store's byte total stays honest with `EVIDENCE_TOTAL_LIMIT`.
 */
export function sliceEvidence(input: EvidenceInput): { content: string; bytes?: number; truncated: boolean } {
  const cut = input.content.length > EVIDENCE_SLICE_LIMIT
  return {
    content: cut ? input.content.slice(0, EVIDENCE_SLICE_LIMIT) : input.content,
    ...(cut ? { bytes: Buffer.byteLength(input.content, "utf8") } : {}),
    truncated: cut || input.truncated === true,
  }
}

/**
 * The slices a capture offers to the store: a shell that did not clearly succeed and an event that
 * said something. Successful shells, diffs and artifacts are left out — the same reading
 * `failuresFrom`/`failuresFromEvents` already make.
 */
export function evidenceCandidates(signals: EpisodeSignal[], events: EpisodeEvent[]): EvidenceCandidate[] {
  return [
    ...signals.flatMap((signal): EvidenceCandidate[] => {
      if (signal.tool !== "bash") return []
      if (!signal.out) return []
      if (signal.exit === 0) return []
      return [
        {
          content: signal.out,
          kind: "signal",
          ...(signal.command ? { source: signal.command } : {}),
          // The plugin already cut this tail; the slice must not claim to be whole.
          ...(signal.truncated ? { truncated: true } : {}),
        },
      ]
    }),
    ...events.flatMap((event): EvidenceCandidate[] => {
      if (!event.message) return []
      return [
        {
          content: event.message,
          kind: "event",
          source: event.kind === "tool.error" ? `tool:${event.tool}` : `session:${event.error}`,
        },
      ]
    }),
  ]
}
