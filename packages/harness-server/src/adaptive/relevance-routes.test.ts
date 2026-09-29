/**
 * The relevance route (FH-04, ADR-0021 §1).
 *
 * The route is only the shape of the call: it is bearer-guarded like the other adaptive surfaces,
 * refuses a malformed body, refuses a project that is not an existing directory (the curator walks
 * it), answers a POST with the service's result without the skill-name list, and is announced as its
 * own capability. Whether the line acts is the service's decision, tested elsewhere.
 */

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { RelevanceResult, RelevanceService } from "./relevance"

const PROJECT = tmpdir()

const result: RelevanceResult = {
  line: "<skill_relevance>Possibly relevant skills: testing. Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>",
  decisionID: "skillRelevance:ses_1:msg_1",
  source: "deterministic",
  degraded: false,
  skills: ["testing"],
  reason: "ok",
  latencyMs: 1,
}

const service = (answer: RelevanceResult = result): RelevanceService => ({ suggest: async () => answer })

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const post = (body: unknown, token?: string, path = "/harness/adaptive/relevance") =>
  new Request("http://x" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const body = { projectID: PROJECT, sessionID: "ses_1", messageID: "msg_1", objective: "fix it" }

describe("the relevance route (FH-04)", () => {
  test("answers a POST with the service result", async () => {
    const { repository, handler } = open({ relevance: service() })
    const response = await handler(post(body))
    expect(response.status).toBe(200)
    expect((await response.json()).data.line).toContain("testing")
    repository.close()
  })

  test("answers the result under data without the skill-name list", async () => {
    const { repository, handler } = open({ relevance: service() })
    const response = await handler(post(body))
    // `skills` is dropped: the plugin reads only `line`, and the list is an enumeration surface.
    expect(await response.json()).toEqual({
      data: {
        line: result.line,
        decisionID: result.decisionID,
        source: result.source,
        degraded: result.degraded,
        reason: result.reason,
        latencyMs: result.latencyMs,
      },
    })
    repository.close()
  })

  test("takes the bearer when one is configured and refuses without it", async () => {
    const { repository, handler } = open({ token: "secret", relevance: service() })
    const forbidden = await handler(post(body))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const wrong = await handler(post(body, "not-the-secret"))
    expect(wrong.status).toBe(403)

    const allowed = await handler(post(body, "secret"))
    expect(allowed.status).toBe(200)
    repository.close()
  })

  test("is a 404 for a GET, a malformed body, a deeper path or an unknown method", async () => {
    const { repository, handler } = open({ relevance: service() })
    expect((await handler(new Request("http://x/harness/adaptive/relevance"))).status).toBe(404)
    expect((await handler(post(body, undefined, "/harness/adaptive/relevance/extra"))).status).toBe(404)
    expect((await handler(post({ projectID: PROJECT }))).status).toBe(400)
    const notJson = new Request("http://x/harness/adaptive/relevance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect((await handler(notJson)).status).toBe(400)
    repository.close()
  })

  test("refuses a project that is not an existing directory", async () => {
    const { repository, handler } = open({ relevance: service() })
    const relative = await handler(post({ ...body, projectID: "work/project" }))
    expect(relative.status).toBe(400)
    expect((await relative.json()).code).toBe("bad_request")

    const missing = await handler(post({ ...body, projectID: join(PROJECT, "definitely-not-here") }))
    expect(missing.status).toBe(400)
    repository.close()
  })

  test("refuses an id or an objective past its limit", async () => {
    const { repository, handler } = open({ relevance: service() })
    expect((await handler(post({ ...body, sessionID: "s".repeat(201) }))).status).toBe(400)
    expect((await handler(post({ ...body, messageID: "m".repeat(201) }))).status).toBe(400)
    expect((await handler(post({ ...body, objective: "o".repeat(501) }))).status).toBe(400)
    repository.close()
  })

  test("is an ordinary 404 without a relevance service", async () => {
    const { repository, handler } = open()
    expect((await handler(post(body))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-relevance only when the service exists", async () => {
    const without = open()
    expect((await (await without.handler(new Request("http://x/harness/health"))).json()).capabilities).not.toContain(
      "adaptive-relevance",
    )
    without.repository.close()

    const withService = open({ relevance: service() })
    expect((await (await withService.handler(new Request("http://x/harness/health"))).json()).capabilities).toContain(
      "adaptive-relevance",
    )
    withService.repository.close()
  })
})
