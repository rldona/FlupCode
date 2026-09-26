import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACTION_IMAGE_MAX_BYTES, ActionInputError, resolveActionInputs } from "./action-inputs"
import { collectCredentialNames, redactSecrets, unavailableActionCredentialResolver } from "./action-credentials"
import type { ActionCredentialResolver } from "./action-credentials"
import { runActionGuards } from "./action-guards"
import { MAX_STEP_TIMEOUT_MS, substituteActionTemplate, validateActionProfile } from "./actions"
import type { ActionInputKind, ActionProfile } from "./actions"
import { ActionRunError, createActionRunner, toActionErrorBody } from "./action-runner"
import { createHarnessHandler } from "./api"
import { createBrowserRuntime } from "./browser"
import type { BrowserRuntime, BrowserStartInput } from "./browser"
import { BrowserError } from "./browser"
import { createEgressGuard } from "./browser-egress"
import { loadActionProfiles } from "./config-files"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

const baseProfile = (overrides: Record<string, unknown> = {}) => ({
  tool: "do_publish",
  kind: "browser",
  origin: "https://example.com",
  steps: [{ goto: "{{origin}}/compose" }],
  ...overrides,
})

describe("validating an action profile", () => {
  test("a full profile validates and its origin is normalized", () => {
    const result = validateActionProfile("publish", {
      tool: "do_publish",
      description: "Publish the piece.",
      kind: "browser",
      origin: "HTTPS://Example.COM:443",
      credential: "site_account",
      inputs: { text: "string", image: "image" },
      steps: [
        { goto: "{{origin}}/compose", timeoutMs: 5000 },
        { waitFor: "[data-editor]", state: "visible" },
        { fill: { selector: "[data-editor]", text: "{{text}}" } },
        { upload: { selector: "input[type=file]", from: "{{image}}" } },
        { screenshot: "before-submit" },
        { submit: { selector: "[data-publish]" } },
        { assert: { selector: "[data-posted]" } },
      ],
      extract: { status: { selector: "[data-status]", as: "text" } },
      guards: ["lib/guards.ts"],
      sensitive: true,
      availability: "desktop",
      evidence: { screenshots: "failure", text: true },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile).toMatchObject({
      id: "publish",
      tool: "do_publish",
      kind: "browser",
      origin: "https://example.com",
      credential: "site_account",
      availability: "desktop",
      sensitive: true,
      evidence: { screenshots: "failure", text: true },
      guards: ["lib/guards.ts"],
    })
    expect(result.profile.steps).toHaveLength(7)
  })

  test("an unsupported kind is refused at load", () => {
    expect(validateActionProfile("x", baseProfile({ kind: "api" }))).toMatchObject({
      ok: false,
      code: "unsupported_kind",
    })
    expect(validateActionProfile("x", baseProfile({ kind: "mcp" }))).toMatchObject({ ok: false, code: "unsupported_kind" })
    expect(validateActionProfile("x", baseProfile({ kind: "unknown" }))).toMatchObject({
      ok: false,
      code: "unsupported_kind",
    })
  })

  test("an origin with a path, userinfo or another scheme is refused", () => {
    for (const origin of [
      "https://example.com/path",
      "https://user:pass@example.com",
      "ftp://example.com",
      "not a url",
      "https://example.com?q=1",
    ])
      expect(validateActionProfile("x", baseProfile({ origin }))).toMatchObject({ ok: false, code: "invalid_origin" })
  })

  test("a bad tool name is refused", () => {
    expect(validateActionProfile("x", baseProfile({ tool: "bad name" }))).toMatchObject({ ok: false, code: "invalid_tool" })
    expect(validateActionProfile("x", baseProfile({ tool: "" }))).toMatchObject({ ok: false, code: "invalid_tool" })
  })

  test("a tool that shadows an engine builtin is refused", () => {
    for (const tool of ["bash", "read", "edit", "write", "glob", "grep", "task", "webfetch", "websearch", "question", "skill", "todowrite"])
      expect(validateActionProfile("x", baseProfile({ tool }))).toMatchObject({ ok: false, code: "reserved_tool" })
  })

  test("an id that could widen the approval resource is refused", () => {
    for (const id of ["a*b", "a?b", "a/b", "a b", "", "x".repeat(65)])
      expect(validateActionProfile(id, baseProfile())).toMatchObject({ ok: false, code: "invalid_id" })
    expect(validateActionProfile("do_publish-1", baseProfile()).ok).toBe(true)
  })

  test("an explicit sensitive:false cannot downgrade an action with effects", () => {
    expect(validateActionProfile("x", baseProfile({ sensitive: false, steps: [{ submit: { selector: "#send" } }] }))).toMatchObject({
      ok: false,
      code: "invalid_sensitive",
    })
    expect(validateActionProfile("x", baseProfile({ sensitive: false, credential: "site_account" }))).toMatchObject({
      ok: false,
      code: "invalid_sensitive",
    })
    // A pure read stays valid when it declares itself not sensitive.
    const readOnly = validateActionProfile("x", baseProfile({ sensitive: false }))
    expect(readOnly.ok && readOnly.profile.sensitive).toBe(false)
  })

  test("a malformed step is refused", () => {
    const bad = (steps: unknown[]) => validateActionProfile("x", baseProfile({ steps }))
    expect(bad([{ goto: "{{origin}}", click: "button" }])).toMatchObject({ ok: false, code: "invalid_step" })
    expect(bad([{ goto: "{{origin}}", nope: 1 }])).toMatchObject({ ok: false, code: "invalid_step" })
    expect(bad([{ screenshot: "x", timeoutMs: 100 }])).toMatchObject({ ok: false, code: "invalid_step" })
    expect(bad(["nope"])).toMatchObject({ ok: false, code: "invalid_step" })
    expect(bad([])).toMatchObject({ ok: false, code: "invalid_step" })
  })

  test("a timeout past the maximum is refused", () => {
    expect(validateActionProfile("x", baseProfile({ steps: [{ goto: "{{origin}}", timeoutMs: MAX_STEP_TIMEOUT_MS + 1 }] })))
      .toMatchObject({ ok: false, code: "invalid_step" })
  })

  test("fill with both or neither of text and credential is refused", () => {
    const bad = (fill: unknown) => validateActionProfile("x", baseProfile({ steps: [{ fill }] }))
    expect(bad({ selector: "#a", text: "a", credential: "b" })).toMatchObject({ ok: false, code: "invalid_step" })
    expect(bad({ selector: "#a" })).toMatchObject({ ok: false, code: "invalid_step" })
  })

  test("fill referencing an undeclared credential is refused", () => {
    expect(
      validateActionProfile("x", baseProfile({ steps: [{ fill: { selector: "#pass", credential: "{{credential}}" } }] })),
    ).toMatchObject({ ok: false, code: "invalid_step" })
  })

  test("upload from something that is not an image input is refused", () => {
    const profile = baseProfile({ inputs: { text: "string" }, steps: [{ upload: { selector: "input", from: "{{text}}" } }] })
    expect(validateActionProfile("x", profile)).toMatchObject({ ok: false, code: "invalid_upload" })
    const malformed = baseProfile({ inputs: { image: "image" }, steps: [{ upload: { selector: "input", from: "image" } }] })
    expect(validateActionProfile("x", malformed)).toMatchObject({ ok: false, code: "invalid_upload" })
  })

  test("extract as attribute requires an attribute", () => {
    const profile = baseProfile({ extract: { price: { selector: "[data-price]", as: "attribute" } } })
    expect(validateActionProfile("x", profile)).toMatchObject({ ok: false, code: "invalid_extract" })
  })

  test("defaults fill in the envelope", () => {
    const result = validateActionProfile("status", {
      tool: "read_status",
      kind: "browser",
      origin: "https://example.com",
      steps: [{ goto: "{{origin}}" }],
      extract: { status: { selector: "[data-status]" } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile.sensitive).toBe(false)
    expect(result.profile.evidence).toEqual({ screenshots: "each" })
    expect(result.profile.availability).toBe("host")
    expect(result.profile.inputs).toEqual({})
    expect(result.profile.guards).toEqual([])
    expect(result.profile.description.length).toBeGreaterThan(0)

    const sideEffecting = validateActionProfile("publish", {
      tool: "do_publish",
      kind: "browser",
      origin: "https://example.com",
      steps: [{ click: "button" }],
    })
    expect(sideEffecting.ok && sideEffecting.profile.sensitive).toBe(true)
  })

  test("a step marked sensitive makes an extract action sensitive", () => {
    const result = validateActionProfile("status", {
      tool: "read_status",
      kind: "browser",
      origin: "https://example.com",
      steps: [{ goto: "{{origin}}", sensitive: true }],
      extract: { status: { selector: "[data-status]" } },
    })
    expect(result.ok && result.profile.sensitive).toBe(true)
  })

  test("an action that acts is sensitive even when it also extracts", () => {
    const read = { status: { selector: "[data-status]" } }
    const sensitive = (raw: Record<string, unknown>) => {
      const result = validateActionProfile("x", baseProfile(raw))
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
      return result.profile.sensitive
    }
    expect(sensitive({ steps: [{ goto: "{{origin}}/" }, { submit: { selector: "#send" } }], extract: read })).toBe(true)
    expect(sensitive({ steps: [{ goto: "{{origin}}/" }], extract: read })).toBe(false)
    expect(sensitive({ steps: [{ fill: { selector: "#pass", credential: "site_account" } }] })).toBe(true)
    expect(
      sensitive({
        inputs: { image: "image" },
        steps: [{ goto: "{{origin}}/" }, { upload: { selector: "#file", from: "{{image}}" } }],
        extract: read,
      }),
    ).toBe(true)
  })

  test("an input name that could traverse or shadow the origin is refused", () => {
    for (const name of ["../escape", "/abs", "a/b", "has.dot", "", "origin"])
      expect(validateActionProfile("x", baseProfile({ inputs: { [name]: "string" } }))).toMatchObject({
        ok: false,
        code: "invalid_inputs",
      })
  })
})

describe("substituting an action template", () => {
  test("origin and declared inputs resolve", () => {
    expect(
      substituteActionTemplate("{{origin}}/compose?text={{text}}", { origin: "https://example.com", inputs: { text: "hi" } }),
    ).toEqual({ ok: true, value: "https://example.com/compose?text=hi" })
  })

  test("an absent input is unknown", () => {
    expect(substituteActionTemplate("{{text}}", { origin: "https://example.com", inputs: {} })).toMatchObject({
      ok: false,
      code: "unknown_input",
    })
    expect(substituteActionTemplate("{{text}}", { origin: "https://example.com", inputs: { text: "" } })).toMatchObject({
      ok: false,
      code: "unknown_input",
    })
  })

  test("an undeclared key is unknown", () => {
    expect(substituteActionTemplate("{{nope}}", { origin: "https://example.com", inputs: { text: "hi" } })).toMatchObject(
      { ok: false, code: "unknown_input" },
    )
  })

  test("a leftover placeholder is refused", () => {
    expect(substituteActionTemplate("{{}}", { origin: "https://example.com", inputs: {} })).toMatchObject({
      ok: false,
      code: "invalid_template",
    })
  })

  test("a prototype property is not an input", () => {
    for (const key of ["constructor", "toString", "__proto__"])
      expect(substituteActionTemplate(`{{${key}}}`, { origin: "https://example.com", inputs: {} })).toMatchObject({
        ok: false,
        code: "unknown_input",
      })
  })
})

let root = ""
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flupcode-actions-"))
  for (const key of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("loading action profiles", () => {
  test("reads flupcode.actions raw and names the config directory", () => {
    const config = join(root, "config")
    mkdirSync(config, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = config
    process.env.XDG_CONFIG_HOME = join(root, "xdg")
    writeFileSync(
      join(config, "opencode.json"),
      JSON.stringify({ flupcode: { actions: { publish: { tool: "do_publish", kind: "api" } } } }),
    )

    const source = loadActionProfiles()
    expect(source.configDir).toBe(config)
    expect(source.profiles.publish).toMatchObject({ tool: "do_publish", kind: "api" })
  })

  test("no block is an empty map", () => {
    process.env.OPENCODE_CONFIG_DIR = join(root, "empty")
    expect(loadActionProfiles().profiles).toEqual({})
  })
})

const validProfile = (raw: Record<string, unknown>): ActionProfile => {
  const result = validateActionProfile("publish", { ...baseProfile(), ...raw })
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.profile
}

describe("credentials", () => {
  test("collects the profile credential and every fill credential", () => {
    const profile = validProfile({
      credential: "site_account",
      inputs: { text: "string" },
      steps: [
        { fill: { selector: "#user", credential: "{{credential}}" } },
        { fill: { selector: "#pass", credential: "other_account" } },
        { fill: { selector: "#note", text: "{{text}}" } },
      ],
    })
    expect(collectCredentialNames(profile).sort()).toEqual(["other_account", "site_account"])
  })

  test("the unavailable resolver fails closed", async () => {
    expect(await unavailableActionCredentialResolver.resolve({ name: "a", origin: "https://example.com" })).toBeUndefined()
  })

  test("redacts every non-empty secret", () => {
    expect(redactSecrets("user site_account pass", ["site_account"])).toBe("user [redacted] pass")
    expect(redactSecrets("nothing", [""])).toBe("nothing")
  })
})

describe("resolving action inputs", () => {
  const repositories: SqliteRoutineRepository[] = []

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close()
  })

  const profile = (inputs: Record<string, ActionInputKind>) => validProfile({ inputs })
  const repository = () => {
    const repo = new SqliteRoutineRepository(":memory:")
    repositories.push(repo)
    return repo
  }
  const failure = async (work: Promise<unknown>): Promise<ActionInputError> => {
    try {
      await work
    } catch (cause) {
      if (cause instanceof ActionInputError) return cause
      throw cause
    }
    throw new Error("expected the call to fail")
  }
  const pngDataUrl = () => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`

  test("string inputs pass through", async () => {
    const resolved = await resolveActionInputs({
      profile: profile({ text: "string" }),
      provided: { text: "hello" },
      repository: repository(),
    })
    expect(resolved.values).toEqual({ text: "hello" })
    expect(resolved.images).toEqual({})
    resolved.cleanup()
  })

  test("a declared input without a value is missing", async () => {
    const error = await failure(
      resolveActionInputs({
        profile: profile({ text: "string" }),
        provided: {},
        repository: repository(),
      }),
    )
    expect(error).toBeInstanceOf(ActionInputError)
    expect(error.code).toBe("missing_input")
  })

  test("a value the profile did not declare is unknown", async () => {
    const error = await failure(
      resolveActionInputs({
        profile: profile({}),
        provided: { extra: "x" },
        repository: repository(),
      }),
    )
    expect(error.code).toBe("unknown_input")
  })

  test("a string input of the wrong type is refused", async () => {
    const error = await failure(
      resolveActionInputs({
        profile: profile({ text: "string" }),
        provided: { text: 5 },
        repository: repository(),
      }),
    )
    expect(error.code).toBe("invalid_input")
  })

  test("a data URL becomes a 0600 temp file with the right extension", async () => {
    const resolved = await resolveActionInputs({
      profile: profile({ image: "image" }),
      provided: { image: { dataUrl: pngDataUrl() } },
      repository: repository(),
    })
    const file = resolved.images.image!
    expect(existsSync(file)).toBe(true)
    expect(file.endsWith(".png")).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(resolved.values.image).toBe("<image>")
    resolved.cleanup()
    expect(existsSync(file)).toBe(false)
  })

  test("a bare data URL string is accepted", async () => {
    const resolved = await resolveActionInputs({
      profile: profile({ image: "image" }),
      provided: { image: pngDataUrl() },
      repository: repository(),
    })
    expect(statSync(resolved.images.image!).size).toBe(4)
    resolved.cleanup()
  })

  test("an artifact id is copied to a 0600 temp file", async () => {
    const repo = repository()
    const source = join(root, "shot.png")
    writeFileSync(source, Buffer.from([1, 2, 3, 4, 5]))
    const artifact = repo.addArtifact({
      kind: "screenshot",
      title: "shot",
      producer: "harness",
      mime: "image/png",
      path: "shot.png",
      directory: root,
    })

    const resolved = await resolveActionInputs({
      profile: profile({ image: "image" }),
      provided: { image: { artifactId: artifact.id } },
      repository: repo,
    })
    const file = resolved.images.image!
    expect(file).not.toBe(source)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).size).toBe(5)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    resolved.cleanup()
  })

  test("an image file is materialized inside the temp dir even for a traversing name", async () => {
    const evil: ActionProfile = { ...validProfile({ inputs: {} }), inputs: { "../escape": "image" } }
    const resolved = await resolveActionInputs({
      profile: evil,
      provided: { "../escape": { dataUrl: pngDataUrl() } },
      repository: repository(),
    })
    const file = resolved.images["../escape"]!
    expect(existsSync(file)).toBe(true)
    expect(file.startsWith(tmpdir())).toBe(true)
    expect(file.endsWith("input-0.png")).toBe(true)
    resolved.cleanup()
  })

  test("an artifact whose real path escapes its directory is refused", async () => {
    const repo = repository()
    const outside = mkdtempSync(join(tmpdir(), "flupcode-outside-"))
    writeFileSync(join(outside, "secret.png"), Buffer.from([1, 2, 3]))
    symlinkSync(join(outside, "secret.png"), join(root, "link.png"))
    const artifact = repo.addArtifact({
      kind: "screenshot",
      title: "link",
      producer: "harness",
      mime: "image/png",
      path: "link.png",
      directory: root,
    })

    const error = await failure(
      resolveActionInputs({
        profile: profile({ image: "image" }),
        provided: { image: { artifactId: artifact.id } },
        repository: repo,
      }),
    )
    rmSync(outside, { recursive: true, force: true })
    expect(error.code).toBe("invalid_input")
  })

  test("an image input without a value is missing", async () => {
    const error = await failure(
      resolveActionInputs({
        profile: profile({ image: "image" }),
        provided: {},
        repository: repository(),
      }),
    )
    expect(error.code).toBe("missing_input")
  })

  test("an image over the size limit is refused", async () => {
    const huge = `data:image/png;base64,${Buffer.alloc(ACTION_IMAGE_MAX_BYTES + 1).toString("base64")}`
    const error = await failure(
      resolveActionInputs({
        profile: profile({ image: "image" }),
        provided: { image: { dataUrl: huge } },
        repository: repository(),
      }),
    )
    expect(error.code).toBe("invalid_input")
  })
})

describe("running action guards", () => {
  const write = (name: string, body: string) => writeFileSync(join(root, name), body)
  const input = { action: "publish", tool: "do_publish", origin: "https://example.com", inputs: {} }

  test("a module that allows lets the action through", async () => {
    write("allow.mjs", "export const guards = [{ id: 'ok', assess: () => ({ allow: true }) }]\n")
    expect(await runActionGuards({ guards: ["allow.mjs"], configDir: root, input })).toEqual({ allow: true })
  })

  test("a guard that denies returns its code and reason", async () => {
    write(
      "deny.mjs",
      "export const guards = [{ id: 'no', assess: () => ({ allow: false, code: 'NOPE', reason: 'because' }) }]\n",
    )
    expect(await runActionGuards({ guards: ["deny.mjs"], configDir: root, input })).toEqual({
      allow: false,
      code: "NOPE",
      message: "because",
    })
  })

  test("a guard that throws refuses", async () => {
    write("throw.mjs", "export const guards = [{ id: 'boom', assess: () => { throw new Error('exploded') } }]\n")
    expect(await runActionGuards({ guards: ["throw.mjs"], configDir: root, input })).toEqual({
      allow: false,
      code: "GUARD_ERROR",
      message: "exploded",
    })
  })

  test("a module that is not there refuses", async () => {
    expect(await runActionGuards({ guards: ["missing.mjs"], configDir: root, input })).toEqual({
      allow: false,
      code: "GUARD_LOAD_ERROR",
      message: "missing.mjs",
    })
  })

  test("a module without a guards array refuses", async () => {
    write("empty.mjs", "export const other = 1\n")
    expect(await runActionGuards({ guards: ["empty.mjs"], configDir: root, input })).toEqual({
      allow: false,
      code: "GUARD_LOAD_ERROR",
      message: "empty.mjs",
    })
  })

  test("a guard entry without assess refuses the module", async () => {
    write("typo.mjs", "export const guards = [{ id: 'x', check: () => {} }]\n")
    expect(await runActionGuards({ guards: ["typo.mjs"], configDir: root, input })).toEqual({
      allow: false,
      code: "GUARD_LOAD_ERROR",
      message: "typo.mjs",
    })
  })

  test("the first denial stops the run", async () => {
    write("first.mjs", "export const guards = [{ id: 'a', assess: () => ({ allow: false, code: 'A', reason: 'first' }) }]\n")
    write("second.mjs", "export const guards = [{ id: 'b', assess: () => ({ allow: false, code: 'B', reason: 'second' }) }]\n")
    expect(await runActionGuards({ guards: ["first.mjs", "second.mjs"], configDir: root, input })).toMatchObject({
      code: "A",
    })
  })

  test("no guards allows", async () => {
    expect(await runActionGuards({ guards: [], configDir: root, input })).toEqual({ allow: true })
  })
})

// Deferred, and only here: `@playwright/test` is the harness's own browser runner and must not
// enter the server at all. This import exists to ask where the binary is, nothing more.
const { chromium } = await import("playwright")
const chromiumPath = chromium.executablePath()

if (process.env.FLUPCODE_REQUIRE_BROWSER === "1" && !existsSync(chromiumPath))
  throw new Error(`FLUPCODE_REQUIRE_BROWSER=1 but Playwright has no Chromium at ${chromiumPath}`)

const ACTION_TOKEN = "action-token"

describe("running action recipes", () => {
  const made: string[] = []
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  const runtimes: BrowserRuntime[] = []
  const repositories: SqliteRoutineRepository[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
    for (const repository of repositories.splice(0)) repository.close()
    for (const server of servers.splice(0)) void server.stop(true)
    for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
  }, 20_000)

  /** A local page with a field, a file input, a button and a second page, so a whole recipe runs. */
  const fixture = () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        const html =
          path === "/second"
            ? '<!doctype html><html><head><title>Second</title></head><body><p id="out">second page</p></body></html>'
            : `<!doctype html><html><head><title>Fixture</title></head><body>
                 <h1 id="head">hello</h1>
                 <button id="go" type="button">go</button>
                 <input id="title" />
                 <input id="user" />
                 <input id="pw" type="password" />
                 <input id="file" type="file" />
                 <p id="status">ready</p>
                 <p id="mirror"></p>
                 <span id="hidden-code" data-code="xyz" hidden>hidden</span>
                 <a id="next" href="/second">next</a>
                 <script>
                   document.getElementById("go").addEventListener("click", () => { document.getElementById("head").textContent = "clicked" })
                   document.getElementById("user").addEventListener("input", (event) => { document.getElementById("mirror").textContent = event.target.value })
                 </script>
               </body></html>`
        return new Response(html, { headers: { "content-type": "text/html" } })
      },
    })
    servers.push(server)
    return server
  }

  const open = (server?: ReturnType<typeof Bun.serve>) => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-action-run-"))
    made.push(directory)
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    const runtime = createBrowserRuntime({
      repository,
      dataDir: directory,
      egress: createEgressGuard(server ? { allowLoopbackPorts: [server.port ?? 0] } : undefined),
    })
    runtimes.push(runtime)
    return { directory, repository, runtime }
  }

  const runnerFor = (
    runtime: BrowserRuntime,
    repository: SqliteRoutineRepository,
    profiles: Record<string, unknown>,
    credentials: ActionCredentialResolver = unavailableActionCredentialResolver,
  ) =>
    createActionRunner({
      browser: runtime,
      repository,
      credentials,
      loadProfiles: () => ({ configDir: root, profiles }),
    })

  const failureOf = async (work: Promise<unknown>): Promise<ActionRunError> => {
    try {
      await work
    } catch (cause) {
      if (cause instanceof ActionRunError) return cause
      throw cause
    }
    throw new Error("expected the action to fail")
  }

  /** A browser that records how it was asked to start, and when it was closed (WA-7). */
  const recordingBrowser = (options: { stopped?: boolean } = {}) => {
    const starts: BrowserStartInput[] = []
    const closed: string[] = []
    const calls: string[] = []
    const session = {
      id: "s1",
      project: "proj",
      headed: false,
      createdAt: 0,
      lastUsedAt: 0,
      idleTimeoutMs: 0,
      url: "https://example.com/",
      title: "",
      paused: false,
      stopped: false,
    }
    const view = { url: session.url, title: session.title }
    const browser: BrowserRuntime = {
      start: async (input) => {
        starts.push(input)
        return session
      },
      openLogin: async () => session,
      protect: () => {},
      clearData: async () => true,
      get: () => session,
      close: async (id) => {
        closed.push(id)
        return true
      },
      pause: () => session,
      resume: () => session,
      takeOver: async () => session,
      abort: async () => true,
      waitIfPaused: async () => {
        if (options.stopped) throw new BrowserError("stopped", 409, "stopped")
      },
      navigate: async () => (calls.push("navigate"), view),
      snapshot: async () => ({ ...view, text: "" }),
      click: async () => (calls.push("click"), view),
      type: async () => (calls.push("type"), view),
      submit: async () => (calls.push("submit"), view),
      waitFor: async () => (calls.push("waitFor"), view),
      upload: async () => (calls.push("upload"), view),
      text: async () => ({ value: null, ...view }),
      screenshot: async () => (calls.push("screenshot"), { artifactId: "artifact" }),
      frame: async () => (calls.push("frame"), { bytes: new Uint8Array() }),
      stop: async () => {},
    }
    return { browser, starts, closed, calls }
  }

  const profile = (origin: string, overrides: Record<string, unknown> = {}) => ({
    tool: "do_publish",
    kind: "browser",
    origin,
    steps: [{ goto: "{{origin}}/" }],
    evidence: { screenshots: "none" },
    ...overrides,
  })

  test("list validates profiles and rejects an unsupported kind and a duplicate tool", () => {
    const { runtime, repository } = open()
    const runner = runnerFor(runtime, repository, {
      publish: { tool: "do_publish", kind: "api" },
      one: { tool: "read_status", kind: "browser", origin: "https://example.com", steps: [{ goto: "{{origin}}/" }] },
      two: { tool: "read_status", kind: "browser", origin: "https://example.com", steps: [{ goto: "{{origin}}/" }] },
    })

    const { profiles, rejected } = runner.list()
    expect(profiles.map((entry) => entry.id)).toEqual(["one"])
    expect(rejected).toMatchObject([
      { id: "publish", code: "unsupported_kind" },
      { id: "two", code: "duplicate_tool" },
    ])
  })

  test("a dry run plans the steps without opening a browser", async () => {
    const { runtime, repository } = open()
    const runner = runnerFor(runtime, repository, { publish: profile("https://example.com") })

    const result = await runner.run({ action: "publish", sessionID: "s1", project: "proj", dryRun: true })
    expect(result).toMatchObject({ action: "publish", tool: "do_publish", status: "dry-run", origin: "https://example.com" })
    expect(result.steps).toMatchObject([{ index: 0, kind: "goto", status: "planned", attempts: 0 }])
    expect(runtime.get("s1")).toBeUndefined()
  })

  test("an unknown action and a raw profile without a dry run are refused", async () => {
    const { runtime, repository } = open()
    const runner = runnerFor(runtime, repository, {})

    expect(await failureOf(runner.run({ action: "nope", sessionID: "s1", project: "proj" }))).toMatchObject({
      code: "unknown_action",
      status: 404,
    })
    expect(
      await failureOf(runner.run({ profile: { kind: "api" }, sessionID: "s1", project: "proj" })),
    ).toMatchObject({ code: "invalid_request", status: 400 })
  })

  test("a guard that denies stops the action before any browser opens", async () => {
    const { runtime, repository } = open()
    writeFileSync(
      join(root, "deny.mjs"),
      "export const guards = [{ assess: () => ({ allow: false, code: 'NOPE', reason: 'not today' }) }]\n",
    )
    const runner = runnerFor(runtime, repository, {
      publish: profile("https://example.com", { guards: ["deny.mjs"] }),
    })

    const error = await failureOf(runner.run({ action: "publish", sessionID: "s1", project: "proj" }))
    expect(error).toMatchObject({ code: "guard_denied", guardCode: "NOPE", status: 422 })
    expect(runtime.get("s1")).toBeUndefined()
  })

  test("a credential bound to another origin is unavailable before any browser opens", async () => {
    const { runtime, repository } = open()
    const credentials: ActionCredentialResolver = {
      async resolve({ origin }) {
        return origin === "https://example.com" ? "s3cret" : undefined
      },
    }
    const runner = runnerFor(
      runtime,
      repository,
      {
        signin: profile("http://127.0.0.1:9", {
          credential: "site_account",
          steps: [{ goto: "{{origin}}/" }, { fill: { selector: "#user", credential: "{{credential}}" } }],
        }),
      },
      credentials,
    )

    const error = await failureOf(runner.run({ action: "signin", sessionID: "s1", project: "proj" }))
    expect(error).toMatchObject({ code: "credential_unavailable", status: 422 })
    expect(runtime.get("s1")).toBeUndefined()
  })

  test("an image over the size limit is refused before any browser opens", async () => {
    const { runtime, repository } = open()
    const runner = runnerFor(runtime, repository, {
      upload: profile("https://example.com", {
        tool: "do_upload",
        inputs: { image: "image" },
        steps: [{ goto: "{{origin}}/" }, { upload: { selector: "#file", from: "{{image}}" } }],
      }),
    })

    const huge = `data:image/png;base64,${Buffer.alloc(ACTION_IMAGE_MAX_BYTES + 1).toString("base64")}`
    const error = await failureOf(
      runner.run({ action: "upload", inputs: { image: { dataUrl: huge } }, sessionID: "s1", project: "proj" }),
    )
    expect(error).toMatchObject({ code: "invalid_input", status: 422 })
    expect(runtime.get("s1")).toBeUndefined()
  })

  test("a stopped browser fails the run as stopped, not as a failed step", async () => {
    const { repository } = open()
    const session = {
      id: "s1",
      project: "proj",
      headed: false,
      createdAt: 0,
      lastUsedAt: 0,
      idleTimeoutMs: 0,
      url: "https://example.com/",
      title: "",
      paused: true,
      stopped: true,
    }
    const view = { url: session.url, title: session.title }
    const browser: BrowserRuntime = {
      start: async () => session,
      openLogin: async () => session,
      protect: () => {},
      clearData: async () => true,
      get: () => session,
      close: async () => true,
      pause: () => session,
      resume: () => session,
      takeOver: async () => session,
      abort: async () => true,
      waitIfPaused: async () => {
        throw new BrowserError("stopped", 409, "stopped")
      },
      navigate: async () => view,
      snapshot: async () => ({ ...view, text: "" }),
      click: async () => view,
      type: async () => view,
      submit: async () => view,
      waitFor: async () => view,
      upload: async () => view,
      text: async () => ({ value: null, ...view }),
      screenshot: async () => ({ artifactId: "artifact" }),
      frame: async () => ({ bytes: new Uint8Array() }),
      stop: async () => {},
    }
    const runner = runnerFor(browser, repository, { publish: profile("https://example.com") })

    const error = await failureOf(runner.run({ action: "publish", sessionID: "s1", project: "proj" }))
    expect(error).toMatchObject({ code: "stopped", status: 409 })
  })

  test("a stop is not retried into a missing session", async () => {
    const { repository } = open()
    const session = {
      id: "s1",
      project: "proj",
      headed: false,
      createdAt: 0,
      lastUsedAt: 0,
      idleTimeoutMs: 0,
      url: "https://example.com/",
      title: "",
      paused: true,
      stopped: true,
    }
    const view = { url: session.url, title: session.title }
    let pauses = 0
    const browser: BrowserRuntime = {
      start: async () => session,
      openLogin: async () => session,
      protect: () => {},
      clearData: async () => true,
      get: () => session,
      close: async () => true,
      pause: () => session,
      resume: () => session,
      takeOver: async () => session,
      abort: async () => true,
      waitIfPaused: async () => {
        pauses += 1
        // The abort already closed the session: a retry would only meet `no_session` and bury the
        // `stopped` code under a `step_failed`.
        if (pauses > 1) throw new BrowserError("no_session", 404, "No browser session is open")
        throw new BrowserError("stopped", 409, "stopped")
      },
      navigate: async () => view,
      snapshot: async () => ({ ...view, text: "" }),
      click: async () => view,
      type: async () => view,
      submit: async () => view,
      waitFor: async () => view,
      upload: async () => view,
      text: async () => ({ value: null, ...view }),
      screenshot: async () => ({ artifactId: "artifact" }),
      frame: async () => ({ bytes: new Uint8Array() }),
      stop: async () => {},
    }
    const runner = runnerFor(browser, repository, { publish: profile("https://example.com") })

    const error = await failureOf(runner.run({ action: "publish", sessionID: "s1", project: "proj" }))
    expect(error).toMatchObject({ code: "stopped", status: 409 })
    expect(pauses).toBe(1)
  })

  test("a scheduled run is headless, scoped to its run and task, and closed on finish (WA-7)", async () => {
    const { repository } = open()
    const { browser, starts, closed } = recordingBrowser()
    const runner = runnerFor(browser, repository, { publish: profile("https://example.com") })

    await runner.run({
      action: "publish",
      sessionID: "task_1",
      project: "proj",
      runID: "run_1",
      taskID: "task_1",
      closeOnFinish: true,
    })

    // Headless unless a person asked for a window, and the evidence knows where it belongs.
    expect(starts[0]).toMatchObject({ id: "task_1", project: "proj", runID: "run_1", taskID: "task_1" })
    expect(starts[0]!.headed).toBeUndefined()
    expect(closed).toEqual(["task_1"])
  })

  test("a stopped run refuses before the next step instead of driving on (WA-7)", async () => {
    const { repository } = open()
    const { browser } = recordingBrowser()
    const runner = runnerFor(browser, repository, { publish: profile("https://example.com") })

    const error = await failureOf(
      runner.run({ action: "publish", sessionID: "task_1", project: "proj", stopped: () => true }),
    )
    expect(error).toMatchObject({ code: "stopped", status: 409 })
  })

  test.skipIf(!existsSync(chromiumPath))(
    "runs a recipe end to end and keeps a recoverable screenshot",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        publish: profile(origin, {
          inputs: { text: "string" },
          steps: [
            { goto: "{{origin}}/" },
            { waitFor: "#head" },
            { fill: { selector: "#title", text: "{{text}}" } },
            { click: "#go" },
            { assert: { selector: "#head", text: "clicked" } },
            { screenshot: "done" },
          ],
        }),
      })

      const result = await runner.run({
        action: "publish",
        inputs: { text: "hello" },
        sessionID: "s1",
        project: "proj",
      })
      if (result.status !== "success") throw new Error("expected success")
      expect(result.steps.map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"])
      expect(result.evidence).toHaveLength(1)
      const artifactId = result.evidence[0]!
      expect(repository.getArtifact(artifactId)?.title).toBe("done")

      const handler = createHarnessHandler(repository, new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }))
      const raw = await handler(new Request(`http://x/harness/artifacts/${artifactId}/raw`))
      expect(raw.status).toBe(200)
      expect(raw.headers.get("content-type")).toBe("image/png")
      const bytes = Buffer.from(await raw.arrayBuffer())
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a read action returns the extracted values",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        status: profile(origin, {
          tool: "read_status",
          steps: [{ goto: "{{origin}}/" }, { waitFor: "#status" }],
          extract: { status: { selector: "#status", as: "text" }, heading: { selector: "#head", as: "text" } },
        }),
      })

      const result = await runner.run({ action: "status", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      expect(result.extract).toEqual({ status: "ready", heading: "hello" })
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a failing step stops the run with structured evidence",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        publish: profile(origin, {
          steps: [{ goto: "{{origin}}/" }, { waitFor: "#missing", timeoutMs: 300 }],
          evidence: { screenshots: "each" },
        }),
      })

      const error = await failureOf(runner.run({ action: "publish", sessionID: "s1", project: "proj" }))
      expect(error).toMatchObject({ code: "step_failed", step: "waitFor", index: 1, status: 422 })
      expect(error.evidence.length).toBeGreaterThan(0)
      const titles = error.evidence.map((id) => repository.getArtifact(id)?.title)
      expect(titles).toContain("publish:1:waitFor")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a credential is typed but never returned",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const credentials: ActionCredentialResolver = {
        async resolve() {
          return "s3cret-pass"
        },
      }
      const runner = runnerFor(
        runtime,
        repository,
        {
          publish: profile(origin, {
            credential: "site_account",
            steps: [
              { goto: "{{origin}}/" },
              { fill: { selector: "#user", credential: "{{credential}}" } },
              { screenshot: "after-fill" },
            ],
          }),
          signin: profile(origin, {
            credential: "site_account",
            steps: [
              { goto: "{{origin}}/" },
              { fill: { selector: "#user", credential: "{{credential}}" } },
              { waitFor: "#missing", timeoutMs: 300 },
            ],
          }),
        },
        credentials,
      )

      const result = await runner.run({ action: "publish", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      expect(JSON.stringify(result)).not.toContain("s3cret-pass")
      expect(result.evidence.map((id) => repository.getArtifact(id)?.title)).toEqual(["after-fill"])
      expect((await runtime.snapshot("s1")).text).not.toContain("s3cret-pass")

      const error = await failureOf(runner.run({ action: "signin", sessionID: "s1", project: "proj" }))
      expect(error.message).not.toContain("s3cret-pass")
      expect(JSON.stringify(toActionErrorBody(error))).not.toContain("s3cret-pass")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a credential is stripped from the result, the text artifact and the extract",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const credentials: ActionCredentialResolver = {
        async resolve() {
          return "S3CRET"
        },
      }
      const runner = runnerFor(
        runtime,
        repository,
        {
          publish: profile(origin, {
            credential: "site_account",
            steps: [{ goto: "{{origin}}/" }, { fill: { selector: "#user", credential: "{{credential}}" } }],
            extract: { mirror: { selector: "#mirror", as: "text" } },
            evidence: { screenshots: "none", text: true },
          }),
        },
        credentials,
      )

      const result = await runner.run({ action: "publish", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      expect(JSON.stringify(result)).not.toContain("S3CRET")
      expect(result.extract).toEqual({ mirror: "[redacted]" })
      const id = result.evidence.find((candidate) => repository.getArtifact(candidate)?.kind === "log")
      expect(id).toBeDefined()
      expect(repository.getArtifact(id!)?.content).not.toContain("S3CRET")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "an image input uploads from a data URL and its temp file is removed",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        upload: profile(origin, {
          tool: "do_upload",
          inputs: { image: "image" },
          steps: [{ goto: "{{origin}}/" }, { upload: { selector: "#file", from: "{{image}}" } }],
        }),
      })

      const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("flupcode-action-")))
      const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`
      const result = await runner.run({
        action: "upload",
        inputs: { image: { dataUrl: png } },
        sessionID: "s1",
        project: "proj",
      })
      expect(result.status).toBe("success")
      const fresh = readdirSync(tmpdir()).filter(
        (name) => name.startsWith("flupcode-action-") && !before.has(name),
      )
      expect(fresh).toEqual([])
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a goto outside the origin and an unknown placeholder are refused",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        elsewhere: profile("https://example.com", { steps: [{ goto: `http://127.0.0.1:${server.port}/` }] }),
        unknown: profile(origin, { steps: [{ goto: "{{origin}}/{{nope}}" }] }),
      })

      const mismatch = await failureOf(runner.run({ action: "elsewhere", sessionID: "s1", project: "proj" }))
      expect(mismatch).toMatchObject({ code: "origin_mismatch", status: 403 })
      const unknown = await failureOf(runner.run({ action: "unknown", sessionID: "s2", project: "proj2" }))
      expect(unknown).toMatchObject({ code: "unknown_input", status: 422 })
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "extracts an attribute from a hidden node",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        read: profile(origin, {
          tool: "read_code",
          steps: [{ goto: "{{origin}}/" }],
          extract: { code: { selector: "#hidden-code", as: "attribute", attribute: "data-code" } },
        }),
      })

      const result = await runner.run({ action: "read", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      expect(result.extract).toEqual({ code: "xyz" })
      expect(runtime.get("s1")).toBeDefined()
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a screenshot step stores one artifact, not one plus the automatic capture",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        shot: profile(origin, {
          tool: "take_shot",
          steps: [{ goto: "{{origin}}/" }, { screenshot: "only" }],
          evidence: { screenshots: "each" },
        }),
      })

      const result = await runner.run({ action: "shot", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      const titles = result.evidence.map((id) => repository.getArtifact(id)?.title)
      expect(titles).toEqual(["shot:0:goto", "only"])
      expect(result.steps[1]!.screenshot).toBe(result.evidence[1])
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "evidence.text keeps a redacted page text artifact",
    async () => {
      const server = fixture()
      const origin = `http://127.0.0.1:${server.port}`
      const { runtime, repository } = open(server)
      const runner = runnerFor(runtime, repository, {
        status: profile(origin, {
          tool: "read_status",
          steps: [{ goto: "{{origin}}/" }],
          evidence: { screenshots: "none", text: true },
        }),
      })

      const result = await runner.run({ action: "status", sessionID: "s1", project: "proj" })
      if (result.status !== "success") throw new Error("expected success")
      const id = result.evidence.find((candidate) => repository.getArtifact(candidate)?.kind === "log")
      expect(id).toBeDefined()
      const artifact = repository.getArtifact(id!)
      expect(artifact).toMatchObject({ title: "status:text", producer: "harness" })
      expect(artifact?.content).toContain("hello")
    },
    30_000,
  )

  test.skipIf(!existsSync(chromiumPath))(
    "a submit that lands off-origin is refused with origin_mismatch",
    async () => {
      const away = Bun.serve({
        port: 0,
        fetch: () =>
          new Response('<!doctype html><html><head><title>Away</title></head><body>away</body></html>', {
            headers: { "content-type": "text/html" },
          }),
      })
      servers.push(away)
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(
            `<!doctype html><html><head><title>Leave</title></head><body><form method="get" action="http://127.0.0.1:${away.port}/"><button id="send" type="submit">send</button></form></body></html>`,
            { headers: { "content-type": "text/html" } },
          ),
      })
      servers.push(server)
      const origin = `http://127.0.0.1:${server.port}`
      const directory = mkdtempSync(join(tmpdir(), "flupcode-action-run-"))
      made.push(directory)
      const repository = new SqliteRoutineRepository(":memory:")
      repositories.push(repository)
      const runtime = createBrowserRuntime({
        repository,
        dataDir: directory,
        egress: createEgressGuard({ allowLoopbackPorts: [server.port ?? 0, away.port ?? 0] }),
      })
      runtimes.push(runtime)
      const runner = runnerFor(runtime, repository, {
        leave: profile(origin, { steps: [{ goto: "{{origin}}/" }, { submit: { selector: "#send" } }] }),
      })

      const error = await failureOf(runner.run({ action: "leave", sessionID: "s1", project: "proj" }))
      expect(error).toMatchObject({ code: "origin_mismatch", status: 403 })
    },
    30_000,
  )
})

