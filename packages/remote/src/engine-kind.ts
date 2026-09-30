/**
 * Which OpenCode line answers at an engine URL.
 *
 * FlupCode drives OpenCode 1.x: its legacy routes, its `/event` stream and its plugin loader.
 * OpenCode 2.x removes all three and rejects every FlupCode plugin, yet it installs the same
 * `opencode` command, so a user who installs it replaces the engine FlupCode starts. Without this
 * check that engine reads as "offline" and nothing says why (V2-00 in docs/V2-MIGRATION-AUDIT.md).
 */
export type EngineDetection = { kind: "v1"; version?: string } | { kind: "v2"; version: string } | { kind: "none" }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export async function detectEngine(
  baseUrl: string,
  fetchImpl: Fetch = fetch,
  init?: RequestInit,
): Promise<EngineDetection> {
  const base = baseUrl.replace(/\/+$/, "")
  // 1.x first, and alone when it answers: a 1.x engine proxies unknown paths such as `/api/info` to
  // its hosted web UI, so probing 2.x first would cost every healthy start a request to the internet.
  const health = await readJson(fetchImpl, `${base}/global/health`, init)
  if (health?.healthy === true)
    return { kind: "v1", version: typeof health.version === "string" ? health.version : undefined }
  const version = await openCodeV2Version(base, fetchImpl, init)
  if (version) return { kind: "v2", version }
  return { kind: "none" }
}

/**
 * The version an OpenCode 2.x engine reports on `/api/info`, or nothing.
 *
 * 1.x has no such route. Only a JSON body with a string `version` counts: a 1.x engine answers the
 * path with the HTML of its web UI, and a status code alone would read that as 2.x.
 */
export async function openCodeV2Version(baseUrl: string, fetchImpl: Fetch = fetch, init?: RequestInit) {
  const info = await readJson(fetchImpl, `${baseUrl.replace(/\/+$/, "")}/api/info`, init)
  return typeof info?.version === "string" ? info.version : undefined
}

async function readJson(fetchImpl: Fetch, url: string, init?: RequestInit) {
  const response = await fetchImpl(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(1500) }).catch(
    () => undefined,
  )
  if (!response?.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
    void response?.body?.cancel()
    return undefined
  }
  return (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
}
