import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * What a host (the desktop app, `flupcode serve`) needs to start the harness server beside the engine
 * (HE-01): where it is, the environment it runs with, and the engine's environment, which must not
 * carry the harness's secrets. One implementation, so both hosts start the same thing the same way.
 */

/** The harness's secrets, which no engine process (and so no agent's shell) is handed (TI-10). */
const HARNESS_SECRETS = ["FLUPCODE_BROWSER_TOKEN", "FLUPCODE_PLUGIN_TOKEN", "FLUPCODE_ENGINE_AUTH", "FLUPCODE_VAULT_KEY"]

export function withoutHarnessSecrets(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !HARNESS_SECRETS.includes(name)))
}

/**
 * The harness server to start: `FLUPCODE_HARNESS_SERVER`, the first compiled binary of `binaries`
 * that exists, or the checkout's source run by Bun. Undefined when there is none.
 */
export function resolveHarnessServer(input: {
  binaries: string[]
  /** `packages/harness-server` in a checkout. */
  checkout: string
  bun?: string
  env?: NodeJS.ProcessEnv
}): { command: string; args: string[]; cwd?: string } | undefined {
  const env = input.env ?? process.env
  if (env.FLUPCODE_HARNESS_SERVER) return { command: env.FLUPCODE_HARNESS_SERVER, args: [] }
  const binary = input.binaries.find((file) => existsSync(file))
  if (binary) return { command: binary, args: [] }
  if (!existsSync(join(input.checkout, "src", "index.ts"))) return undefined
  return { command: env.FLUPCODE_BUN ?? input.bun ?? "bun", args: ["run", "./src/index.ts"], cwd: input.checkout }
}

/**
 * The harness server's environment: the engine it drives on the scheduler's behalf and the Basic
 * credential (`base64(user:pass)`) it signs in with, the port it listens on, and the secrets the host
 * holds for it.
 */
export function harnessServerEnv(input: {
  env: NodeJS.ProcessEnv
  engineUrl: string
  port: number | string
  authorization?: string
  browserToken?: string
  vaultKey?: string
  /** Where Playwright finds the Chromium the host ships. */
  browsers?: string
}) {
  return {
    ...input.env,
    FLUPCODE_ENGINE_URL: input.engineUrl,
    FLUPCODE_HARNESS_PORT: String(input.port),
    ...(input.browserToken ? { FLUPCODE_BROWSER_TOKEN: input.browserToken } : {}),
    ...(input.authorization ? { FLUPCODE_ENGINE_AUTH: input.authorization } : {}),
    ...(input.browsers ? { PLAYWRIGHT_BROWSERS_PATH: input.browsers } : {}),
    ...(input.vaultKey ? { FLUPCODE_VAULT_KEY: input.vaultKey } : {}),
  }
}

/**
 * The engine's environment when a harness runs beside it: none of the harness's secrets, and where
 * the harness answers, which the actions plugin asks for its profiles. The plugins read their own
 * scoped token from its file (TI-10).
 */
export function engineEnvBesideHarness(env: NodeJS.ProcessEnv, harnessUrl: string): NodeJS.ProcessEnv {
  return { ...withoutHarnessSecrets(env), FLUPCODE_HARNESS_SERVER_URL: harnessUrl }
}

/** Whether a harness server answers its health check at `url`. */
export async function harnessHealthy(url: string) {
  const response = await fetch(`${url}/harness/health`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined)
  return response?.ok === true
}

/**
 * The harness's `remote`-scoped bearer (HE-02), from the file the harness writes in FlupCode's config
 * folder: what the remote host calls the harness with for a paired phone. Read on each call, so a
 * harness started after the host, or one that made a new token, is picked up. Nothing when absent.
 */
export function readRemoteToken(configDir: string) {
  const file = join(configDir, "remote-token")
  if (!existsSync(file)) return undefined
  return readFileSync(file, "utf8").trim() || undefined
}
