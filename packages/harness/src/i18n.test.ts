import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setLocale, t } from "./i18n"

const source = readFileSync(join(import.meta.dir, "i18n.ts"), "utf8")

/**
 * The Spanish map, read from the source rather than from the module.
 *
 * A duplicate key is a type error, but only once the file is typechecked — and an object literal
 * silently keeps the *last* one, so a translation quietly replaces an earlier one that was right.
 * This has happened four times while the screens of this backlog were being built, every time by
 * appending a block near another block that already had the word.
 */
function keysInOrder() {
  const start = source.indexOf("const ES:")
  const end = source.indexOf("\n}", start)
  const body = source.slice(start, end).split("\n")
  const keys: string[] = []
  for (const line of body) {
    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)):/.exec(line)
    if (match) keys.push(match[1] ?? match[2] ?? match[3]!)
  }
  return keys
}

describe("the Spanish map", () => {
  test("has no key twice", () => {
    const keys = keysInOrder()
    const seen = new Set<string>()
    const twice = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)))
    expect(twice).toEqual([])
  })

  test("is big enough that the check above is reading the real thing", () => {
    // A regular expression that matched nothing would make the test above pass for ever.
    expect(keysInOrder().length).toBeGreaterThan(300)
  })
})

describe("t", () => {
  test("answers the key itself in English, and the translation in Spanish", () => {
    setLocale("en")
    expect(t("Runs")).toBe("Runs")
    setLocale("es")
    expect(t("Runs")).toBe("Ejecuciones")
    setLocale("en")
  })

  test("fills the holes in a template", () => {
    expect(t("{n} files", { n: 3 })).toBe("3 files")
  })

  test("a key nobody translated is still readable, not blank", () => {
    setLocale("es")
    expect(t("Something nobody translated")).toBe("Something nobody translated")
    setLocale("en")
  })
})

describe("the Cost screen's subtitle", () => {
  const subtitle = "What your work cost: the runs the harness started, and below, every session, chats included."

  test("is the one the screen shows, and it names both the runs and every session", () => {
    // It once said chat turns were never counted, which stopped being true when Sessions arrived.
    expect(readFileSync(join(import.meta.dir, "components/UsagePanel.tsx"), "utf8")).toContain(`t("${subtitle}")`)
    setLocale("en")
    expect(t(subtitle)).toBe(subtitle)
    setLocale("es")
    expect(t(subtitle)).toBe(
      "Lo que ha costado tu trabajo: las ejecuciones que lanzó el harness y, debajo, cada sesión, chats incluidos.",
    )
    setLocale("en")
  })
})

/**
 * The adaptive surfaces (AH-E06): Settings → Adaptive, the composer chip, the Decisions screen, the
 * guardrail banner, the Skills screen's Learned section, and the Context and cost screens, which also
 * show adaptive results. Plus the module that holds their shared copy.
 */
const ADAPTIVE_SURFACES = [
  "components/AdaptiveSettingsPanel.tsx",
  "components/AdaptiveChip.tsx",
  "components/DecisionsPanel.tsx",
  "components/GuardrailBanner.tsx",
  "components/SkillCatalogue.tsx",
  "components/ContextPanel.tsx",
  "components/SessionCosts.tsx",
  "components/UsagePanel.tsx",
  "adaptive-copy.ts",
]

/**
 * The words of the audit's copy table (§7.4) that a reader should never meet: the internal names for
 * the predictive model, observe-only mode, the data-sharing allowlist, the skill-fit decision and the
 * built-in-rules fallback. "jev" may still appear as a provider's *name* — that is data the server
 * sends, never a string of the app — so it is only jargon when the app itself writes it.
 */
const JARGON = /\bjev\b|\bshadow\b|egress|skillRelevance|\bdegraded\b|\bdegradad[oa]\b/i

/**
 * The prose string literals of a source file: the ones with a space or a capital, which is what a
 * reader is shown. Identifiers, config paths ("jev.enabled") and ids ("egress-allowlist") are neither,
 * class lists and key names are not copy, and comments are dropped first — they are for the next
 * developer, who may say "shadow".
 */
function proseLiterals(file: string) {
  const code = readFileSync(join(import.meta.dir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .filter((text) => /\s/.test(text.trim()) || /^[A-Z]/.test(text))
    .filter((text) => !text.split(/\s+/).every((word) => word.startsWith("fc-")))
    .filter((text) => !/^(Escape|Enter|Tab|Home|End|Arrow(Up|Down|Left|Right))$/.test(text))
}

/** Every key and every translation of the Spanish map, a multi-line one included. */
function spanishEntries() {
  const start = source.indexOf("const ES:")
  const body = source.slice(start, source.indexOf("\n}", start))
  const quoted = [...body.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string)
  return [...keysInOrder(), ...quoted]
}

describe("the adaptive surfaces' copy (AH-E06)", () => {
  test("no string the adaptive surfaces show uses the internal jargon", () => {
    const offenders = ADAPTIVE_SURFACES.flatMap((file) =>
      proseLiterals(file)
        .filter((text) => JARGON.test(text))
        .map((text) => `${file}: ${text}`),
    )
    expect(offenders).toEqual([])
  })

  test("no key or translation of the Spanish map uses it either", () => {
    expect(spanishEntries().filter((text) => JARGON.test(text))).toEqual([])
  })

  test("every string the adaptive surfaces show has a Spanish translation", () => {
    const translated = new Set(spanishEntries())
    const missing = ADAPTIVE_SURFACES.flatMap((file) =>
      proseLiterals(file)
        .filter((text) => !translated.has(text))
        .map((text) => `${file}: ${text}`),
    )
    expect(missing).toEqual([])
  })

  test("the copy table of §7.4 reads the same in both languages", () => {
    setLocale("es")
    expect(t("Predictive model")).toBe("Modelo predictivo")
    expect(t("Which skills fit")).toBe("Qué skills encajan")
    expect(t("Observe only: nothing was filtered.")).toBe("Solo observar: no se filtró nada.")
    expect(t("Data shared with the predictive model")).toBe("Datos compartidos con el modelo predictivo")
    expect(t("Built-in rules were used ({reason})", { reason: "x" })).toBe("Se usaron reglas integradas (x)")
    setLocale("en")
  })

  test("the checks above are reading real files, not empty lists", () => {
    // A regular expression that matched nothing would make every check here pass for ever.
    expect(proseLiterals("components/AdaptiveSettingsPanel.tsx").length).toBeGreaterThan(100)
    expect(spanishEntries().length).toBeGreaterThan(600)
    // And the jargon pattern does catch the words it is for.
    for (const word of ["Jev", "Shadow only", "Egress allowlist", "skillRelevance", "Degraded"])
      expect(JARGON.test(word)).toBe(true)
  })
})
