import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SkillError, deleteSkill, pathFor, readSkill, skillReport, skillRoots, writeSkill } from "./skills"

let root = ""
let config = ""
let project = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

const skill = (name?: string, description = "Does a thing") =>
  `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\n\nBody.\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-skills-"))
  config = join(root, "config")
  project = join(root, "project")
  mkdirSync(config, { recursive: true })
  mkdirSync(project, { recursive: true })
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.OPENCODE_CONFIG_DIR = config
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/**
 * Each case below is one the engine was actually asked about on 17/09/2026, in a clean project:
 * a `SKILL.md` with a name loads, one without a name does not, a `.md` that is not called SKILL.md
 * does not, and `.claude/skills` and `.agents/skills` do.
 */
describe("what the engine would load", () => {
  test("a SKILL.md with a name", () => {
    write(join(project, ".opencode", "skills", "named", "SKILL.md"), skill("named-skill"))
    const [file] = skillReport(project, project)
    expect(file).toMatchObject({ name: "named-skill", loaded: true, scope: "project" })
    expect(file!.reason).toBeUndefined()
  })

  test("and not one without a name, which is the failure that looks like nothing happening", () => {
    write(join(project, ".opencode", "skills", "unnamed", "SKILL.md"), skill(undefined))
    const [file] = skillReport(project, project)
    expect(file!.loaded).toBe(false)
    expect(file!.reason).toMatch(/`name`/)
  })

  test("and not a markdown file that is not called SKILL.md", () => {
    write(join(project, ".opencode", "skills", "toplevel.md"), skill("toplevel"))
    const [file] = skillReport(project, project)
    expect(file!.loaded).toBe(false)
    expect(file!.reason).toMatch(/SKILL\.md/)
  })

  test("a frontmatter that cannot be read is the reason, not a crash", () => {
    write(join(project, ".opencode", "skills", "broken", "SKILL.md"), "---\nname: [unclosed\n---\n\nBody.\n")
    const [file] = skillReport(project, project)
    expect(file!.loaded).toBe(false)
    expect(file!.reason).toMatch(/could not be read/)
  })

  test("the folders it borrows from other tools count too", () => {
    write(join(project, ".claude", "skills", "from-claude", "SKILL.md"), skill("from-claude"))
    write(join(project, ".agents", "skills", "from-agents", "SKILL.md"), skill("from-agents"))

    const loaded = skillReport(project, project).filter((file) => file.loaded)

    expect(loaded.map((file) => file.scope).sort()).toEqual(["agents", "claude"])
  })

  test("a second skill with the same name is shadowed, and says by which file", () => {
    // The engine keeps the first and warns in a log nobody is reading.
    write(join(config, "skills", "shared", "SKILL.md"), skill("shared"))
    write(join(project, ".opencode", "skills", "shared", "SKILL.md"), skill("shared"))

    const files = skillReport(project, project)
    const shadowed = files.find((file) => !file.loaded)

    expect(files.filter((file) => file.loaded)).toHaveLength(1)
    expect(shadowed!.reason).toMatch(/already has this name/)
    expect(shadowed!.shadows).toBe(join(config, "skills", "shared", "SKILL.md"))
  })

  test("nothing anywhere is an empty list", () => {
    expect(skillReport(project, project)).toEqual([])
  })
})

describe("where they are looked for", () => {
  test("the config folder, the borrowed folders, and every .opencode up to the root", () => {
    const roots = skillRoots(join(project, "packages", "app"), project)
    const paths = roots.map((entry) => entry.path)
    expect(paths).toContain(join(config, "skills"))
    expect(paths).toContain(join(project, ".opencode", "skills"))
    expect(paths).toContain(join(project, "packages", "app", ".claude", "skills"))
    // `skill` and `skills` are both scanned, which is a trap worth not falling into.
    expect(paths).toContain(join(project, ".opencode", "skill"))
  })
})

describe("writing one", () => {
  test("writes the folder, the SKILL.md and the name it would be dropped for missing", () => {
    const path = writeSkill(
      { name: "reviewing", scope: "project", description: "How to review here", body: "Read the diff first." },
      project,
      project,
    )

    expect(path).toBe(join(project, ".opencode", "skills", "reviewing", "SKILL.md"))
    expect(readFileSync(path, "utf8")).toBe(
      ["---", "name: reviewing", "description: How to review here", "---", "", "Read the diff first.", ""].join("\n"),
    )
    // And the engine's rules agree with what was written.
    expect(skillReport(project, project)[0]).toMatchObject({ name: "reviewing", loaded: true })
  })

  test("a description with a colon in it survives", () => {
    const path = writeSkill(
      { name: "reviewing", scope: "project", description: "Use when: reviewing", body: "x" },
      project,
      project,
    )
    expect(skillReport(project, project)[0]!.description).toBe("Use when: reviewing")
    expect(readFileSync(path, "utf8")).toContain('"Use when: reviewing"')
  })

  test("refuses a name that would climb out of the folder", () => {
    for (const name of ["../escape", "a/b", "", "/etc"]) {
      expect(() => pathFor({ name, scope: "project" }, project, project)).toThrow(SkillError)
    }
  })
})

describe("reading and deleting", () => {
  test("reads one this report named, and refuses one it did not", () => {
    write(join(project, ".opencode", "skills", "one", "SKILL.md"), skill("one"))
    write(join(root, "secret.txt"), "not yours")

    expect(readSkill(join(project, ".opencode", "skills", "one", "SKILL.md"), project, project)).toContain("Body.")
    expect(readSkill(join(root, "secret.txt"), project, project)).toBeUndefined()
  })

  test("deleting takes the empty folder with it", () => {
    write(join(project, ".opencode", "skills", "one", "SKILL.md"), skill("one"))

    deleteSkill(join(project, ".opencode", "skills", "one", "SKILL.md"), project, project)

    expect(skillReport(project, project)).toEqual([])
    // An empty folder left behind is what makes the next person wonder whether it worked.
    expect(existsSync(join(project, ".opencode", "skills", "one"))).toBe(false)
  })

  test("a folder with something else in it is left alone", () => {
    write(join(project, ".opencode", "skills", "one", "SKILL.md"), skill("one"))
    write(join(project, ".opencode", "skills", "one", "notes.txt"), "keep me")

    deleteSkill(join(project, ".opencode", "skills", "one", "SKILL.md"), project, project)

    expect(readFileSync(join(project, ".opencode", "skills", "one", "notes.txt"), "utf8")).toBe("keep me")
  })

  test("deleting a file this report never named", () => {
    write(join(root, "secret.txt"), "not yours")
    expect(() => deleteSkill(join(root, "secret.txt"), project, project)).toThrow(SkillError)
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("not yours")
  })
})
