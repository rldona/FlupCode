import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { skillReport } from "../skills"
import { createProposalReview } from "./learning/review"
import { createSkillCurator } from "./skills/curator"
import { contentHashOf, createLearnedStore, learnedRoots } from "./skills/learned-store"

let root = ""
let project = ""
let learning = true
const saved: Record<string, string | undefined> = {}
const repositories: SqliteRoutineRepository[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-learned-actions-"))
  project = join(root, "project")
  learning = true
  const home = join(root, "home")
  for (const directory of [home, join(root, "config"), join(root, "xdg"), project])
    mkdirSync(directory, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", "HOME"])
    saved[key] = process.env[key]
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  process.env.XDG_CONFIG_HOME = join(root, "xdg")
  process.env.OPENCODE_TEST_HOME = home
  process.env.HOME = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const repository of repositories.splice(0)) repository.close()
  rmSync(root, { recursive: true, force: true })
})

const body = "## Steps\n" + "Locate the failing assertion and fix the minimal cause. ".repeat(4)
const key = randomBytes(32)

/** The real server pieces: the repository, the store and curator on a temp project, the bearer. */
const open = (token: string | null = "secret") => {
  const repository = new SqliteRoutineRepository(":memory:")
  repositories.push(repository)
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  const store = createLearnedStore({ env: {}, key: () => key, enabled: () => learning })
  const curator = createSkillCurator({ store, enabled: () => learning })
  const handler = createHarnessHandler(repository, scheduler, {
    ...(token ? { token } : {}),
    proposals: repository,
    learnedSkills: curator,
    learnedSkillActions: curator,
    proposalReview: createProposalReview({ repository, curator }),
  })
  const stage = (name: string) =>
    repository.createProposal(
      {
        id: `proposal:${name}`,
        episodeID: `episode:${name}`,
        projectID: project,
        intent: "add",
        name,
        description: `Use when ${name} applies`,
        body,
        bodyHash: contentHashOf(body),
        evidenceRefs: [`episode:${name}`],
        status: "proposed",
      },
      1_000,
    )
  const call = (path: string, init: { method?: string; body?: unknown; bearer?: string | null } = {}) =>
    handler(
      new Request(`http://x/harness/adaptive/${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.bearer === null ? {} : { authorization: `Bearer ${init.bearer ?? "secret"}` }),
          "content-type": "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const act = (name: string, action: string, over: Record<string, unknown> = {}) =>
    call(`learned-skills/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      body: { projectID: project, confirm: true, ...over },
    })
  const list = async () =>
    (
      (await (await call(`learned-skills?projectID=${encodeURIComponent(project)}`)).json()) as {
        data: Array<{ name: string; disabled: boolean; path: string; state?: string }>
      }
    ).data
  return { handler, stage, call, act, list }
}

const loaded = (name: string) => skillReport(project, project).some((file) => file.loaded && file.name === name)

