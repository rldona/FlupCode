import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHandler } from "./api"
import { createActionRunner, ActionRunError } from "./action-runner"
import type { BrowserRuntime } from "./browser"
import { createHarnessServer } from "./index"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { createVault, parseVaultKey, readOrCreateVaultKeyFile, readVaultKeyFile, vaultKeyFile } from "./vault"
import type { CredentialStore, CredentialVault } from "./vault"

/** Every test that opens a repository closes it, so a leak is never left behind. */
const closeAfter = () => {
  const repositories: SqliteRoutineRepository[] = []
  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close()
  })
  return () => {
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    return repository
  }
}

describe("the credential vault", () => {
  const store = closeAfter()
  const key = (byte = 1) => Buffer.alloc(32, byte)

  test("a secret goes in and comes back for its own name and origin", async () => {
    const vault = createVault({ store: store(), key: key() })
    const metadata = vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    expect(metadata).toEqual({ name: "site_account", origin: "https://example.com", updatedAt: expect.any(Number) })
    expect(await vault.resolve({ name: "site_account", origin: "https://example.com" })).toBe("s3cret")
  })

  test("another origin is a miss", async () => {
    const vault = createVault({ store: store(), key: key() })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    expect(await vault.resolve({ name: "site_account", origin: "https://other.example" })).toBeUndefined()
  })

  test("the wrong key cannot open it", async () => {
    const repository = store()
    createVault({ store: repository, key: key(1) }).set({
      name: "site_account",
      origin: "https://example.com",
      secret: "s3cret",
    })
    const other = createVault({ store: repository, key: key(2) })
    expect(await other.resolve({ name: "site_account", origin: "https://example.com" })).toBeUndefined()
  })

  test("a tampered row cannot be opened", async () => {
    const repository = store()
    const vault = createVault({ store: repository, key: key() })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    const record = repository.getActionCredential("site_account")!
    repository.upsertActionCredential({ ...record, ciphertext: Buffer.from("tampered").toString("base64") })
    expect(await vault.resolve({ name: "site_account", origin: "https://example.com" })).toBeUndefined()
  })

  test("the listing carries the metadata and nothing derived from the secret", () => {
    const vault = createVault({ store: store(), key: key() })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    const listed = vault.list()
    expect(listed).toEqual([{ name: "site_account", origin: "https://example.com", updatedAt: expect.any(Number) }])
    expect(Object.keys(listed[0]!)).toEqual(["name", "origin", "updatedAt"])
  })

  test("removing forgets it, and says whether it was there", async () => {
    const vault = createVault({ store: store(), key: key() })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    expect(vault.remove("site_account")).toBe(true)
    expect(vault.remove("site_account")).toBe(false)
    expect(await vault.resolve({ name: "site_account", origin: "https://example.com" })).toBeUndefined()
  })

  test("saving a name again replaces it rather than adding a second row", async () => {
    const vault = createVault({ store: store(), key: key() })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "first" })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "second" })
    expect(vault.list()).toHaveLength(1)
    expect(await vault.resolve({ name: "site_account", origin: "https://example.com" })).toBe("second")
  })

  test("a store that fails is a miss, not a rejection", async () => {
    const failing: CredentialStore = {
      upsertActionCredential: () => {},
      listActionCredentials: () => [],
      getActionCredential: () => {
        throw new Error("the database is gone")
      },
      removeActionCredential: () => false,
    }
    const vault = createVault({ store: failing, key: key() })
    expect(await vault.resolve({ name: "site_account", origin: "https://example.com" })).toBeUndefined()
  })
})

