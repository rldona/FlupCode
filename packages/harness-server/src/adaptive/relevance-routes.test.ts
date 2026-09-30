/**
 * The relevance route (FH-04, ADR-0021 §1 / ADR-0022 §1).
 *
 * The route is only the shape of the call: it takes the dedicated acting bearer (never the browser
 * one), refuses a malformed body, refuses a project that is not an existing directory (the curator
 * walks it), answers a POST with the service's result without the skill-name list, and is announced
 * as its own capability only when both the service and its token exist. Without a token the route is
 * an ordinary 404 — fail-closed, never an open loopback. Whether the line acts is the service's
 * decision, tested elsewhere.
 */

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { RelevanceResult, RelevanceService } from "./relevance"
import { RELEVANCE_RETRY_AFTER_MS } from "./relevance-routes"

const PROJECT = tmpdir()
/** The acting line's own secret; the browser/artifacts bearer is a different, unrelated one. */
const ADAPTIVE = "adaptive-secret"

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
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    const response = await handler(post(body, ADAPTIVE))
    expect(response.status).toBe(200)
    expect((await response.json()).data.line).toContain("testing")
    repository.close()
  })

  test("answers the result under data without the skill-name list", async () => {
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    const response = await handler(post(body, ADAPTIVE))
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

  test("an inert answer no turn can change carries a retry hint; a per-turn one does not", async () => {
    const inert = (reason: RelevanceResult["reason"]): RelevanceResult => ({ ...result, line: null, skills: [], reason })
    for (const reason of ["disabled", "runtime-not-legacy"] as const) {
      const { repository, handler } = open({ relevance: service(inert(reason)), adaptiveToken: ADAPTIVE })
      const data = (await (await handler(post(body, ADAPTIVE))).json()).data
      expect(data.line, reason).toBeNull()
      expect(data.retryAfterMs, reason).toBe(RELEVANCE_RETRY_AFTER_MS)
      repository.close()
    }
    // A miss, an empty roster or a failure is about this turn: the next one may differ, so no hint.
    for (const reason of ["no-match", "no-roster", "error", "ok"] as const) {
      const answer = reason === "ok" ? result : inert(reason)
      const { repository, handler } = open({ relevance: service(answer), adaptiveToken: ADAPTIVE })
      const data = (await (await handler(post(body, ADAPTIVE))).json()).data
      expect("retryAfterMs" in data, reason).toBe(false)
      repository.close()
    }
  })

  test("takes the dedicated bearer and refuses without it", async () => {
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    const forbidden = await handler(post(body))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const wrong = await handler(post(body, "not-the-secret"))
    expect(wrong.status).toBe(403)

    const allowed = await handler(post(body, ADAPTIVE))
    expect(allowed.status).toBe(200)
    repository.close()
  })

  test("a token of another purpose does not open the route", async () => {
    // The browser/artifacts bearer is a different secret (ADR-0022): holding it must not buy the line.
    const { repository, handler } = open({
      token: "browser-secret",
      relevance: service(),
      adaptiveToken: ADAPTIVE,
    })
    const browserBearer = await handler(post(body, "browser-secret"))
    expect(browserBearer.status).toBe(403)
    expect((await browserBearer.json()).code).toBe("invalid_token")

    // The route has its own bearer even when no browser token is configured at all.
    const dedicated = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    expect((await dedicated.handler(post(body, "browser-secret"))).status).toBe(403)
    expect((await dedicated.handler(post(body, ADAPTIVE))).status).toBe(200)
    repository.close()
    dedicated.repository.close()
  })

  test("is an ordinary 404 without a dedicated token, even with the service", async () => {
    // Fail-closed: no token resolved means the route is absent, never an open loopback.
    const { repository, handler } = open({ relevance: service() })
    expect((await handler(post(body))).status).toBe(404)
    expect((await handler(post(body, ADAPTIVE))).status).toBe(404)
    repository.close()
  })

  test("the dedicated token does not replace the shared bearer of the other surfaces", async () => {
    // `/artifacts` and `/events` keep their own browser bearer: the adaptive token must not open them,
    // and their guard must not have moved to it.
    const { repository, handler } = open({ token: "browser-secret", relevance: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(new Request("http://x/harness/events"))).status).toBe(403)
    expect((await handler(new Request("http://x/harness/artifacts"))).status).toBe(403)
    expect(
      (
        await handler(
          new Request("http://x/harness/events", { headers: { authorization: `Bearer ${ADAPTIVE}` } }),
        )
      ).status,
    ).toBe(403)
    repository.close()
  })

  test("is a 404 for a GET, a malformed body, a deeper path or an unknown method", async () => {
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(new Request("http://x/harness/adaptive/relevance"))).status).toBe(404)
    expect((await handler(post(body, ADAPTIVE, "/harness/adaptive/relevance/extra"))).status).toBe(404)
    expect((await handler(post({ projectID: PROJECT }, ADAPTIVE))).status).toBe(400)
    const notJson = new Request("http://x/harness/adaptive/relevance", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADAPTIVE}` },
      body: "{",
    })
    expect((await handler(notJson)).status).toBe(400)
    repository.close()
  })

  test("refuses a project that is not an existing directory", async () => {
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    const relative = await handler(post({ ...body, projectID: "work/project" }, ADAPTIVE))
    expect(relative.status).toBe(400)
    expect((await relative.json()).code).toBe("bad_request")

    const missing = await handler(post({ ...body, projectID: join(PROJECT, "definitely-not-here") }, ADAPTIVE))
    expect(missing.status).toBe(400)
    repository.close()
  })

  test("refuses an id or an objective past its limit", async () => {
    const { repository, handler } = open({ relevance: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(post({ ...body, sessionID: "s".repeat(201) }, ADAPTIVE))).status).toBe(400)
    expect((await handler(post({ ...body, messageID: "m".repeat(201) }, ADAPTIVE))).status).toBe(400)
    expect((await handler(post({ ...body, objective: "o".repeat(501) }, ADAPTIVE))).status).toBe(400)
    repository.close()
  })

  test("is an ordinary 404 without a relevance service", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE })
    expect((await handler(post(body, ADAPTIVE))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-relevance only when the service and its token exist", async () => {
    const capabilitiesOf = async (options: HarnessHandlerOptions) => {
      const { repository, handler } = open(options)
      const capabilities = (await (await handler(new Request("http://x/harness/health"))).json()).capabilities
      repository.close()
      return capabilities
    }

    expect(await capabilitiesOf({})).not.toContain("adaptive-relevance")
    expect(await capabilitiesOf({ relevance: service() })).not.toContain("adaptive-relevance")
    expect(await capabilitiesOf({ relevance: service(), adaptiveToken: ADAPTIVE })).toContain("adaptive-relevance")
  })
})
