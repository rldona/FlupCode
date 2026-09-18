import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Credential } from "@opencode-ai/core/credential"
import { Global } from "@opencode-ai/core/global"
import { Integration } from "@opencode-ai/core/integration"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Auth.node, Credential.node])))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("exposes credentials created through the v2 integration flow", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("github-copilot"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "gho_access",
          refresh: "gho_refresh",
          expires: 1,
        }),
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("deepseek"),
        value: Credential.Key.make({ type: "key", key: "credential-key" }),
      })
      yield* auth.set("deepseek", { type: "api", key: "file-key" })

      const copilot = yield* auth.get("github-copilot")
      expect(copilot).toEqual({ type: "oauth", access: "gho_access", refresh: "gho_refresh", expires: 1 })

      // auth.json wins when the same provider exists in both stores
      const deepseek = yield* auth.get("deepseek")
      expect(deepseek).toEqual({ type: "api", key: "file-key" })

      // writing auth.json must not copy credentials out of the database
      expect(yield* Effect.promise(() => Bun.file(path.join(Global.Path.data, "auth.json")).json())).toEqual({
        deepseek: { type: "api", key: "file-key" },
      })
    }),
  )
})
