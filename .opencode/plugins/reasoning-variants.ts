import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { define } from "@opencode-ai/plugin/v2/promise"

type ReasoningOption =
  | { type: "effort"; values: Array<string | null> }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number }

type ModelsDevModel = { reasoning_options?: ReasoningOption[] }
type ModelsDevProvider = { models: Record<string, ModelsDevModel> }
type ModelsDev = Record<string, ModelsDevProvider>

function cachePath() {
  if (process.env.OPENCODE_MODELS_PATH) return process.env.OPENCODE_MODELS_PATH
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(base, "opencode", "models.json")
}

async function loadModelsDev(): Promise<ModelsDev> {
  const text = await readFile(cachePath(), "utf8").catch(() => "{}")
  return (JSON.parse(text) as ModelsDev) ?? {}
}

function efforts(model: ModelsDevModel | undefined) {
  const option = (model?.reasoning_options ?? []).find((item) => item.type === "effort")
  if (!option || option.type !== "effort") return []
  return option.values.filter((value): value is string => typeof value === "string")
}

// Map an effort tier to the raw request body field each protocol expects.
function variantBody(pkg: string | undefined, effort: string): Record<string, unknown> | undefined {
  if (pkg === "@ai-sdk/openai")
    return {
      reasoning: { effort },
      ...(effort === "none" ? {} : { include: ["reasoning.encrypted_content"] }),
    }
  if (pkg === "@ai-sdk/openai-compatible") return { reasoning_effort: effort }
  return undefined
}

export default define({
  id: "reasoning-variants",
  setup: async (ctx) => {
    let data: ModelsDev | undefined
    await ctx.catalog.transform(async (catalog) => {
      data ??= await loadModelsDev()
      for (const record of catalog.provider.list()) {
        const provider = data[record.provider.id]
        if (!provider) continue
        for (const model of record.models.values()) {
          const pkg =
            model.api.type === "aisdk"
              ? model.api.package
              : record.provider.api.type === "aisdk"
                ? record.provider.api.package
                : undefined
          for (const effort of efforts(provider.models[model.id])) {
            if (model.variants.some((variant) => variant.id === effort)) continue
            const body = variantBody(pkg, effort)
            if (!body) continue
            model.variants.push({ id: effort, headers: {}, body })
          }
        }
      }
    })
  },
})
