import { describe, expect, test } from "bun:test"
import { createHarnessHandler } from "../api"
import type { HarnessHandlerOptions } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { StoredSkillProposalInput } from "./learning/proposal-record"

const open = (options: HarnessHandlerOptions = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

/** The same handler, with its own repository wired as the proposal reader. */
const openWithProposals = (token?: string) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, { ...(token ? { token } : {}), proposals: repository }) }
}

const proposal = (over: Partial<StoredSkillProposalInput> = {}): StoredSkillProposalInput => ({
  id: "proposal:episode:run:1",
  episodeID: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  decisionID: "skillReflection:episode:run:1",
  intent: "add",
  name: "fix-failing-test",
  description: "Use when a test fails",
  body: "## Steps\n" + "Do the minimal thing. ".repeat(10),
  bodyHash: "a".repeat(64),
  evidenceRefs: ["episode:run:1"],
  status: "proposed",
  ...over,
})

describe("the proposal audit routes (FH-034)", () => {
  test("lists and reads a proposal under the bearer, and refuses without it", async () => {
    const { repository, handler } = openWithProposals("secret")
    repository.createProposal(proposal(), 1_000)

    const forbidden = await handler(new Request("http://x/harness/adaptive/proposals"))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const list = await handler(
      new Request("http://x/harness/adaptive/proposals?episodeID=episode:run:1", {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: "proposal:episode:run:1", intent: "add", status: "proposed" })

    const detail = await handler(
      new Request("http://x/harness/adaptive/proposals/proposal:episode:run:1", {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(detail.status).toBe(200)
    expect((await detail.json()).data.name).toBe("fix-failing-test")

    // The client encodes the id (`:` becomes `%3A`); the route reads the same row.
    const encoded = await handler(
      new Request(`http://x/harness/adaptive/proposals/${encodeURIComponent("proposal:episode:run:1")}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(encoded.status).toBe(200)
    repository.close()
  })

  test("an unknown id is a 404, and the list is empty without a match", async () => {
    const { repository, handler } = openWithProposals()
    repository.createProposal(proposal(), 1_000)

    const missing = await handler(new Request("http://x/harness/adaptive/proposals/proposal:nope"))
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("not_found")

    const empty = await handler(new Request("http://x/harness/adaptive/proposals?projectID=/other"))
    expect((await empty.json()).data).toEqual([])
    repository.close()
  })

  test("is an ordinary 404 without a proposal reader", async () => {
    const { repository, handler } = open()
    expect((await handler(new Request("http://x/harness/adaptive/proposals"))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-proposals only when it was built", async () => {
    const plain = new SqliteRoutineRepository(":memory:")
    const plainHandler = createHarnessHandler(plain, new RoutineScheduler({ repository: plain, engineURL: "http://127.0.0.1:1" }))
    expect((await (await plainHandler(new Request("http://x/harness/health"))).json()).capabilities).not.toContain(
      "adaptive-proposals",
    )
    plain.close()

    const announcedRepository = new SqliteRoutineRepository(":memory:")
    const announcedHandler = createHarnessHandler(
      announcedRepository,
      new RoutineScheduler({ repository: announcedRepository, engineURL: "http://127.0.0.1:1" }),
      { proposals: announcedRepository },
    )
    expect((await (await announcedHandler(new Request("http://x/harness/health"))).json()).capabilities).toContain(
      "adaptive-proposals",
    )
    announcedRepository.close()
  })
})
