import { afterEach, describe, expect, test } from "bun:test"
import { adaptiveModels, modelDisplayName, setAdaptiveModels } from "./adaptive-copy"
import { setLocale } from "./i18n"

const MODELS = [
  { id: "jev", name: "Jev", locality: "remote" as const, supports: ["completion"], needsConsent: true, needsKey: true },
  {
    id: "small-llm",
    name: "Small model (through the engine)",
    locality: "remote" as const,
    supports: ["completion"],
    needsConsent: true,
    needsKey: false,
  },
]

afterEach(() => {
  setAdaptiveModels([])
  setLocale("en")
})

describe("a model's display name outside Settings (AH-C01)", () => {
  test("is the registry's name once the app has read it, and the raw id before", () => {
    expect(modelDisplayName("jev")).toBe("jev")
    setAdaptiveModels(MODELS)
    expect(adaptiveModels()).toHaveLength(2)
    expect(modelDisplayName("jev")).toBe("Jev")
    expect(modelDisplayName("small-llm")).toBe("Small model (through the engine)")
  })

  test("an id the registry does not hold is shown as it is", () => {
    setAdaptiveModels(MODELS)
    expect(modelDisplayName("removed-provider")).toBe("removed-provider")
    expect(modelDisplayName("deterministic")).toBe("deterministic")
  })

  test("is translated when the app knows the words, and a brand name is kept", () => {
    setAdaptiveModels(MODELS)
    setLocale("es")
    expect(modelDisplayName("small-llm")).toBe("Modelo pequeño (a través del motor)")
    expect(modelDisplayName("jev")).toBe("Jev")
  })
})
