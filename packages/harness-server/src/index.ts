import { createHarnessHandler } from "./api"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { seedTemplates } from "./workflow"

export type HarnessServerOptions = {
  port?: number
  hostname?: string
  databasePath?: string
  engineURL?: string
  intervalMs?: number
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
  const server = Bun.serve({
    port: options.port ?? Number(process.env.FLUPCODE_HARNESS_PORT ?? 4097),
    hostname: options.hostname ?? process.env.FLUPCODE_HARNESS_HOST ?? "127.0.0.1",
    fetch: createHarnessHandler(repository, scheduler),
  })
  return {
    server,
    repository,
    scheduler,
    stop: () => {
      clearInterval(sweep)
      scheduler.stop()
      repository.close()
      server.stop()
    },
  }
}

if (import.meta.main) {
  // Only here, and not in `createHarnessServer`: a test that builds a server would otherwise write
  // template files into whatever home directory it is running in. That is how fixtures ended up in
  // somebody's real routines once already.
  const seeded = seedTemplates()
  if (seeded.length > 0) console.log(`Wrote workflow templates: ${seeded.join(", ")}`)
  const app = createHarnessServer()
  console.log(`FlupCode harness server listening on ${app.server.url}`)
}
