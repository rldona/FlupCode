import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import * as InstanceState from "@/effect/instance-state"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const agentSvc = yield* Agent.Service
    const skillSvc = yield* Skill.Service
    const commandSvc = yield* Command.Service
    const locations = yield* LocationServiceMap.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const reload = Effect.fn("ConfigHttpApi.reload")(function* (ctx) {
      yield* configSvc.reload()
      yield* skillSvc.reload()
      yield* commandSvc.reload()
      yield* agentSvc.reload()
      // The ref has to be the raw request directory, not the canonicalized instance directory: the
      // v2 reader builds its own ref from the raw request, so a symlinked or trailing-slash path
      // would otherwise boot a second location stack and leave the reload a silent no-op.
      const request = yield* HttpServerRequest.HttpServerRequest
      const query = new URL(request.url, "http://localhost").searchParams
      const directory =
        ctx.query.directory ??
        query.get("directory") ??
        (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : undefined) ??
        process.cwd()
      const workspaceID = ctx.query.workspace ? WorkspaceV2.ID.make(ctx.query.workspace) : undefined
      const ref = Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID })
      yield* Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        const commands = yield* CommandV2.Service
        const skills = yield* SkillV2.Service
        yield* agents.reload()
        yield* commands.reload()
        yield* skills.reload()
      }).pipe(Effect.provide(locations.get(ref)))
      return true
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers).handle("reload", reload)
  }),
)

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}