describe("the vault key", () => {
  let directory = ""

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "flupcode-vault-"))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  test("a 64-character hex key is 32 bytes", () => {
    expect(parseVaultKey(Buffer.alloc(32, 7).toString("hex"))).toEqual(Buffer.alloc(32, 7))
  })

  test("base64 of 32 bytes is accepted", () => {
    expect(parseVaultKey(Buffer.alloc(32, 9).toString("base64"))).toEqual(Buffer.alloc(32, 9))
  })

  test("garbage, the wrong length and nothing are refused", () => {
    expect(parseVaultKey("not a key!!")).toBeUndefined()
    expect(parseVaultKey("abc")).toBeUndefined()
    expect(parseVaultKey(Buffer.alloc(16, 1).toString("hex"))).toBeUndefined()
    expect(parseVaultKey(undefined)).toBeUndefined()
    expect(parseVaultKey("   ")).toBeUndefined()
  })

  test("a new key file is created owner-only and reused as it is", () => {
    const file = vaultKeyFile(directory)
    const key = readOrCreateVaultKeyFile(file)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
    expect(readVaultKeyFile(file)).toBe(key)
    expect(readOrCreateVaultKeyFile(file)).toBe(key)
  })

  test("an empty key file is regenerated, not handed back blank", () => {
    const file = vaultKeyFile(directory)
    const first = readOrCreateVaultKeyFile(file)
    writeFileSync(file, "   \n")
    const next = readOrCreateVaultKeyFile(file)
    expect(next).toMatch(/^[0-9a-f]{64}$/)
    expect(next).not.toBe(first)
    expect(readFileSync(file, "utf8")).toBe(next)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })

  test("a key file that does not parse is backed up and regenerated", () => {
    const file = vaultKeyFile(directory)
    writeFileSync(file, "not-a-key")
    const key = readOrCreateVaultKeyFile(file)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file, "utf8")).toBe(key)
    expect(parseVaultKey(key)).toBeDefined()
    // The bytes that were there are kept, not destroyed, so the loss is auditable.
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("not-a-key")
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })
})

describe("the vault key a server is given", () => {
  let directory = ""
  let previous = ""
  let hadPrevious = false
  let running: ReturnType<typeof createHarnessServer> | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "flupcode-vault-env-"))
    previous = process.env.FLUPCODE_CONFIG_DIR ?? ""
    hadPrevious = process.env.FLUPCODE_CONFIG_DIR !== undefined
    process.env.FLUPCODE_CONFIG_DIR = directory
  })
  afterEach(async () => {
    await running?.stop()
    running = undefined
    if (hadPrevious) process.env.FLUPCODE_CONFIG_DIR = previous
    else delete process.env.FLUPCODE_CONFIG_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  test("a 64-character hex key opens the vault and no key file is written", async () => {
    const hex = Buffer.alloc(32, 11).toString("hex")
    expect(parseVaultKey(hex)).toEqual(Buffer.alloc(32, 11))

    const app = createHarnessServer({ vaultKey: hex, databasePath: ":memory:", browserToken: "t", port: 0 })
    running = app

    expect(app.vault).toBeDefined()
    // The key came in, so nothing under the config directory was read or written.
    expect(readdirSync(directory)).toEqual([])
  })
})

