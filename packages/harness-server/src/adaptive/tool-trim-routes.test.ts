/**
 * The recoverable tool-output trim over HTTP and the store (AH-D02).
 *
 * The routes take the dedicated adaptive bearer, trim only when the config says so and only after the
 * whole output is stored, and read a ref back only to the session that stored it. Every ref handed
 * out reads back byte for byte until the global evidence total evicts it.
 */

import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { resolveAdaptiveConfig, TOOL_TRIM_MAX_STORED_BYTES } from "./config"

const ADAPTIVE = "adaptive-secret"
const BROWSER = "browser-secret"

const configWith = (toolTrim: Record<string, unknown>, enabled = true) => () =>
  resolveAdaptiveConfig({ block: { enabled, toolTrim: { enabled: true, thresholdBytes: 4_096, ...toolTrim } }, env: {} })

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

const post = (path: string, body: unknown, token: string | undefined = ADAPTIVE) =>
  new Request("http://127.0.0.1:4097" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const trim = (body: unknown, token?: string) => post("/harness/adaptive/tool-trim", body, token)
const read = (body: unknown, token?: string) => post("/harness/adaptive/evidence/read", body, token)

const bigOutput = (lines = 400) =>
  Array.from({ length: lines }, (_, index) => `row ${index + 1}: ${"v".repeat(60)}`).join("\n")

describe("the tool-trim route", () => {
  test("stores a large output and answers a replacement that names a readable ref", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: configWith({}) })
    const output = bigOutput()
    const response = await handler(trim({ sessionID: "ses_1", tool: "bash", output }))
    expect(response.status).toBe(200)
    const data = (await response.json()).data
    expect(data.trimmed).toBe(true)
    expect(data.ref).toMatch(/^[0-9a-f]{16}$/)
    expect(data.replacement).toContain(`evidence:${data.ref}`)
    expect(data.replacement).toContain("evidence_read")
    expect(data.replacement.length).toBeLessThan(output.length)
    expect(data.policy).toMatchObject({ thresholdBytes: 4_096 })
    expect(repository.getToolEvidence("ses_1", data.ref)?.content).toBe(output)
    repository.close()
  })

  test("leaves an output whole when the trim is off, and asks the plugin to stay quiet", async () => {
    for (const config of [configWith({ enabled: false }), configWith({}, false)]) {
      const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: config })
      const data = (await (await handler(trim({ sessionID: "ses_1", tool: "bash", output: bigOutput() }))).json()).data
      expect(data).toMatchObject({ trimmed: false, reason: "disabled" })
      expect(data.retryAfterMs).toBeGreaterThan(0)
      expect(repository.db.query("SELECT COUNT(*) AS n FROM tool_evidence").get()).toEqual({ n: 0 })
      repository.close()
    }
  })

  test("an exempt tool, a small output and an oversized one are never stored", async () => {
    const { repository, handler } = open({
      adaptiveToken: ADAPTIVE,
      toolTrimConfig: configWith({ maxStoredBytes: 20_000 }),
    })
    const answer = async (tool: string, output: string) =>
      (await (await handler(trim({ sessionID: "ses_1", tool, output }))).json()).data
    expect(await answer("read", bigOutput())).toMatchObject({ trimmed: false, reason: "exempt" })
    expect(await answer("evidence_read", bigOutput())).toMatchObject({ trimmed: false, reason: "exempt" })
    expect(await answer("bash", "small")).toMatchObject({ trimmed: false, reason: "below-threshold" })
    expect(await answer("bash", bigOutput(1_000))).toMatchObject({ trimmed: false, reason: "too-large" })
    expect(repository.db.query("SELECT COUNT(*) AS n FROM tool_evidence").get()).toEqual({ n: 0 })
    repository.close()
  })

  test("a store that cannot keep the whole output answers untrimmed", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: configWith({}) })
    repository.db.exec("DROP TABLE tool_evidence")
    const data = (await (await handler(trim({ sessionID: "ses_1", tool: "bash", output: bigOutput() }))).json()).data
    expect(data).toMatchObject({ trimmed: false, reason: "store-failed" })
    repository.close()
  })

  test("takes only the adaptive bearer and refuses a malformed body", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, token: BROWSER, toolTrimConfig: configWith({}) })
    const body = { sessionID: "ses_1", tool: "bash", output: bigOutput() }
    expect((await handler(trim(body, BROWSER))).status).toBe(403)
    expect((await handler(post("/harness/adaptive/tool-trim", body, ""))).status).toBe(403)
    expect((await handler(trim({ sessionID: "ses_1", tool: "bash", output: 42 }))).status).toBe(400)
    expect((await handler(trim({ sessionID: "x".repeat(201), tool: "bash", output: "a" }))).status).toBe(400)
    repository.close()
  })

  test("without the adaptive token there is no route and no capability", async () => {
    const { repository, handler } = open({ toolTrimConfig: configWith({}) })
    expect((await handler(trim({ sessionID: "ses_1", tool: "bash", output: bigOutput() }))).status).toBe(404)
    expect((await handler(read({ sessionID: "ses_1", ref: "0".repeat(16) }))).status).toBe(404)
    const health = await (await handler(new Request("http://127.0.0.1:4097/harness/health"))).json()
    expect(health.capabilities).not.toContain("adaptive-tool-trim")
    repository.close()

    const withToken = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: configWith({}) })
    const announced = await (await withToken.handler(new Request("http://127.0.0.1:4097/harness/health"))).json()
    expect(announced.capabilities).toContain("adaptive-tool-trim")
    withToken.repository.close()
  })
})