describe("the learned-skill actions (AH-E04)", () => {
  test("the whole cycle: approve installs, disable unloads, enable reloads, archive retires", async () => {
    const app = open()
    app.stage("parser-fix")

    const approved = await app.call(`proposals/${encodeURIComponent("proposal:parser-fix")}/approve`, {
      method: "POST",
      body: { confirm: true },
    })
    expect(approved.status).toBe(200)
    expect(loaded("parser-fix")).toBe(true)
    const roots = learnedRoots(project, {})
    expect(await app.list()).toEqual([
      expect.objectContaining({
        name: "parser-fix",
        disabled: false,
        state: "probation",
        path: join(roots.learned, "parser-fix", "SKILL.md"),
      }),
    ])

    // The detail carries the text, so a browser that cannot open the file can still read it.
    const detail = await app.call(`learned-skills/parser-fix?projectID=${encodeURIComponent(project)}`)
    expect((await detail.json()).data.body).toContain("Locate the failing assertion")

    const disabled = await app.act("parser-fix", "disable")
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({ data: { name: "parser-fix", status: "disabled" }, changed: true })
    expect(loaded("parser-fix")).toBe(false)
    expect(await app.list()).toEqual([
      expect.objectContaining({
        name: "parser-fix",
        disabled: true,
        path: join(roots.disabled, "parser-fix", "SKILL.md"),
      }),
    ])
    const disabledDetail = await app.call(`learned-skills/parser-fix?projectID=${encodeURIComponent(project)}`)
    expect((await disabledDetail.json()).data).toMatchObject({
      disabled: true,
      body: expect.stringContaining("Locate"),
    })

    // A second disable is a no-op, not an error.
    expect(await (await app.act("parser-fix", "disable")).json()).toMatchObject({ changed: false })

    expect(await (await app.act("parser-fix", "enable")).json()).toMatchObject({ changed: true })
    expect(loaded("parser-fix")).toBe(true)
    expect(await (await app.act("parser-fix", "enable")).json()).toMatchObject({ changed: false })

    expect(await (await app.act("parser-fix", "disable")).json()).toMatchObject({ changed: true })
    const archived = await app.act("parser-fix", "archive")
    expect(await archived.json()).toEqual({ data: { name: "parser-fix", status: "archived" }, changed: true })
    expect(loaded("parser-fix")).toBe(false)
    expect(existsSync(join(roots.archive, "parser-fix", "SKILL.md"))).toBe(true)
    expect(await app.list()).toEqual([])
    // Archived is gone from both lists, so another action on it is a 404.
    expect((await app.act("parser-fix", "enable")).status).toBe(404)
  })

  test("a rejected proposal installs nothing", async () => {
    const app = open()
    app.stage("never-mind")
    const rejected = await app.call(`proposals/${encodeURIComponent("proposal:never-mind")}/reject`, {
      method: "POST",
      body: {},
    })
    expect((await rejected.json()).data).toMatchObject({ status: "rejected", reason: "human-rejected" })
    expect(loaded("never-mind")).toBe(false)
    expect(await app.list()).toEqual([])
  })

  test("each action needs the bearer and an explicit confirmation", async () => {
    const app = open()
    app.stage("parser-fix")
    await app.call(`proposals/${encodeURIComponent("proposal:parser-fix")}/approve`, {
      method: "POST",
      body: { confirm: true },
    })

    const unconfirmed = await app.act("parser-fix", "disable", { confirm: false })
    expect(unconfirmed.status).toBe(422)
    expect((await unconfirmed.json()).code).toBe("confirmation-required")

    const forbidden = await app.call("learned-skills/parser-fix/disable", {
      method: "POST",
      body: { projectID: project, confirm: true },
      bearer: "wrong",
    })
    expect(forbidden.status).toBe(403)
    expect(loaded("parser-fix")).toBe(true)

    expect((await app.act("parser-fix", "delete")).status).toBe(404)
    expect((await app.act("ghost", "disable")).status).toBe(404)
    expect((await app.act("parser-fix", "disable", { projectID: "relative/path" })).status).toBe(404)
  })

  test("without a configured bearer the actions are a 404 and are not announced", async () => {
    const app = open(null)
    const response = await app.call("learned-skills/parser-fix/disable", {
      method: "POST",
      body: { projectID: project, confirm: true },
      bearer: null,
    })
    expect(response.status).toBe(404)
    const health = await (await app.call("../health", { bearer: null })).json()
    expect(health.capabilities).toContain("adaptive-skills")
    expect(health.capabilities).not.toContain("adaptive-skills-manage")

    const announced = await (await open().call("../health")).json()
    expect(announced.capabilities).toContain("adaptive-skills-manage")
  })

  test("disabling works with learning off, and enabling refuses a name a human took since", async () => {
    const app = open()
    app.stage("parser-fix")
    await app.call(`proposals/${encodeURIComponent("proposal:parser-fix")}/approve`, {
      method: "POST",
      body: { confirm: true },
    })
    learning = false
    expect(await (await app.act("parser-fix", "disable")).json()).toMatchObject({ changed: true })

    const human = join(project, ".opencode", "skills", "parser-fix")
    mkdirSync(human, { recursive: true })
    writeFileSync(join(human, "SKILL.md"), "---\nname: parser-fix\ndescription: Mine\n---\n\nMine.\n")
    const conflict = await app.act("parser-fix", "enable")
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).code).toBe("name-collision")
  })
})