describe("the credential HTTP routes", () => {
  const store = closeAfter()

  const handlerWith = () => {
    const repository = store()
    const vault = createVault({ store: repository, key: Buffer.alloc(32, 5) })
    const handler = createHarnessHandler(repository, new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }), {
      credentials: vault,
      token: "t",
    })
    return { handler, vault }
  }

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
  })

  const post = (handler: Awaited<ReturnType<typeof handlerWith>>["handler"], body: unknown) =>
    handler(
      new Request("http://x/harness/credentials", authed({ method: "POST", body: JSON.stringify(body) })),
    )

  test("the routes need the bearer token", async () => {
    const { handler } = handlerWith()
    const response = await handler(new Request("http://x/harness/credentials"))
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("invalid_token")
  })

  test("with the bearer, listing answers 200", async () => {
    const { handler } = handlerWith()
    const response = await handler(new Request("http://x/harness/credentials", authed()))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual([])
  })

  test("without a vault the route is an ordinary 404 and the rest still serves", async () => {
    const repository = store()
    const handler = createHarnessHandler(
      repository,
      new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" }),
      {
        token: "t",
      },
    )
    const missing = await handler(new Request("http://x/harness/credentials", authed()))
    expect(missing.status).toBe(404)
    const health = await handler(new Request("http://x/harness/health"))
    expect(health.status).toBe(200)
    expect((await health.json()).healthy).toBe(true)
  })

  test("health announces credentials when a vault exists", async () => {
    const { handler } = handlerWith()
    const body = await (await handler(new Request("http://x/harness/health"))).json()
    expect(body.capabilities).toContain("credentials")
  })

  test("a name, an origin or a secret that does not fit is refused", async () => {
    const { handler } = handlerWith()
    const failure = async (body: unknown) => {
      const response = await post(handler, body)
      return { status: response.status, code: (await response.json()).code }
    }
    expect(await failure({ name: "bad name", origin: "https://example.com", secret: "x" })).toEqual({
      status: 400,
      code: "invalid_name",
    })
    expect(await failure({ name: "site_account", origin: "ftp://example.com", secret: "x" })).toEqual({
      status: 400,
      code: "invalid_origin",
    })
    expect(await failure({ name: "site_account", origin: "https://example.com", secret: "" })).toEqual({
      status: 400,
      code: "invalid_secret",
    })
    expect(await failure({ name: "site_account", origin: "https://example.com", secret: "x".repeat(9000) })).toEqual({
      status: 400,
      code: "invalid_secret",
    })
  })

  test("storing a secret answers with the metadata and never the secret", async () => {
    const { handler } = handlerWith()
    const response = await post(handler, {
      name: "site_account",
      origin: "https://example.com",
      secret: "s3cret-value",
    })
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain("s3cret-value")
    expect(JSON.parse(text).data).toEqual({
      name: "site_account",
      origin: "https://example.com",
      updatedAt: expect.any(Number),
    })

    const listed = await (await handler(new Request("http://x/harness/credentials", authed()))).json()
    expect(JSON.stringify(listed)).not.toContain("s3cret-value")
    expect(listed.data).toEqual([
      { name: "site_account", origin: "https://example.com", updatedAt: expect.any(Number) },
    ])
  })

  test("removing reports whether the credential was there", async () => {
    const { handler, vault } = handlerWith()
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    const removed = await handler(
      new Request("http://x/harness/credentials/site_account", authed({ method: "DELETE" })),
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ data: { removed: true } })
    const missing = await handler(
      new Request("http://x/harness/credentials/site_account", authed({ method: "DELETE" })),
    )
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe("not_found")
  })
})

