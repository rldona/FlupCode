import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { GlobalBus } from "../../src/bus/global"
import { Effect, Schema } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it, pollWithTimeout } from "../lib/effect"

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const getJson = (pathname: string, directory?: string) =>
  Effect.promise(async () => {
    const response = await app().request(pathname, {
      headers: directory ? { "x-opencode-directory": directory } : undefined,
    })
    if (!response.ok) throw new Error(`unexpected status ${response.status}: ${await response.text()}`)
    return response.json()
  })

const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))
const decodeV2IDs = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
)
const decodeV2Names = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ name: Schema.String })) }),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config reload", () => {
  it.live(
    "rereads agent and command files without disposing the instance",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const opencode = path.join(tmp.path, ".opencode")
      yield* Effect.promise(() => fs.mkdir(opencode, { recursive: true }))
      let disposed = false
      const disposeListener = (event: { directory?: string; payload: { type: string } }) => {
        if (event.directory === tmp.path && event.payload.type === "server.instance.disposed") disposed = true
      }
      GlobalBus.on("event", disposeListener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", disposeListener)))

      // The config directory exists before the location opens, so both the legacy
      // and v2 surfaces discover it. The new files land after that.
      const legacyAgents = () =>
        getJson(`/agent?directory=${encodeURIComponent(tmp.path)}`).pipe(
          Effect.map((body) => decodeNames(body).map((item) => item.name)),
        )
      const legacyCommands = () =>
        getJson(`/command?directory=${encodeURIComponent(tmp.path)}`).pipe(
          Effect.map((body) => decodeNames(body).map((item) => item.name)),
        )
      const v2Agents = () =>
        getJson("/api/agent", tmp.path).pipe(Effect.map((body) => decodeV2IDs(body).data.map((item) => item.id)))
      const v2Commands = () =>
        getJson("/api/command", tmp.path).pipe(Effect.map((body) => decodeV2Names(body).data.map((item) => item.name)))

      expect(yield* legacyAgents()).not.toContain("reload-probe")
      expect(yield* v2Agents()).not.toContain("reload-probe")

      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(opencode, "agent"), { recursive: true })
        await fs.mkdir(path.join(opencode, "command"), { recursive: true })
        await Bun.write(
          path.join(opencode, "agent", "reload-probe.md"),
          "---\ndescription: Reload probe\nmode: subagent\n---\nProbe prompt",
        )
        await Bun.write(
          path.join(opencode, "command", "reload-command.md"),
          "---\ndescription: Reload command\n---\nDo the reloadable thing",
        )
      })

      expect(yield* legacyAgents()).not.toContain("reload-probe")
      expect(yield* legacyCommands()).not.toContain("reload-command")

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config/reload", {
            method: "POST",
            headers: { "x-opencode-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toBe(true)

      expect(yield* legacyAgents()).toContain("reload-probe")
      expect(yield* legacyCommands()).toContain("reload-command")
      expect(yield* v2Agents()).toContain("reload-probe")
      expect(yield* v2Commands()).toContain("reload-command")

      // Observation window: any disposal triggered by the reload would publish
      // synchronously through the global bus well within this bounded wait.
      yield* Effect.sleep("100 millis")
      expect(disposed).toBe(false)
    }),
  )

  it.live(
    "reloads the v2 location the reader resolves from a non-canonical directory",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const linkParent = yield* tmpdirEffect({})
      const opencode = path.join(tmp.path, ".opencode")
      yield* Effect.promise(() => fs.mkdir(opencode, { recursive: true }))

      // A symlink is not its own realpath, so the reload must name it exactly as the v2 reader does:
      // reusing the canonicalized instance directory here used to boot a second location stack and
      // leave the reload a no-op for the reader's ref.
      const link = path.join(linkParent.path, "link")
      yield* Effect.promise(() => fs.symlink(tmp.path, link))

      const v2Agents = () =>
        getJson("/api/agent", link).pipe(Effect.map((body) => decodeV2IDs(body).data.map((item) => item.id)))

      // The location's own definitions are registered asynchronously, so wait until the stack the
      // reader uses has materialized before writing: otherwise the new file would be picked up by
      // that very first read and the reload would prove nothing.
      yield* pollWithTimeout(
        v2Agents().pipe(Effect.map((names) => (names.includes("build") ? names : undefined))),
        "v2 agents never loaded for the linked directory",
      )

      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(opencode, "agent"), { recursive: true })
        await Bun.write(
          path.join(opencode, "agent", "reload-probe.md"),
          "---\ndescription: Reload probe\nmode: subagent\n---\nProbe prompt",
        )
      })
      expect(yield* v2Agents()).not.toContain("reload-probe")

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config/reload", {
            method: "POST",
            headers: { "x-opencode-directory": link },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toBe(true)

      expect(yield* v2Agents()).toContain("reload-probe")
    }),
  )
})
