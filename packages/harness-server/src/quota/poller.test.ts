import { describe, expect, test } from "bun:test"
import { SqliteRoutineRepository } from "../repository"
import type { QuotaRead } from "./adapters"
import { DEEPSEEK_BALANCE, OPENROUTER_KEY } from "./fixtures"
import { MIN_SPAN_MS } from "./forecast"
import { QUOTA_INTERVAL_MS, createQuotaPoller } from "./poller"

/**
 * The poller over a real repository, against an engine that answers as the quota plugin does. The
 * plugin itself, the engine's RPC and a fake provider together are in `quota.engine.test.ts`.
 */
function setup(answers: Record<string, QuotaRead | (() => QuotaRead)>, connected = Object.keys(answers)) {
  let clock = Date.UTC(2026, 9, 7, 12)
  const reads: string[] = []
  const repository = new SqliteRoutineRepository(":memory:")
  const engine = {
    connectedIntegrations: async () => connected.map((integrationID) => ({ integrationID, name: integrationID })),
    readQuota: async (integrationID: string) => {
      reads.push(integrationID)
      const answer = answers[integrationID]!
      return typeof answer === "function" ? answer() : answer
    },
  }
  const poller = createQuotaPoller({ engine, repository, now: () => clock })
  return { poller, reads, repository, advance: (ms: number) => (clock += ms), now: () => clock }
}

const openrouter = (usedRemaining = 12.5): QuotaRead => ({
  status: "read",
  account: "cred_1",
  httpStatus: 200,
  body: { data: { ...OPENROUTER_KEY.data, limit_remaining: usedRemaining } },
})

describe("the quota poller (UL-07)", () => {
  test("reads only the connected providers that have an adapter", async () => {
    const subject = setup(
      { openrouter: openrouter(), deepseek: { status: "read", account: "env:DEEPSEEK_API_KEY", httpStatus: 200, body: DEEPSEEK_BALANCE } },
      ["openrouter", "anthropic"],
    )
    await subject.poller.tick()
    // DeepSeek has an adapter but no connection; Anthropic has a connection but no adapter.
    expect(subject.reads).toEqual(["openrouter"])
    expect(subject.poller.report().map((entry) => entry.providerID)).toEqual(["openrouter"])
  })

  test("a reading is stored with its time, and the next one waits for the interval", async () => {
    const subject = setup({ openrouter: openrouter() })
    await subject.poller.tick()
    await subject.poller.tick()
    expect(subject.reads).toEqual(["openrouter"])
    const [entry] = subject.poller.report()
    expect(entry).toMatchObject({ providerID: "openrouter", sampledAt: subject.now(), docs: "https://openrouter.ai/docs/api-reference/limits" })
    expect(entry!.windows.map((window) => window.id)).toEqual(["free-requests", "key-limit"])
    subject.advance(QUOTA_INTERVAL_MS)
    await subject.poller.tick()
    expect(subject.reads).toEqual(["openrouter", "openrouter"])
  })

  test("samples over time give each window a pace and when it runs out", async () => {
    let remaining = 12.5
    const subject = setup({ openrouter: () => openrouter(remaining) })
    await subject.poller.tick()
    expect(subject.poller.report()[0]!.windows.find((window) => window.id === "key-limit")!.forecast).toBeNull()
    for (const _ of Array.from({ length: 6 })) {
      subject.advance(QUOTA_INTERVAL_MS)
      remaining -= 0.25
      await subject.poller.tick()
    }
    const limit = subject.poller.report()[0]!.windows.find((window) => window.id === "key-limit")!
    expect(6 * QUOTA_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_SPAN_MS)
    // 1.5 credits in 30 minutes: 3 an hour, with 11 left.
    expect(limit.forecast!.perHour).toBeCloseTo(3)
    expect(limit.forecast!.exhaustsAt).toBe(subject.now() + Math.round((11 / 3) * 3_600_000))
  })

  test("a failed read keeps the last good one beside the failure, and backs off", async () => {
    let fail = false
    const subject = setup({
      openrouter: () => (fail ? { status: "read", account: "cred_1", httpStatus: 401, body: { error: { message: "User not found." } } } : openrouter()),
    })
    await subject.poller.tick()
    const readAt = subject.now()
    fail = true
    subject.advance(QUOTA_INTERVAL_MS)
    await subject.poller.tick()
    const [entry] = subject.poller.report()
    expect(entry!.sampledAt).toBe(readAt)
    expect(entry!.windows.length).toBe(2)
    expect(entry!.error).toEqual({ message: "openrouter answered 401: User not found.", at: subject.now() })
    // After one failure the wait doubles: not read at the plain interval.
    subject.advance(QUOTA_INTERVAL_MS)
    await subject.poller.tick()
    expect(subject.reads.length).toBe(2)
    subject.advance(QUOTA_INTERVAL_MS)
    await subject.poller.tick()
    expect(subject.reads.length).toBe(3)
    // A read that works clears the failure.
    fail = false
    subject.advance(4 * QUOTA_INTERVAL_MS)
    await subject.poller.tick()
    expect(subject.poller.report()[0]!.error).toBeUndefined()
  })

  test("an answer that is not the documented shape is a failure, not an empty quota", async () => {
    const subject = setup({ openrouter: { status: "read", account: "cred_1", httpStatus: 200, body: { nothing: true } } })
    await subject.poller.tick()
    expect(subject.poller.report()[0]).toMatchObject({ sampledAt: null, windows: [], error: { message: "OpenRouter answered without data" } })
  })

  test("a sign-in the plugin will not resolve is left out", async () => {
    const subject = setup({ openrouter: { status: "unsupported" } })
    await subject.poller.tick()
    expect(subject.poller.report()).toEqual([])
  })
})
