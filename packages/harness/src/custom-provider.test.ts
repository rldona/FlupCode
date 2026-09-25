import { describe, expect, test } from "bun:test"
import {
  customProviderPayload,
  editableProviderIDs,
  formFromConfigured,
  validateCustomProvider,
} from "./custom-provider"

const t = (key: string) => key

const form = (overrides: Partial<Parameters<typeof validateCustomProvider>[0]["form"]> = {}) => ({
  providerID: "custom-provider",
  name: "Custom Provider",
  baseURL: "https://api.example.com",
  apiKey: "",
  models: [{ row: "m0", id: "model-a", name: "Model A", effort: "", err: {} }],
  headers: [{ row: "h0", key: "", value: "", err: {} }],
  err: {},
  ...overrides,
})

describe("validateCustomProvider", () => {
  test("builds the V1 config payload and clears the provider from the disabled list", () => {
    const result = validateCustomProvider({
      form: form({
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", effort: "", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
      }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })

    expect(customProviderPayload(result.result!, ["stale", "custom-provider"])).toEqual({
      provider: {
        "custom-provider": {
          npm: "@ai-sdk/openai-compatible",
          name: "Custom Provider",
          env: ["CUSTOM_PROVIDER_KEY"],
          options: {
            baseURL: "https://api.example.com",
            headers: { "X-Test": "enabled" },
          },
          models: { "model-a": { name: "Model A" } },
        },
      },
      disabled_providers: ["stale"],
    })
  })

  test("rejects an id that is not lowercase letters, numbers, hyphens or underscores", () => {
    const result = validateCustomProvider({
      form: form({ providerID: "Bad ID" }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBe("Use lowercase letters, numbers, hyphens, or underscores")
  })

  test("flags duplicate model ids and requires a base URL", () => {
    const duplicate = validateCustomProvider({
      form: form({
        models: [
          { row: "m0", id: "model-a", name: "Model A", effort: "", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", effort: "", err: {} },
        ],
      }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(duplicate.result).toBeUndefined()
    expect(duplicate.models[1]).toEqual({ id: "Duplicate", name: undefined, effort: undefined })

    const missingURL = validateCustomProvider({
      form: form({ baseURL: "" }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(missingURL.result).toBeUndefined()
    expect(missingURL.err.baseURL).toBe("Base URL is required")
  })

  test("writes reasoning effort levels as variants and rejects malformed ones", () => {
    const result = validateCustomProvider({
      form: form({ models: [{ row: "m0", id: "chat", name: "Chat", effort: "low, MEDIUM ,high", err: {} }] }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(result.result?.config).toMatchObject({
      models: {
        chat: {
          name: "Chat",
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
          },
        },
      },
    })

    const invalid = validateCustomProvider({
      form: form({ models: [{ row: "m0", id: "chat", name: "Chat", effort: "fast!", err: {} }] }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(invalid.result).toBeUndefined()
    expect(invalid.models[0]?.effort).toBe("Use lowercase words separated by commas")

    const duplicate = validateCustomProvider({
      form: form({ models: [{ row: "m0", id: "chat", name: "Chat", effort: "low,low", err: {} }] }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      editableProviderIDs: new Set(),
    })

    expect(duplicate.models[0]?.effort).toBe("Duplicate")
  })

  test("reopens an OpenAI-compatible provider already in the config but rejects a foreign known id", () => {
    const configured = {
      mine: {
        name: "Mine",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.example.com", headers: { "X-Test": "1" } },
        models: { chat: { name: "Chat", variants: { low: { reasoningEffort: "low" } } } },
      },
      openai: { name: "OpenAI", npm: "@ai-sdk/openai" },
    }

    const editable = validateCustomProvider({
      form: form({ providerID: "mine" }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(["mine", "openai"]),
      editableProviderIDs: editableProviderIDs(configured),
    })
    expect(editable.result).toBeDefined()

    const foreign = validateCustomProvider({
      form: form({ providerID: "openai" }),
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(["mine", "openai"]),
      editableProviderIDs: editableProviderIDs(configured),
    })
    expect(foreign.result).toBeUndefined()
    expect(foreign.err.providerID).toBe("That provider ID already exists")

    expect(formFromConfigured(configured.mine)).toMatchObject({
      name: "Mine",
      baseURL: "https://api.example.com",
      models: [{ id: "chat", name: "Chat", effort: "low" }],
      headers: [{ key: "X-Test", value: "1" }],
    })
  })
})
