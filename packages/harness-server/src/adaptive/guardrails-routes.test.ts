/**
 * The guardrails route (FH-060–063, ADR-0023 §2).
 *
 * The route is only the shape of the call: it takes the dedicated acting bearer (never the browser
 * one), refuses a malformed body or observation, refuses a project that is not an existing directory,
 * answers the service's advisory result, and is announced as its own capability only when both the
 * service and its token exist. Without a token the route is an ordinary 404 — fail-closed.
 */

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { GuardrailResult, GuardrailService, GuardrailStatus } from "./guardrails"
import type { LoopObservation } from "./guardrails-detector"

const PROJECT = tmpdir()
const ADAPTIVE = "adaptive-secret"

const result: GuardrailResult = {
  verdict: "intervene",
  reason: "loop",
  repeatedCalls: 3,
  repeatedErrors: 0,
  steps: "unsupported",
  decisionID: "failure:ses_1:bash:abc",
  source: "baseline",
  degraded: false,
  risk: { risk: "CONFIRM", raiseOnly: true },
  latencyMs: 1,
}

const service = (answer: GuardrailResult = result): GuardrailService => ({
  observe: async () => answer,
  status: () => null,
})

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const post = (body: unknown, token?: string, path = "/harness/adaptive/guardrails") =>
  new Request("http://x" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const DIGEST = "a".repeat(64)

const body = {
  projectID: PROJECT,
  sessionID: "ses_1",
  observation: { kind: "call", tool: "bash", argsDigest: DIGEST },
}

describe("the guardrails route (FH-060–063)", () => {
  test("answers a POST with the service result", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    const response = await handler(post(body, ADAPTIVE))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual(result)
    repository.close()
  })

  test("delivers a well-formed error observation to the service unchanged", async () => {
    const seen: LoopObservation[] = []
    const capturing: GuardrailService = {
      observe: async (input) => {
        seen.push(input.observation)
        return result
      },
      status: () => null,
    }
    const { repository, handler } = open({ guardrails: capturing, adaptiveToken: ADAPTIVE })
    const observation = { kind: "error", tool: "bash", errorDigest: "e".repeat(64), callID: "call_9" }
    const response = await handler(post({ ...body, observation }, ADAPTIVE))
    expect(response.status).toBe(200)
    expect(seen).toEqual([{ kind: "error", tool: "bash", errorDigest: "e".repeat(64), callID: "call_9" }])
    repository.close()
  })

  test("takes the dedicated bearer and refuses without it", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(post(body))).status).toBe(403)
    expect((await handler(post(body, "not-the-secret"))).status).toBe(403)
    expect((await handler(post(body, ADAPTIVE))).status).toBe(200)
    repository.close()
  })

  test("the browser bearer does not open the route", async () => {
    const { repository, handler } = open({
      token: "browser-secret",
      guardrails: service(),
      adaptiveToken: ADAPTIVE,
    })
    const browserBearer = await handler(post(body, "browser-secret"))
    expect(browserBearer.status).toBe(403)
    expect((await browserBearer.json()).code).toBe("invalid_token")
    repository.close()
  })

  test("is an ordinary 404 without a dedicated token, even with the service", async () => {
    const { repository, handler } = open({ guardrails: service() })
    expect((await handler(post(body))).status).toBe(404)
    expect((await handler(post(body, ADAPTIVE))).status).toBe(404)
    repository.close()
  })

  test("is an ordinary 404 without the service", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE })
    expect((await handler(post(body, ADAPTIVE))).status).toBe(404)
    repository.close()
  })

  test("is a 404 for a GET, a deeper path or an unknown method", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(new Request("http://x/harness/adaptive/guardrails"))).status).toBe(404)
    expect((await handler(post(body, ADAPTIVE, "/harness/adaptive/guardrails/extra"))).status).toBe(404)
    repository.close()
  })

  test("refuses a malformed body or a missing id", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(post({ projectID: PROJECT }, ADAPTIVE))).status).toBe(400)
    const notJson = new Request("http://x/harness/adaptive/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADAPTIVE}` },
      body: "{",
    })
    expect((await handler(notJson)).status).toBe(400)
    repository.close()
  })

  test("refuses a malformed observation or a digest that is not a sha256", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    const bad = [
      undefined,
      {},
      { kind: "call", tool: "bash" },
      { kind: "call", tool: "bash", argsDigest: "" },
      { kind: "error", tool: "bash", errorDigest: 7 },
      { kind: "other", tool: "bash", argsDigest: DIGEST },
      { kind: "call", tool: "", argsDigest: DIGEST },
      // Too short, too long, uppercase and non-hex are all not the sha256 the plugin sends.
      { kind: "call", tool: "bash", argsDigest: "a" },
      { kind: "call", tool: "bash", argsDigest: "d".repeat(129) },
      { kind: "call", tool: "bash", argsDigest: "A".repeat(64) },
      { kind: "call", tool: "bash", argsDigest: "g".repeat(64) },
    ]
    for (const observation of bad) {
      expect((await handler(post({ ...body, observation }, ADAPTIVE))).status, JSON.stringify(observation)).toBe(400)
    }
    repository.close()
  })

  test("refuses a project that is not an existing directory", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(post({ ...body, projectID: "work/project" }, ADAPTIVE))).status).toBe(400)
    expect((await handler(post({ ...body, projectID: join(PROJECT, "definitely-not-here") }, ADAPTIVE))).status).toBe(400)
    repository.close()
  })

  test("refuses an id past its limit", async () => {
    const { repository, handler } = open({ guardrails: service(), adaptiveToken: ADAPTIVE })
    expect((await handler(post({ ...body, sessionID: "s".repeat(201) }, ADAPTIVE))).status).toBe(400)
    repository.close()
  })

  describe("the read-only status route", () => {
    const status: GuardrailStatus = {
      reason: "loop",
      repeatedCalls: 3,
      repeatedErrors: 0,
      tool: "bash",
      decisionID: "failure:ses_1:bash:abc",
      risk: "ALLOW",
      at: 1,
    }

    const get = (token?: string, sessionID = "ses_1") =>
      new Request(`http://x/harness/adaptive/guardrails/status?sessionID=${sessionID}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })

    test("answers a GET with the service status, behind the artifacts bearer", async () => {
      const { repository, handler } = open({
        token: "browser-secret",
        guardrails: { observe: async () => result, status: () => status },
      })
      // No token configured in the request: refused, never the acting token's job.
      expect((await handler(get())).status).toBe(403)
      const response = await handler(get("browser-secret"))
      expect(response.status).toBe(200)
      expect((await response.json()).data).toEqual(status)
      repository.close()
    })

    test("null is a valid answer: no loop right now is not an error", async () => {
      const { repository, handler } = open({ guardrails: service() })
      const response = await handler(get())
      expect(response.status).toBe(200)
      expect((await response.json()).data).toBeNull()
      repository.close()
    })

    test("the acting token never opens the status route", async () => {
      const { repository, handler } = open({
        token: "browser-secret",
        guardrails: { observe: async () => result, status: () => status },
        adaptiveToken: ADAPTIVE,
      })
      // The dedicated acting bearer is for the POST that decides; the read-only side speaks the
      // artifacts bearer only.
      expect((await handler(get(ADAPTIVE))).status).toBe(403)
      expect((await handler(get("browser-secret"))).status).toBe(200)
      repository.close()
    })

    test("forwards the requested session id to the service", async () => {
      const seen: string[] = []
      const { repository, handler } = open({
        guardrails: {
          observe: async () => result,
          status: (sessionID) => {
            seen.push(sessionID)
            return null
          },
        },
      })
      const response = await handler(get(undefined, "ses_other"))
      expect(response.status).toBe(200)
      expect((await response.json()).data).toBeNull()
      expect(seen).toEqual(["ses_other"])
      repository.close()
    })

    test("refuses a missing sessionID and one past its limit", async () => {
      const { repository, handler } = open({ guardrails: service() })
      expect((await handler(new Request("http://x/harness/adaptive/guardrails/status"))).status).toBe(400)
      expect((await handler(get(undefined, "s".repeat(201)))).status).toBe(400)
      repository.close()
    })

    test("is an ordinary 404 without the service", async () => {
      const { repository, handler } = open({ adaptiveToken: ADAPTIVE })
      expect((await handler(get())).status).toBe(404)
      repository.close()
    })
  })

  test("health announces adaptive-guardrails only when the service and its token exist", async () => {
    const capabilitiesOf = async (options: HarnessHandlerOptions) => {
      const { repository, handler } = open(options)
      const capabilities = (await (await handler(new Request("http://x/harness/health"))).json()).capabilities
      repository.close()
      return capabilities
    }

    expect(await capabilitiesOf({})).not.toContain("adaptive-guardrails")
    expect(await capabilitiesOf({ guardrails: service() })).not.toContain("adaptive-guardrails")
    expect(await capabilitiesOf({ guardrails: service(), adaptiveToken: ADAPTIVE })).toContain("adaptive-guardrails")
  })
})
