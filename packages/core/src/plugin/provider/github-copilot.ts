import { Effect, Schedule } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { Credential } from "../../credential"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"

const clientID = "Ov23li8tweQw6odWQebz"
const apiVersion = "2026-06-01"
const deviceCodeURL = "https://github.com/login/device/code"
const accessTokenURL = "https://github.com/login/oauth/access_token"
// GitHub device-flow tokens used by Copilot are long-lived. Keep the credential
// well beyond the integration refresh window so it is never force-refreshed.
const credentialLifetime = 100 * 365 * 24 * 60 * 60 * 1000
const pollingSafetyMargin = 3000
const methodID = Integration.MethodID.make("device")

type Device = {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
}

type TokenResult = {
  access_token?: string
  error?: string
  interval?: number
}

const oauth = {
  integrationID: Integration.ID.make("github-copilot"),
  method: {
    id: methodID,
    type: "oauth",
    label: "Login with GitHub Copilot",
  },
  authorize: () =>
    Effect.gen(function* () {
      const device = yield* request<Device>(deviceCodeURL, {
        method: "POST",
        headers: headers("application/json"),
        body: JSON.stringify({ client_id: clientID }),
      }).pipe(Effect.retry({ times: 8, schedule: Schedule.spaced("1500 millis") }))
      return {
        mode: "auto" as const,
        url: device.verification_uri,
        instructions: `Enter code: ${device.user_code}`,
        callback: poll(device),
      }
    }),
} satisfies IntegrationOAuthMethodRegistration

export const GithubCopilotPlugin = {
  id: "github-copilot",
  effect: Effect.fn(function* (ctx: PluginContext) {
    yield* ctx.integration.transform((draft) => {
      draft.update("github-copilot", (integration) => {
        integration.name = "GitHub Copilot"
      })
      draft.method.update(oauth)
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        evt.provider.update(ProviderV2.ID.githubCopilot, (provider) => {
          provider.request.headers["X-GitHub-Api-Version"] = apiVersion
          provider.request.headers["Openai-Intent"] = "conversation-edits"
        })
        const item = evt.provider.get(ProviderV2.ID.githubCopilot)
        if (!item || !item.models.has(ModelV2.ID.make("gpt-5-chat-latest"))) return
        evt.model.update(item.provider.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
          // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
          // so hide it only for Copilot rather than for every provider catalog.
          model.enabled = false
        })
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/github-copilot") return
        const mod = yield* Effect.promise(() => import("../../github-copilot/copilot-provider"))
        evt.sdk = mod.createOpenaiCompatible(evt.options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.githubCopilot) return
        if (evt.sdk.responses === undefined && evt.sdk.chat === undefined) {
          evt.language = evt.sdk.languageModel(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "responses" && evt.sdk.responses) {
          evt.language = evt.sdk.responses(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "chat" && evt.sdk.chat) {
          evt.language = evt.sdk.chat(evt.model.api.id)
          return
        }
        const match = /^gpt-(\d+)/.exec(evt.model.api.id)
        // Copilot supports Responses for GPT-5 class models, except mini variants
        // which still need the chat-completions endpoint.
        evt.language =
          match && Number(match[1]) >= 5 && !evt.model.api.id.startsWith("gpt-5-mini") && evt.sdk.responses
            ? evt.sdk.responses(evt.model.api.id)
            : evt.sdk.chat(evt.model.api.id)
      }),
    )
  }),
}

function poll(device: Device): Effect.Effect<Credential.OAuth, unknown> {
  const loop = (interval: number): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(interval + pollingSafetyMargin)
      const result = yield* request<TokenResult>(accessTokenURL, {
        method: "POST",
        headers: headers("application/json"),
        body: JSON.stringify({
          client_id: clientID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }).pipe(Effect.retry({ times: 3, schedule: Schedule.spaced("1500 millis") }))
      if (result.access_token) return credential(result.access_token)
      if (result.error === "authorization_pending") return yield* loop(interval)
      if (result.error === "slow_down") {
        return yield* loop(result.interval && result.interval > 0 ? result.interval * 1000 : interval + 5000)
      }
      return yield* Effect.fail(new Error(`GitHub Copilot authorization failed: ${result.error ?? "unknown error"}`))
    })
  return loop(device.interval * 1000)
}

function credential(access: string) {
  return Credential.OAuth.make({
    type: "oauth" as const,
    methodID,
    access,
    refresh: access,
    expires: Date.now() + credentialLifetime,
  })
}

function headers(contentType: string) {
  return {
    Accept: "application/json",
    "Content-Type": contentType,
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return (await response.json()) as A
    },
    catch: (cause) => cause,
  })
}
