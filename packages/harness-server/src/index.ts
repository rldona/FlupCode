import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { seedTemplates } from "./workflow"
import { createBrowserRuntime } from "./browser"
import type { BrowserRuntime } from "./browser"
import { browserTokenFile, readBrowserToken, readOrCreateBrowserToken } from "./browser-token"
import { createEgressGuard } from "./browser-egress"

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
}

export function createHarnessServer(options: HarnessServerOptions = {}) {
  const repository = new SqliteRoutineRepository(options.databasePath)
  const scheduler = new RoutineScheduler({
    repository,
    engineURL: options.engineURL ?? process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096",
    intervalMs: options.intervalMs,
  })
  scheduler.start()
  // Forget what was told to expire (H-14). At startup, so a server that was away for a while acts
  // on it, and hourly after that. Pinned ones are never touched, and nothing expires by default.
  repository.removeExpiredArtifacts()
  const sweep = setInterval(() => repository.removeExpiredArtifacts(), 60 * 60 * 1000)
  const browser = browserFrom(options, repository)
  const server = Bun.serve({
    port: options.port ?? Number(process.env.FLUPCODE_HARNESS_PORT ?? 4097),
    hostname: options.hostname ?? process.env.FLUPCODE_HARNESS_HOST ?? "127.0.0.1",
    fetch: createHarnessHandler(repository, scheduler, {
      ...(browser.runtime ? { browser: browser.runtime } : {}),
      ...(browser.token ? { token: browser.token } : {}),
    }),
  })
  return {
    server,
    repository,
    scheduler,
    ...(browser.runtime ? { browser: browser.runtime } : {}),
    stop: async () => {
      clearInterval(sweep)
      scheduler.stop()
      await browser.runtime?.stop().catch(() => undefined)
      repository.close()
      server.stop()
    },
  }
}

/**
 * The runtime and the token a browser needs, or neither.
 *
 * `FLUPCODE_BROWSER_DISABLED=1` is the kill switch WA-3 relies on: with it, no runtime is built and
 * `/harness/browser/*` falls through to the ordinary 404. Without a token the same is true: the
 * surface is only open when there is a secret to guard it, and this only reads one (WA-1).
 */
const browserFrom = (
  options: HarnessServerOptions,
  repository: SqliteRoutineRepository,
): { runtime?: BrowserRuntime; token?: string } => {
  if (process.env.FLUPCODE_BROWSER_DISABLED === "1") return {}
  const token = options.browserToken ?? readBrowserToken(options.browserTokenFile ?? browserTokenFile())
  if (!token) return {}
  return {
    runtime: createBrowserRuntime({
      repository,
      ...(options.browserDataDir ? { dataDir: options.browserDataDir } : {}),
      ...(options.browserExecutablePath ? { executablePath: options.browserExecutablePath } : {}),
      ...(options.browserIdleTimeoutMs ? { idleTimeoutMs: options.browserIdleTimeoutMs } : {}),
      egress: createEgressGuard(),
    }),
    token,
  }
}

const createBrowserToken = (): string | undefined => {
  try {
    return readOrCreateBrowserToken(browserTokenFile())
  } catch (cause) {
    console.warn(`Could not write the browser token: ${cause instanceof Error ? cause.message : String(cause)}`)
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
  const app = createHarnessServer({ browserToken: token })
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