describe("the evidence read route", () => {
  const stored = async (handler: (request: Request) => Promise<Response>, sessionID = "ses_1", output = bigOutput()) =>
    (await (await handler(trim({ sessionID, tool: "bash", output }))).json()).data.ref as string

  test("reads a range of the stored output back, with or without the evidence: prefix", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: configWith({}) })
    const ref = await stored(handler)
    for (const named of [ref, `evidence:${ref}`]) {
      const response = await handler(read({ sessionID: "ses_1", ref: named, range: "200-201" }))
      expect(response.status).toBe(200)
      const text = (await response.json()).data.text
      expect(text).toContain(`lines 200-201 of 400`)
      expect(text).toContain("row 200:")
      expect(text).toContain("row 201:")
    }
    repository.close()
  })

  test("another session cannot read the ref, even with the token", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: configWith({}) })
    const ref = await stored(handler)
    const response = await handler(read({ sessionID: "ses_2", ref, range: "1-5" }))
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe("evidence_not_found")
    repository.close()
  })

  test("a ref stays readable after the trim is turned off", async () => {
    let enabled = true
    const config = () =>
      resolveAdaptiveConfig({ block: { toolTrim: { enabled, thresholdBytes: 4_096 } }, env: {} })
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, toolTrimConfig: config })
    const ref = await stored(handler)
    enabled = false
    expect((await handler(read({ sessionID: "ses_1", ref, range: "1-1" }))).status).toBe(200)
    repository.close()
  })

  test("refuses a ref that is not one of ours, the browser bearer and an overlong range", async () => {
    const { repository, handler } = open({ adaptiveToken: ADAPTIVE, token: BROWSER, toolTrimConfig: configWith({}) })
    const ref = await stored(handler)
    expect((await handler(read({ sessionID: "ses_1", ref: "../../etc" }))).status).toBe(400)
    expect((await handler(read({ sessionID: "ses_1", ref }, BROWSER))).status).toBe(403)
    expect((await handler(read({ sessionID: "ses_1", ref, range: "1".repeat(65) }))).status).toBe(400)
    repository.close()
  })
})

describe("the tool evidence store", () => {
  test("keeps an output whole past the episode slice limit, under one ref per session", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const content = "z".repeat(100_000)
    const first = repository.putToolEvidence({ sessionID: "ses_1", tool: "bash", content })
    const again = repository.putToolEvidence({ sessionID: "ses_2", tool: "bash", content })
    expect(first?.bytes).toBe(100_000)
    // The same bytes are one evidence row, linked to each session on its own.
    expect(again?.ref).toBe(first?.ref)
    expect(repository.db.query("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 1 })
    expect(repository.getToolEvidence("ses_1", first!.ref)?.content).toBe(content)
    expect(repository.getToolEvidence("ses_2", first!.ref)?.content).toBe(content)
    expect(repository.getToolEvidence("ses_3", first!.ref)).toBeUndefined()
    repository.close()
  })

  test("refuses an output past the item cap instead of storing it cut", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const content = "a".repeat(TOOL_TRIM_MAX_STORED_BYTES + 1)
    expect(repository.putToolEvidence({ sessionID: "ses_1", tool: "bash", content })).toBeUndefined()
    expect(repository.db.query("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 0 })
    repository.close()
  })

  test("eviction past the global total drops the link with the row, and the ref reads as gone", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const old = repository.putToolEvidence({ sessionID: "ses_1", tool: "bash", content: "o".repeat(10_000) }, 1)
    const fresh = repository.putToolEvidence({ sessionID: "ses_1", tool: "bash", content: "f".repeat(10_000) }, 2)
    expect(repository.evictEvidence({ maxBytes: 15_000 })).toBe(1)
    expect(repository.getToolEvidence("ses_1", old!.ref)).toBeUndefined()
    expect(repository.getToolEvidence("ses_1", fresh!.ref)?.content).toBe("f".repeat(10_000))
    expect(repository.db.query("SELECT COUNT(*) AS n FROM tool_evidence").get()).toEqual({ n: 1 })
    repository.close()
  })

  test("a row edited by hand is not handed back as the output its ref names", () => {
    const repository = new SqliteRoutineRepository(":memory:")
    const stored = repository.putToolEvidence({ sessionID: "ses_1", tool: "bash", content: "real output" })
    repository.db.query("UPDATE evidence SET content = 'tampered' WHERE hash = ?1").run(stored!.hash)
    expect(repository.getToolEvidence("ses_1", stored!.ref)).toBeUndefined()
    repository.close()
  })
})
