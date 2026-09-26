import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { seedTemplates } from "./workflow"
import { createBrowserRuntime, resolveBrowserExecutable } from "./browser"
import type { BrowserRuntime } from "./browser"
import { browserTokenFile, readBrowserToken, readOrCreateBrowserToken } from "./browser-token"
import { createEgressGuard } from "./browser-egress"
import { createActionRunner } from "./action-runner"
import type { ActionRunner } from "./action-runner"
import { unavailableActionCredentialResolver } from "./action-credentials"
import type { ActionCredentialResolver } from "./action-credentials"
import { createVault, parseVaultKey, readOrCreateVaultKeyFile, readVaultKeyFile, vaultKeyFile } from "./vault"
import type { CredentialVault } from "./vault"
import { loadActionProfiles } from "./config-files"

export type HarnessServerOptions = {
  port?: number
  hostname?: string
  databasePath?: string
  engineURL?: string
  intervalMs?: number
  browserToken?: string
  browserTokenFile?: string
  browserDataDir?: string
  browserExecutablePath?: string
  browserIdleTimeoutMs?: number
  actionCredentials?: ActionCredentialResolver
  vaultKey?: string
  vaultKeyFile?: string
}

export function createHarnessServer(options: HarnessServerOptions = {}) {
  const repository = new SqliteRoutineRepository(options.databasePath)
  // Forget what was told to expire (H-14). At startup, so a server that was away for a while acts
  // on it, and hourly after that. Pinned ones are never touched, and nothing expires by default.
  repository.removeExpiredArtifacts()
  const sweep = setInterval(() => repository.removeExpiredArtifacts(), 60 * 60 * 1000)
  const browser = browserFrom(options, repository)
  // Read apart from the runtime: the same bearer guards the artifact routes (WA-9), and it is worth
  // passing even when there is no browser to guard, so the token is not lost with the runtime.
  const browserToken = options.browserToken ?? readBrowserToken(options.browserTokenFile ?? browserTokenFile())
  // A vault exists only when there is a key to open it: without one, a profile that names a
  // credential fails closed rather than running with an empty field, and `/harness/credentials/*`
  // is an ordinary 404 (WA-5).
  const key = parseVaultKey(options.vaultKey) ?? (() => {
    const raw = readVaultKeyFile(options.vaultKeyFile ?? vaultKeyFile())
    return parseVaultKey(raw)
  })()
  const vault: CredentialVault | undefined = key ? createVault({ store: repository, key }) : undefined
  const credentials = vault ?? options.actionCredentials ?? unavailableActionCredentialResolver
  // The runner needs a browser to drive, so it exists only when the runtime does. Without it
  // `/harness/actions/*` is an ordinary 404, and credentials fail closed (WA-2).
  const actions: ActionRunner | undefined = browser
    ? createActionRunner({
        browser,
        repository,
        credentials,
        loadProfiles: loadActionProfiles,
      })
    : undefined
  // Built after the actions so a scheduled action is driven in process by the same runner the
  // interactive path uses (WA-7), never by a second copy that would drift.
  const scheduler = new RoutineScheduler({
    repository,
    engineURL: options.engineURL ?? process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096",
    intervalMs: options.intervalMs,
    ...(actions ? { actions } : {}),
  })
  scheduler.start()
  const server = Bun.serve({
    port: options.port ?? Number(process.env.FLUPCODE_HARNESS_PORT ?? 4097),
    hostname: options.hostname ?? process.env.FLUPCODE_HARNESS_HOST ?? "127.0.0.1",
    fetch: createHarnessHandler(repository, scheduler, {
      ...(browser ? { browser } : {}),
      ...(browserToken ? { token: browserToken } : {}),
      ...(actions ? { actions } : {}),
      ...(vault ? { credentials: vault } : {}),
    }),
  })
  return {
    server,
    repository,
    scheduler,
    ...(browser ? { browser } : {}),
    ...(actions ? { actions } : {}),
    ...(vault ? { vault } : {}),
    stop: async () => {
      clearInterval(sweep)
      scheduler.stop()
      await browser?.stop().catch(() => undefined)
      repository.close()
      server.stop()
    },
  }
}

/**
 * The browser runtime, or none.
 *
 * `FLUPCODE_BROWSER_DISABLED=1` is the kill switch WA-3 relies on: with it, no runtime is built and
 * `/harness/browser/*` falls through to the ordinary 404. Without a token the same is true: the
 * surface is only open when there is a secret to guard it (WA-1). The token itself is read apart, so
 * it still guards the artifact routes even when there is no runtime to guard (WA-9).
 */
const browserFrom = (
  options: HarnessServerOptions,
  repository: SqliteRoutineRepository,
): BrowserRuntime | undefined => {
  if (process.env.FLUPCODE_BROWSER_DISABLED === "1") return undefined
  const token = options.browserToken ?? readBrowserToken(options.browserTokenFile ?? browserTokenFile())
  if (!token) return undefined
  // Which browser to drive (WA-9): an explicit path, then the environment, then the Chromium that
  // ships with the app, and finally the system's Chrome.
  const executablePath = resolveBrowserExecutable({
    option: options.browserExecutablePath,
    env: process.env.FLUPCODE_BROWSER_EXECUTABLE_PATH,
  })
  return createBrowserRuntime({
    repository,
    ...(options.browserDataDir ? { dataDir: options.browserDataDir } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(options.browserIdleTimeoutMs ? { idleTimeoutMs: options.browserIdleTimeoutMs } : {}),
    egress: createEgressGuard(),
  })
}

const createBrowserToken = (): string | undefined => {
  // The desktop that also shows the live view generates the token and sends it, so both sides
  // compare the same secret; on its own the harness creates one as before (WA-6).
  const fromEnv = process.env.FLUPCODE_BROWSER_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    return readOrCreateBrowserToken(browserTokenFile())
  } catch (cause) {
    console.warn(`Could not write the browser token: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/**
 * The key the desktop injected, when it is one, and otherwise the file this process owns.
 *
 * The desktop sends `FLUPCODE_VAULT_KEY` on the platforms where `safeStorage` holds it, so the
 * harness opens the same vault. macOS (and any machine without a usable keychain) sends nothing,
 * and the entrypoint creates its own file. A read-only config directory starts without a vault.
 */
const createVaultKey = (): string | undefined => {
  const fromEnv = process.env.FLUPCODE_VAULT_KEY
  if (parseVaultKey(fromEnv)) return fromEnv
  try {
    return readOrCreateVaultKeyFile(vaultKeyFile())
  } catch (cause) {
    console.warn(`Could not write the vault key: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

if (import.meta.main) {
  // Only here, and not in `createHarnessServer`: a test that builds a server would otherwise write
  // template files into whatever home directory it is running in. That is how fixtures ended up in
  // somebody's real routines once already.
  const seeded = seedTemplates()
  if (seeded.length > 0) console.log(`Wrote workflow templates: ${seeded.join(", ")}`)
  // The entrypoint is the one place that writes the secret; a read-only config dir must not stop
  // the harness from serving everything else, so it starts without a browser instead.
  const token = createBrowserToken()
  const vaultKey = createVaultKey()
  const app = createHarnessServer({ ...(token ? { browserToken: token } : {}), ...(vaultKey ? { vaultKey } : {}) })
  console.log(`FlupCode harness server listening on ${app.server.url}`)
  // Playwright swallows SIGTERM, so without this the browser outlives the server that owns it.
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void app.stop().then(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
