import { createHarnessHandler } from "../../harness-server/src/api"
import { SqliteRoutineRepository } from "../../harness-server/src/repository"
import { RoutineScheduler } from "../../harness-server/src/scheduler"

/**
 * The harness a phone reaches over remote control (HE-02): the real harness-server routes, with the
 * UI's token and the remote scope's, over two runs held at a gate. Run with Bun by `e2e/remote.spec.ts`:
 *
 *   PORT=<port> bun e2e/remote-harness.fixture.ts
 *
 * The UI's token is `ui-token` and the remote scope's `remote-token`. No engine answers, so a run let
 * through its gate fails at its next task; that is the harness's doing, not the phone's.
 */
const repository = new SqliteRoutineRepository(":memory:")
const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })

const held = (workflow: string, task: string, startedAt: number) => {
  const run = repository.startRun({ type: "manual" }, startedAt, "/work/flupcode", {
    workflow: { name: workflow, scope: "project", hash: workflow, inputs: {} },
  })
  repository.addTasks(run.id, [
    { name: task, prompt: "go" },
    { name: "Ship", prompt: "go" },
  ])
  repository.awaitRun(run.id)
}
held("release", "Write the notes", Date.now() - 120_000)
held("nightly-review", "Review the diff", Date.now() - 60_000)

const server = Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch: createHarnessHandler(repository, scheduler, {
    hostname: "127.0.0.1",
    token: "ui-token",
    remoteToken: "remote-token",
  }),
})
console.log(`remote harness fixture on ${server.url}`)
const stop = () => {
  server.stop(true)
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
