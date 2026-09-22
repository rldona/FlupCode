import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const githubCopilot = Integration.ID.make("github-copilot")
const githubCopilotMethod = Integration.MethodID.make("device")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const credential = yield* Credential.Service
    const decode = Schema.decodeUnknownOption(Info)

    const stored = Effect.fn("Auth.stored")(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      // Credentials created through the v2 integration flow live in the database, so
      // surface them here too; auth.json entries still win when both exist.
      const credentials = yield* credential.all()
      return {
        ...Object.fromEntries(credentials.map((item) => [item.integrationID as string, fromCredential(item.value)])),
        ...(yield* stored()),
      } as Record<string, Info>
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* stored()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
      if (norm === githubCopilot && info.type === "oauth") {
        yield* credential.create({
          integrationID: githubCopilot,
          value: githubCopilotCredential(info),
        })
      }
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* stored()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      if (norm === githubCopilot) {
        yield* Effect.forEach(yield* credential.list(githubCopilot), (item) => credential.remove(item.id), {
          discard: true,
        })
      }
    })

    const legacyCopilot = (yield* stored())[githubCopilot]
    if (legacyCopilot?.type === "oauth" && !(yield* credential.list(githubCopilot)).length) {
      yield* credential.create({
        integrationID: githubCopilot,
        value: githubCopilotCredential(legacyCopilot),
      })
    }

    return Service.of({ get, all, set, remove })
  }),
)

function githubCopilotCredential(info: Oauth) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: githubCopilotMethod,
    access: info.access,
    refresh: info.refresh,
    expires: info.expires,
    ...(info.accountId || info.enterpriseUrl
      ? {
          metadata: {
            ...(info.accountId ? { accountId: info.accountId } : {}),
            ...(info.enterpriseUrl ? { enterpriseUrl: info.enterpriseUrl } : {}),
          },
        }
      : {}),
  })
}

function fromCredential(value: Credential.Value): Info {
  if (value.type === "key") return new Api({ type: "api", key: value.key })
  const metadata = value.metadata ?? {}
  return new Oauth({
    type: "oauth",
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    ...(typeof metadata.accountId === "string" ? { accountId: metadata.accountId } : {}),
    ...(typeof metadata.enterpriseUrl === "string" ? { enterpriseUrl: metadata.enterpriseUrl } : {}),
  })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, Credential.node] })

export * as Auth from "."
