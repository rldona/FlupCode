/**
 * The per-step selection policy over HTTP (AH-D03, ADR-0024).
 *
 * The plugin reads it on a timer with the dedicated adaptive bearer; the route serves exactly the
 * shape the plugin accepts, and it exists only with a token.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { DEFAULT_SELECTION_CONFIG } from "./config"

const ADAPTIVE = "adaptive-secret"
const BROWSER = "browser-secret"

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const get = (token?: string) =>
  new Request("http://127.0.0.1:4097/harness/adaptive/selection", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

describe("the selection policy route", () => {
  test("serves the effective policy to the adaptive bearer only", async () => {
    const policy = { ...DEFAULT_SELECTION_CONFIG, enabled: true, coldGapMs: 360_000 }
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, token: BROWSER, selectionPolicy: () => policy })
    const response = await handler(get(ADAPTIVE))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      enabled: true,
      keepRecentTurns: 2,
      minSavingsTokens: 4_096,
      coldGapMs: 360_000,
      pausedSessions: [],
    })
    expect((await handler(get(BROWSER))).status).toBe(403)
    expect((await handler(get())).status).toBe(403)
    const health = await (await handler(new Request("http://127.0.0.1:4097/harness/health"))).json()
    expect(health.capabilities).toContain("adaptive-selection")
    repository.close()
  })

  test("without the adaptive token there is no route and no capability", async () => {
    const { repository, handler } = open({ selectionPolicy: () => DEFAULT_SELECTION_CONFIG })
    expect((await handler(get(ADAPTIVE))).status).toBe(404)
    const health = await (await handler(new Request("http://127.0.0.1:4097/harness/health"))).json()
    expect(health.capabilities).not.toContain("adaptive-selection")
    repository.close()
  })
})
