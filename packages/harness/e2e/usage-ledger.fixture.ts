import { createHarnessHandler } from "../../harness-server/src/api"
import { SqliteRoutineRepository } from "../../harness-server/src/repository"
import { RoutineScheduler } from "../../harness-server/src/scheduler"
import type { LedgerEvent } from "../../harness-server/src/usage-ledger"

/**
 * The Cost screen's e2e harness (UL-06): the real harness-server routes over a fixture ledger in
 * memory, so what the app draws is what the summary, session and run reads really answer. Run with
 * Bun by `e2e/usage.spec.ts`:
 *
 *   PORT=<port> bun e2e/usage-ledger.fixture.ts
 *
 * The ledger, relative to now (a day is a local day):
 * - run "feature" (one task, session `ses_task_a` with a subagent): $0.30 pay-per-use and $0.05 of
 *   its subagent, plus $0.12 on a Copilot subscription — yesterday;
 * - run "review" (task `ses_task_b`, $0.08, over its $0.05 budget) with a handoff on a local model
 *   nobody priced — 3 days ago;
 * - a chat in another project, $0.50, then two unpriced local calls and a $0.02 compaction today;
 * - an old chat, $1.00, 20 days ago (inside 30 days, outside 7).
 */
const now = Date.now()
const daysAgo = (days: number) => {
  const at = new Date(now)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() - days, 12).getTime()
}

const repository = new SqliteRoutineRepository(":memory:")
const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })

const feature = repository.startRun({ type: "manual" }, daysAgo(1), "/work/flupcode", {
  workflow: { name: "feature", scope: "project", hash: "sha256-feature", inputs: { goal: "login" } },
})
const [write] = repository.addTasks(feature.id, [{ name: "write", prompt: "p", agent: "build" }])
repository.startTask(write!.id, daysAgo(1))
repository.attachTaskSession(write!.id, "ses_task_a")
repository.finishTask(write!.id, "success", {}, daysAgo(1) + 60_000)
repository.finishRun(feature.id, "success", undefined, daysAgo(1) + 60_000)

const review = repository.startRun({ type: "manual" }, daysAgo(3), "/work/flupcode", {
  workflow: { name: "review", scope: "project", hash: "sha256-review", inputs: {} },
  // A budget it went past (UL-08): the card draws it as a meter at its limit.
  policy: { budget: { cost: 0.05, softPct: 50 } },
})
const [check] = repository.addTasks(review.id, [{ name: "check", prompt: "p", agent: "plan" }])
repository.startTask(check!.id, daysAgo(3))
repository.attachTaskSession(check!.id, "ses_task_b")
repository.finishTask(check!.id, "success", {}, daysAgo(3) + 30_000)
repository.attributeSession("ses_handoff_b", { runID: review.id, purpose: "handoff" })
repository.finishRun(review.id, "success", undefined, daysAgo(3) + 60_000)

repository.attributeSession("ses_chat", { purpose: "chat", directory: "/work/landing" })
repository.attributeSession("ses_old", { purpose: "chat", directory: "/work/flupcode" })
repository.attributeSession("ses_task_a_sub", { parentSessionID: "ses_task_a" }, "engine")

let counter = 0
const step = (sessionID: string, at: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: `${sessionID}:step:${++counter}`,
  kind: "step",
  sessionID,
  agent: "build",
  providerID: "anthropic",
  modelID: "sonnet",
  tokens: { input: 1200, output: 300, reasoning: 0, cacheRead: 4000, cacheWrite: 0 },
  costUSD: 0.1,
  costBasis: "engine-list-price",
  billing: "metered",
  startedAt: at - 5_000,
  endedAt: at,
  directory: "/work/flupcode",
  ...extra,
})

repository.recordUsage({
  events: [
    step("ses_task_a", daysAgo(1), { costUSD: 0.3 }),
    step("ses_task_a", daysAgo(1) + 1_000, {
      providerID: "github-copilot",
      modelID: "gpt-5",
      costUSD: 0.12,
      billing: "subscription",
    }),
    step("ses_task_a_sub", daysAgo(1) + 2_000, { parentSessionID: "ses_task_a", agent: "explore", costUSD: 0.05 }),
    step("ses_task_b", daysAgo(3), { agent: "plan", costUSD: 0.08 }),
    step("ses_handoff_b", daysAgo(3) + 1_000, {
      providerID: "local",
      modelID: "llama",
      costUSD: undefined,
      costBasis: "unpriced",
      billing: "local",
    }),
    step("ses_chat", daysAgo(2), { costUSD: 0.5, directory: "/work/landing" }),
    ...[1, 2].map((offset) =>
      step("ses_chat", daysAgo(0) - offset * 1_000, {
        providerID: "local",
        modelID: "llama",
        costUSD: undefined,
        costBasis: "unpriced",
        billing: "local",
        directory: "/work/landing",
      }),
    ),
    step("ses_chat", daysAgo(0), { kind: "compaction", costUSD: 0.02, directory: "/work/landing" }),
    step("ses_old", daysAgo(20), { costUSD: 1 }),
  ],
  tools: [],
})

const server = Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch: createHarnessHandler(repository, scheduler, { hostname: "127.0.0.1" }),
})
console.log(`usage ledger fixture on ${server.url}`)
const stop = () => {
  server.stop(true)
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
