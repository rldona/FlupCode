import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CommandError,
  commandRoots,
  deleteCommandFile,
  listCommandFiles,
  pathFor,
  writeCommandFile,
} from "./commands"
import { parseFrontmatter } from "./frontmatter"

let root = ""
let config = ""
let project = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-commands-"))
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

describe("where commands are read from", () => {
  test("the config folder, then every .opencode up to the project root", () => {
    const roots = commandRoots(join(project, "packages", "app"), project)
    expect(roots.map((entry) => entry.scope)).toEqual(["global", "project", "project", "project"])
    expect(roots[0]!.path).toBe(config)
    expect(roots.at(-1)!.path).toBe(join(project, "packages", "app", ".opencode"))
  })

  test("with no folder open there is only the global one", () => {
    expect(commandRoots()).toEqual([{ path: config, scope: "global" }])
  })
})

describe("listing them", () => {
  test("finds both folder names the engine looks in, and names them by their path", () => {
    write(join(config, "command", "commit.md"), "---\ndescription: Commit\n---\n\nCommit it.\n")
    write(join(project, ".opencode", "commands", "git", "release.md"), "---\ndescription: Release\n---\n\nShip it.\n")

    const files = listCommandFiles(project, project)

    // The engine keys a nested file by its path under the folder: that is the slash command.
    expect(files.map((file) => `${file.scope}:${file.name}`)).toEqual(["global:commit", "project:git/release"])
    expect(files[0]!.template).toBe("Commit it.")
    expect(files[1]!.fields).toEqual({ description: "Release" })
  })

  test("a file with no frontmatter is all template", () => {
    write(join(config, "command", "plain.md"), "Just do what I said.\n")
    const [file] = listCommandFiles()
    expect(file).toMatchObject({ fields: {}, template: "Just do what I said." })
    expect(file!.problem).toBeUndefined()
  })

  test("a frontmatter that cannot be read is reported, not silently emptied", () => {
    write(join(config, "command", "broken.md"), "---\ndescription: [unclosed\n---\n\nBody.\n")
    const [file] = listCommandFiles()
    expect(file!.problem).toMatch(/could not be read/)
    expect(file!.template).toBe("Body.")
  })

  test("nothing anywhere is an empty list", () => {
    expect(listCommandFiles(project, project)).toEqual([])
  })
})

describe("writing one", () => {
  test("writes frontmatter a person can still read, and the template as the body", () => {
    const path = writeCommandFile(
      {
        name: "git/release",
        scope: "project",
        fields: { description: "Cut a release", agent: "build", subtask: true },
        template: "Release $ARGUMENTS.",
      },
      project,
      project,
    )

    expect(readFileSync(path, "utf8")).toBe(
      ["---", "description: Cut a release", "agent: build", "subtask: true", "---", "", "Release $ARGUMENTS.", ""].join(
        "\n",
      ),
    )
    expect(path).toBe(join(project, ".opencode", "command", "git", "release.md"))
  })

  test("what it writes is what it reads back", () => {
    const fields = { description: "Runs things: carefully", model: "anthropic/claude", agent: "build", subtask: true }
    const path = writeCommandFile({ name: "review", scope: "project", fields, template: "Review $1." }, project, project)

    const [file] = listCommandFiles(project, project)
    expect(file!.path).toBe(path)
    expect(file!.fields).toEqual(fields)
    expect(file!.template).toBe("Review $1.")
  })

  test("keys nobody here understands are kept", () => {
    write(join(config, "command", "odd.md"), "---\ndescription: Odd\nsomething_new: 42\n---\n\nBody.\n")
    const [file] = listCommandFiles()

    const text = writeCommandFile(
      { name: "odd", scope: "global", fields: { ...file!.fields, agent: "plan" }, template: file!.template },
      undefined,
      project,
    )

    expect(parseFrontmatter(readFileSync(text, "utf8")).fields).toEqual({
      description: "Odd",
      something_new: 42,
      agent: "plan",
    })
  })

  test("a command with no frontmatter is written as a plain template, not an empty header", () => {
    const path = writeCommandFile({ name: "plain", scope: "global", fields: {}, template: "Say hi." }, undefined, project)
    expect(readFileSync(path, "utf8")).toBe("Say hi.\n")
  })
})

describe("what it refuses", () => {
  test("a name that would climb out of the folder", () => {
    for (const name of ["../escape", "/etc/passwd", "a/../../b", "\\.hidden", "with space"]) {
      expect(() => pathFor({ name, scope: "project" }, project, project)).toThrow(CommandError)
    }
  })

  test("an empty name", () => {
    expect(() => pathFor({ name: "", scope: "project" }, project, project)).toThrow(CommandError)
  })

  test("a project command with no project open", () => {
    expect(() => pathFor({ name: "review", scope: "project" })).toThrow(/open a project/)
  })

  test("deleting a file this listing never named", () => {
    write(join(root, "secret.txt"), "not yours")
    expect(() => deleteCommandFile(join(root, "secret.txt"), project, project)).toThrow(CommandError)
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("not yours")
  })

  test("and deletes one it did", () => {
    write(join(project, ".opencode", "command", "gone.md"), "---\ndescription: Gone\n---\n\nBye.\n")
    const [file] = listCommandFiles(project, project)
    deleteCommandFile(file!.path, project, project)
    expect(listCommandFiles(project, project)).toEqual([])
  })
})