describe("the action HTTP routes", () => {
  const repositories: SqliteRoutineRepository[] = []

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close()
  })

  const handlerWith = (profiles: Record<string, unknown>) => {
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    const runtime = createBrowserRuntime({ repository })
    const actions = createActionRunner({
      browser: runtime,
      repository,
      credentials: unavailableActionCredentialResolver,
      loadProfiles: () => ({ configDir: root, profiles }),
    })
    const handler = createHarnessHandler(
      repository,
      new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }),
      { actions, token: ACTION_TOKEN },
    )
    return { actions, handler }
  }

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: `Bearer ${ACTION_TOKEN}`, "content-type": "application/json" },
  })

  test("the action routes need the bearer token", async () => {
    const { handler } = handlerWith({})
    const missing = await handler(new Request("http://x/harness/actions"))
    expect(missing.status).toBe(403)
    expect((await missing.json()).code).toBe("invalid_token")
  })

  test("health announces web-actions when the runner exists", async () => {
    const { handler } = handlerWith({})
    const body = await (await handler(new Request("http://x/harness/health"))).json()
    expect(body.capabilities).toContain("web-actions")
  })

  test("listing actions returns profiles and rejected entries", async () => {
    const { handler } = handlerWith({
      good: { tool: "read_status", kind: "browser", origin: "https://example.com", steps: [{ goto: "{{origin}}/" }] },
      bad: { tool: "do_api", kind: "api" },
    })

    const response = await handler(new Request("http://x/harness/actions", authed()))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.profiles.map((entry: { id: string }) => entry.id)).toEqual(["good"])
    expect(body.data.rejected).toMatchObject([{ id: "bad", code: "unsupported_kind" }])
  })

  test("a dry run over HTTP plans without a browser", async () => {
    const { handler } = handlerWith({
      good: { tool: "read_status", kind: "browser", origin: "https://example.com", steps: [{ goto: "{{origin}}/" }] },
    })

    const response = await handler(
      new Request(
        "http://x/harness/actions/run",
        authed({
          method: "POST",
          body: JSON.stringify({ action: "good", sessionID: "s1", project: "proj", dryRun: true }),
        }),
      ),
    )
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ action: "good", status: "dry-run" })
  })

  test("a run without a session is refused", async () => {
    const { handler } = handlerWith({})
    const response = await handler(
      new Request(
        "http://x/harness/actions/run",
        authed({ method: "POST", body: JSON.stringify({ action: "good", project: "proj" }) }),
      ),
    )
    expect(response.status).toBe(400)
  })
})
