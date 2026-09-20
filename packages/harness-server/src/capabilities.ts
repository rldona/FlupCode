/**
 * What this server can answer (H-18).
 *
 * A client can be newer than the server it talks to — a dev frontend against a packaged sidecar, or
 * an old install after an update — and asking for a route the server does not have is a 404 in every
 * browser console. `/harness/health` says what is here, so the client only asks for that.
 */
export const CAPABILITIES = ["session-prefs", "stash", "packs", "files"] as const

export type Capability = (typeof CAPABILITIES)[number]
