/**
 * What this server can answer (H-18).
 *
 * A client can be newer than the server it talks to — a dev frontend against a packaged sidecar, or
 * an old install after an update — and asking for a route the server does not have is a 404 in every
 * browser console. `/harness/health` says what is here, so the client only asks for that.
 */
export const CAPABILITIES = ["session-prefs", "stash", "packs", "files", "shares", "memory", "config-files"] as const

/** `browser`, `web-actions` and `credentials` are not in the static list: each depends on whether its runtime or key was built (WA-1, WA-2, WA-5). */
export type Capability = (typeof CAPABILITIES)[number] | "browser" | "web-actions" | "credentials"
