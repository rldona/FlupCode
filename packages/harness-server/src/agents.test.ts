import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentError,
  agentRoots,
  deleteAgentFile,
  listAgentFiles,
  parseAgentFile,
  pathFor,
  serialiseAgentFile,
  writeAgentFile,
} from "./agents"

let root = ""
let config = ""
let project = ""
const saved: Record<string, string | undefined> = {}

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-agents-"))
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

describe("where agents are read from", () => {
  test("the config folder, then every .opencode up to the project root", () => {
    const roots = agentRoots(join(project, "packages", "app"), project)
    expect(roots.map((entry) => entry.scope)).toEqual(["global", "project", "project", "project"])
    expect(roots[0]!.path).toBe(config)
    // Nearest last, the way the engine reads them.
    expect(roots.at(-1)!.path).toBe(join(project, "packages", "app", ".opencode"))
  })

  test("with no folder open there is only the global one", () => {
    expect(agentRoots()).toEqual([{ path: config, scope: "global" }])
  })
})

describe("listing them", () => {
  test("finds every folder name the engine looks in, and names them by their path", () => {
    write(join(config, "agent", "reviewer.md"), "---\nmode: subagent\n---\n\nReview it.\n")
    write(join(project, ".opencode", "agents", "team", "scout.md"), "---\nmode: subagent\n---\n\nLook.\n")
    write(join(project, ".opencode", "mode", "build.md"), "---\nmodel: a/b\n---\n\nBuild.\n")

    const files = listAgentFiles(project, project)

    expect(files.map((file) => `${file.scope}:${file.name}`)).toEqual([
      "global:reviewer",
      "project:team/scout",
      "project:build",
    ])
    expect(files[0]!.prompt).toBe("Review it.")
    expect(files[1]!.fields).toEqual({ mode: "subagent" })
  })

  test("a file with no frontmatter is all prompt", () => {
    write(join(config, "agent", "plain.md"), "Just do what I said.\n")
    const [file] = listAgentFiles()
    expect(file).toMatchObject({ fields: {}, prompt: "Just do what I said." })
    expect(file!.problem).toBeUndefined()
  })

  test("a frontmatter that cannot be read is reported, not silently emptied", () => {
    // The form can then refuse to overwrite it. Reading it as "no settings" and saving would
    // delete everything the file said.
    write(join(config, "agent", "broken.md"), "---\nmode: [unclosed\n---\n\nBody.\n")
    const [file] = listAgentFiles()
    expect(file!.problem).toMatch(/could not be read/)
    expect(file!.prompt).toBe("Body.")
  })

  test("nothing anywhere is an empty list", () => {
    expect(listAgentFiles(project, project)).toEqual([])
  })
})

describe("writing one", () => {
  test("writes frontmatter a person can still read, and the prompt as the body", () => {
    const path = writeAgentFile(
      {
        name: "reviewer",
        scope: "project",
        fields: { description: "Reviews a diff", mode: "subagent", model: "anthropic/claude", temperature: 0.2 },
        prompt: "Review the diff and say what is wrong.",
      },
      project,
      project,
    )

    expect(readFileSync(path, "utf8")).toBe(
      [
        "---",
        "description: Reviews a diff",
        "mode: subagent",
        "model: anthropic/claude",
        "temperature: 0.2",
        "---",
        "",
        "Review the diff and say what is wrong.",
        "",
      ].join("\n"),
    )
    // And the engine's own folder: `.opencode/agent`, not somewhere of our choosing.
    expect(path).toBe(join(project, ".opencode", "agent", "reviewer.md"))
  })

  test("what it writes is what it reads back", () => {
    const fields = {
      description: "Runs things: carefully",
      mode: "subagent",
      hidden: true,
      steps: 12,
      color: "#44BA81",
      tools: { "*": false, read: true },
      permission: { edit: "deny", bash: "ask" },
    }
    const text = serialiseAgentFile({ fields, prompt: "Body." })

    const back = parseAgentFile(text)

    expect(back.fields).toEqual(fields)
    expect(back.prompt).toBe("Body.")
    expect(back.problem).toBeUndefined()
  })

  test("a value with a colon in it survives", () => {
    // Unquoted, `description: Runs things: carefully` ends the value at the first colon and the
    // rest becomes a key. This is the same family of bug that broke the workflow templates.
    const text = serialiseAgentFile({ fields: { description: "Runs things: carefully" }, prompt: "" })
    expect(parseAgentFile(text).fields.description).toBe("Runs things: carefully")
  })

  test("a colour and a version-like variant stay strings", () => {
    // Both break unquoted, and both were checked: `color: #44BA81` reads as null because `#` opens
    // a comment, and `variant: 2.0` reads as the number 2, which then fails the engine's decoder
    // because the field is a string.
    const text = serialiseAgentFile({ fields: { color: "#44BA81", variant: "2.0" }, prompt: "" })
    expect(parseAgentFile(text).fields).toEqual({ color: "#44BA81", variant: "2.0" })
  })

  test("keys nobody here understands are kept", () => {
    // A file is somebody's. An editor that drops what it does not recognise eats work.
    write(join(config, "agent", "odd.md"), "---\nmode: subagent\nsomething_new: 42\n---\n\nBody.\n")
    const [file] = listAgentFiles()

    const text = serialiseAgentFile({ fields: { ...file!.fields, mode: "primary" }, prompt: file!.prompt })

    expect(parseAgentFile(text).fields).toEqual({ mode: "primary", something_new: 42 })
  })

  test("an empty map is left out rather than written as an empty key", () => {
    expect(serialiseAgentFile({ fields: { mode: "subagent", tools: {} }, prompt: "x" })).not.toContain("tools")
  })
})

describe("what it refuses", () => {
  test("a name that would climb out of the folder", () => {
    // The name arrives from a browser.
    for (const name of ["../escape", "a/b", "/etc/passwd", "", ".hidden", "with space"]) {
      expect(() => pathFor({ name, scope: "project" }, project, project)).toThrow(AgentError)
    }
  })

  test("a project agent with no project open", () => {
    expect(() => pathFor({ name: "reviewer", scope: "project" })).toThrow(/open a project/)
  })

  test("deleting a file this listing never named", () => {
    write(join(root, "secret.txt"), "not yours")
    expect(() => deleteAgentFile(join(root, "secret.txt"), project, project)).toThrow(AgentError)
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("not yours")
  })

  test("and deletes one it did", () => {
    write(join(project, ".opencode", "agent", "gone.md"), "---\nmode: subagent\n---\n\nBye.\n")
    const [file] = listAgentFiles(project, project)
    deleteAgentFile(file!.path, project, project)
    expect(listAgentFiles(project, project)).toEqual([])
  })
})
