import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import type { SkillRosterEntry } from "./skills/curator"
import type { LearnedSkillReader } from "./learning-routes"

let project = ""

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "flupcode-learned-routes-"))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

const learnedEntry = (over: Partial<SkillRosterEntry> = {}): SkillRosterEntry => ({
  name: "fix-failing-test",
  description: "Use when a test fails",
  learned: true,
  state: "probation",
  usage: { load: 1, view: 0, patch: 0, opportunities: 3 },
  ...over,
})

const roster = (): SkillRosterEntry[] => [
  { name: "human-skill", description: "A human skill", learned: false },
  learnedEntry(),
]

/** A reader over a fixed roster: nothing disabled, and a file path under the project. */
const reader = (): LearnedSkillReader => ({
  roster,
  disabledRoster: () => [],
  skillPath: (projectID, name) => join(projectID, name, "SKILL.md"),
  show: () => undefined,
})

const open = (options: { token?: string; learnedSkills?: LearnedSkillReader } = {}) => {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  return { repository, handler: createHarnessHandler(repository, scheduler, options) }
}

describe("the learned-skill audit routes (FH-034)", () => {
  test("lists and reads learned skills under the bearer, and refuses without it", async () => {
    const { repository, handler } = open({ token: "secret", learnedSkills: reader() })
    const query = `projectID=${encodeURIComponent(project)}`

    const forbidden = await handler(new Request(`http://x/harness/adaptive/learned-skills?${query}`))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).code).toBe("invalid_token")

    const list = await handler(
      new Request(`http://x/harness/adaptive/learned-skills?${query}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      name: "fix-failing-test",
      learned: true,
      state: "probation",
      disabled: false,
      path: join(project, "fix-failing-test", "SKILL.md"),
    })

    const detail = await handler(
      new Request(`http://x/harness/adaptive/learned-skills/fix-failing-test?${query}`, {
        headers: { authorization: "Bearer secret" },
      }),
    )
    expect(detail.status).toBe(200)
    expect((await detail.json()).data.usage.load).toBe(1)
    repository.close()
  })

  test("an arbitrary projectID does not enumerate the learned roster", async () => {
    const { repository, handler } = open({ learnedSkills: reader() })
    for (const bad of ["relative/path", "/does/not/exist/anywhere", ""]) {
      const response = await handler(
        new Request(`http://x/harness/adaptive/learned-skills?projectID=${encodeURIComponent(bad)}`),
      )
      expect((await response.json()).data).toEqual([])
    }
    const detail = await handler(
      new Request(`http://x/harness/adaptive/learned-skills/fix-failing-test?projectID=${encodeURIComponent("relative")}`),
    )
    expect(detail.status).toBe(404)
    repository.close()
  })

  test("without a project the list is empty, and an unknown name is a 404", async () => {
    const { repository, handler } = open({ learnedSkills: reader() })

    expect((await (await handler(new Request("http://x/harness/adaptive/learned-skills"))).json()).data).toEqual([])

    const missing = await handler(
      new Request(`http://x/harness/adaptive/learned-skills/ghost?projectID=${encodeURIComponent(project)}`),
    )
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("not_found")
    repository.close()
  })

  test("is an ordinary 404 without a learned-skill reader", async () => {
    const { repository, handler } = open()
    expect((await handler(new Request("http://x/harness/adaptive/learned-skills"))).status).toBe(404)
    repository.close()
  })

  test("health announces adaptive-skills only when it was built", async () => {
    const without = open()
    expect((await (await without.handler(new Request("http://x/harness/health"))).json()).capabilities).not.toContain(
      "adaptive-skills",
    )
    without.repository.close()

    const withReader = open({ learnedSkills: reader() })
    expect((await (await withReader.handler(new Request("http://x/harness/health"))).json()).capabilities).toContain(
      "adaptive-skills",
    )
    withReader.repository.close()
  })
})