describe("the runner's credential prefetch", () => {
  const store = closeAfter()

  /**
   * A browser that fails only if something actually asks it to open: the credential prefetch happens
   * before `start`, so reaching `start` is the proof that the prefetch let the run through.
   */
  const unstarted = (): BrowserRuntime => ({
    start: async () => {
      throw new Error("browser.start was called")
    },
    openLogin: async () => {
      throw new Error("browser.openLogin was called")
    },
    protect: () => {
      throw new Error("browser.protect was called")
    },
    clearData: async () => {
      throw new Error("browser.clearData was called")
    },
    get: () => undefined,
    close: async () => {
      throw new Error("browser.close was called")
    },
    navigate: async () => {
      throw new Error("browser.navigate was called")
    },
    snapshot: async () => {
      throw new Error("browser.snapshot was called")
    },
    click: async () => {
      throw new Error("browser.click was called")
    },
    type: async () => {
      throw new Error("browser.type was called")
    },
    submit: async () => {
      throw new Error("browser.submit was called")
    },
    waitFor: async () => {
      throw new Error("browser.waitFor was called")
    },
    upload: async () => {
      throw new Error("browser.upload was called")
    },
    text: async () => {
      throw new Error("browser.text was called")
    },
    screenshot: async () => {
      throw new Error("browser.screenshot was called")
    },
    frame: async () => {
      throw new Error("browser.frame was called")
    },
    stop: async () => {},
  })

  /** A browser that opens and runs a run to the end, recording every value it was told to protect. */
  const recording = () => {
    const calls: Array<{ selector?: string; value: string }> = []
    const view = {
      id: "s1",
      project: "proj",
      headed: false,
      createdAt: 0,
      lastUsedAt: 0,
      idleTimeoutMs: 0,
      url: "https://example.com/",
      title: "",
    }
    const browser: BrowserRuntime = {
      start: async (input) => ({ ...view, id: input.id, project: input.project }),
      openLogin: async (input) => ({ ...view, id: input.id, project: input.project }),
      protect: (_id, input) => void calls.push(input),
      clearData: async () => true,
      get: () => view,
      close: async () => true,
      navigate: async () => ({ url: view.url, title: view.title }),
      snapshot: async () => ({ url: view.url, title: view.title, text: "" }),
      click: async () => ({ url: view.url, title: view.title }),
      type: async () => ({ url: view.url, title: view.title }),
      submit: async () => ({ url: view.url, title: view.title }),
      waitFor: async () => ({ url: view.url, title: view.title }),
      upload: async () => ({ url: view.url, title: view.title }),
      text: async () => ({ value: null, url: view.url, title: view.title }),
      screenshot: async () => ({ artifactId: "artifact" }),
      frame: async () => ({ bytes: new Uint8Array() }),
      stop: async () => {},
    }
    return { browser, calls }
  }

  const signin = (origin: string) => ({
    tool: "do_signin",
    kind: "browser",
    origin,
    credential: "site_account",
    steps: [{ goto: "{{origin}}/" }, { fill: { selector: "#user", credential: "{{credential}}" } }],
    evidence: { screenshots: "none" },
  })

  const runnerWith = (browser: BrowserRuntime, repository: SqliteRoutineRepository, vault: CredentialVault) =>
    createActionRunner({
      browser,
      repository,
      credentials: vault,
      loadProfiles: () => ({ configDir: "/nonexistent", profiles: { signin: signin("https://example.com") } }),
    })

  const thrownBy = async (work: Promise<unknown>): Promise<Error> => {
    try {
      await work
    } catch (cause) {
      if (cause instanceof Error) return cause
      return new Error(String(cause))
    }
    throw new Error("expected the action to fail")
  }

  const failureOf = async (work: Promise<unknown>): Promise<ActionRunError> => {
    const error = await thrownBy(work)
    if (error instanceof ActionRunError) return error
    throw error
  }

  test("a credential bound to another origin fails before the browser opens", async () => {
    const repository = store()
    const vault = createVault({ store: repository, key: Buffer.alloc(32, 6) })
    vault.set({ name: "site_account", origin: "https://other.example", secret: "s3cret" })
    const runner = runnerWith(unstarted(), repository, vault)

    const error = await failureOf(runner.run({ action: "signin", sessionID: "s1", project: "proj" }))
    expect(error).toMatchObject({ code: "credential_unavailable", status: 422 })
  })

  test("a credential whose origin matches is prefetched before the browser opens", async () => {
    const repository = store()
    const vault = createVault({ store: repository, key: Buffer.alloc(32, 7) })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    const runner = runnerWith(unstarted(), repository, vault)

    const error = await thrownBy(runner.run({ action: "signin", sessionID: "s1", project: "proj" }))
    expect(error.message).toBe("browser.start was called")
  })

  test("a matching credential is protected before and after it is typed", async () => {
    const repository = store()
    const vault = createVault({ store: repository, key: Buffer.alloc(32, 8) })
    vault.set({ name: "site_account", origin: "https://example.com", secret: "s3cret" })
    const { browser, calls } = recording()
    const runner = runnerWith(browser, repository, vault)

    const result = await runner.run({ action: "signin", sessionID: "s1", project: "proj" })
    expect(result.status).toBe("success")
    expect(calls).toContainEqual({ value: "s3cret" })
    expect(calls).toContainEqual({ selector: "#user", value: "s3cret" })
  })
})
