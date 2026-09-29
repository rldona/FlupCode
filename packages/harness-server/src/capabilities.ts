/**
 * What this server can answer (H-18).
 *
 * A client can be newer than the server it talks to — a dev frontend against a packaged sidecar, or
 * an old install after an update — and asking for a route the server does not have is a 404 in every
 * browser console. `/harness/health` says what is here, so the client only asks for that.
 */
export const CAPABILITIES = ["session-prefs", "stash", "packs", "files", "shares", "memory", "config-files"] as const

/** `browser`, `web-actions`, `credentials`, `action-profiles`, `adaptive`, `adaptive-config`, `adaptive-decisions`, `adaptive-context`, `adaptive-proposals`, `adaptive-skills`, `adaptive-relevance` and `adaptive-guardrails` are not in the static list: each depends on whether its runtime, key, bearer or probe was built (WA-1, WA-2, WA-5, WA-8, FH-000, FH-070, FH-015, FH-022, FH-034, FH-04, FH-060–063). */
export type Capability =
  | (typeof CAPABILITIES)[number]
  | "browser"
  | "web-actions"
  | "credentials"
  | "action-profiles"
  | "adaptive"
  | "adaptive-config"
  | "adaptive-decisions"
  | "adaptive-context"
  | "adaptive-proposals"
  | "adaptive-skills"
  | "adaptive-relevance"
  | "adaptive-guardrails"
