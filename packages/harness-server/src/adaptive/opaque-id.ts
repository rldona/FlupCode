/**
 * The opaque reference for an observed context value (FH-020).
 *
 * Context item ids name what a run or an episode touched, but a path, a command or a failure summary
 * is content: putting it in an id would ship it to Jev and keep it in the audit. The id is an HMAC
 * under the install's key — a keyless digest of a path or a command would be a dictionary oracle — so
 * a re-capture converges and `explain` shows a stable id, while the content stays in the episode and
 * is reached by `evidence_refs` (ADR-0017 §3). The key is never returned or logged.
 *
 * Extracted from `shadow.ts` so both classifiers and the shadow share one formula. The `file`,
 * `command` and `failure` literals are preserved verbatim from Phase 2: the rows already written
 * keep their ids.
 */

import { createHmac } from "node:crypto"

// The first argument stays a plain string: the Phase 2 discriminants `file`, `command` and
// `failure` are preserved by the callers, so already-written ids converge, while new classifiers
// (memory, artifact, handoff, …) pass their own.
export const opaqueItemID = (kind: string, value: string, key: Buffer): string =>
  `${kind}:${createHmac("sha256", key).update(value).digest("hex").slice(0, 16)}`
