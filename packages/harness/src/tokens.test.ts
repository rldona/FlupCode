import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * The design system, checked rather than trusted.
 *
 * A `var(--fc-thing)` that nobody defines is not a loud failure: the declaration is invalid at
 * computed-value time and the property quietly takes its initial value. `border-radius` becomes 0
 * and `height` becomes auto — so a component drawn with an invented token looks *almost* right,
 * squarer and flatter than everything around it, and nothing anywhere says so.
 *
 * That is exactly how this repository drifted: `--fc-radius-2`, `--fc-radius-3`, `--fc-surface` and
 * `--fc-control-h` were used in 32 declarations across the screens built between 13 and 17 September
 * 2026, and none of the four had ever been defined — not renamed, never defined. The corners the
 * design system calls 8px and 12px were square.
 */

const STYLES = join(import.meta.dir, "styles")

const css = () =>
  readdirSync(STYLES)
    .filter((name) => name.endsWith(".css"))
    .map((name) => ({ name, text: readFileSync(join(STYLES, name), "utf8") }))

/** Every `--fc-*: value` in the stylesheets — the vocabulary that exists. */
function defined() {
  const names = new Set<string>()
  for (const file of css()) {
    for (const match of file.text.matchAll(/^\s*(--fc-[\w-]+)\s*:/gm)) names.add(match[1]!)
  }
  return names
}

/** Every `var(--fc-*)` used with no fallback, which is where an invented name does its damage. */
function usedWithoutFallback() {
  const uses: Array<{ file: string; line: number; name: string; text: string }> = []
  for (const file of css()) {
    file.text.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(/var\((--fc-[\w-]+)\s*(,?)/g)) {
        if (match[2]) continue
        uses.push({ file: file.name, line: index + 1, name: match[1]!, text: text.trim() })
      }
    })
  }
  return uses
}

/** Set from JavaScript at runtime rather than declared in CSS, and searched for to prove it. */
const FROM_JAVASCRIPT = ["--fc-sidebar-width", "--fc-chat-inset", "--fc-chat-zoom", "--fc-scrollbar-size"]

describe("the design tokens", () => {
  test("every token a stylesheet uses without a fallback is one that exists", () => {
    const names = defined()
    const missing = usedWithoutFallback()
      .filter((use) => !names.has(use.name) && !FROM_JAVASCRIPT.includes(use.name))
      .map((use) => `${use.file}:${use.line} ${use.text}`)

    expect(missing).toEqual([])
  })

  test("the ones set from JavaScript really are set from JavaScript", () => {
    // Otherwise this list becomes a place to hide an invented token from the check above.
    const source = readdirSync(join(import.meta.dir), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name))
      .map((name) => readFileSync(join(import.meta.dir, name), "utf8"))
      .join("\n")
    for (const name of FROM_JAVASCRIPT) {
      expect(source).toContain(`"${name}"`)
    }
  })

  test("is reading the real stylesheets, not an empty list", () => {
    // A regular expression that matched nothing would make the checks above pass for ever.
    expect(defined().size).toBeGreaterThan(40)
    expect(usedWithoutFallback().length).toBeGreaterThan(200)
  })
})

describe("the palettes", () => {
  /** Each palette block and the colour names it sets. */
  function palettes() {
    const text = readFileSync(join(STYLES, "tokens.css"), "utf8")
    const blocks = new Map<string, Set<string>>()
    for (const [, head, body] of text.matchAll(/^([^\s/][^{]*)\{([^}]*)\}/gm)) {
      const names = new Set([...body!.matchAll(/(--fc-[\w-]+)\s*:/g)].map((match) => match[1]!))
      if (head!.includes("fc-theme") || head!.trim() === ".fc-dark") blocks.set(head!.trim(), names)
    }
    return blocks
  }

  test("every palette answers for every colour, or a light one leaks into dark mode", () => {
    // The file says so itself: "Every token set by a palette must also be set by its `.fc-dark`
    // block, otherwise the light palette would win in dark mode." This is that sentence, checked.
    const blocks = [...palettes().entries()]
    expect(blocks.length).toBeGreaterThan(5)
    const [, first] = blocks[0]!
    for (const [head, names] of blocks) {
      expect({ head, missing: [...first].filter((name) => !names.has(name)).sort() }).toEqual({ head, missing: [] })
    }
  })

  test("merged has a colour of its own, in all of them", () => {
    for (const [, names] of palettes()) expect(names.has("--fc-merged")).toBe(true)
  })
})

describe("what the design system says about shape", () => {
  test("the radii are the three in docs/DESIGN.md", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8")
    expect(tokens).toContain("--fc-radius-sm: 8px")
    expect(tokens).toContain("--fc-radius-md: 12px")
    expect(tokens).toContain("--fc-radius-lg: 16px")
  })

  test("nothing writes a corner the system already has a name for", () => {
    // Not every radius: the file has hairlines and small decorative values the system never named,
    // and inventing tokens for those would be the same mistake from the other side. This catches
    // the ones that duplicate a name — 8, 12, 16 and the pill — which is how a rule ends up not
    // moving when the system does.
    const named = /border-radius:\s*(?:8|12|16|999)px\b/
    const offenders: string[] = []
    for (const file of css()) {
      file.text.split("\n").forEach((text, index) => {
        if (named.test(text)) offenders.push(`${file.name}:${index + 1} ${text.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe("contrast, in every palette and mode (WCAG AA, AH-E06)", () => {
  /** Every palette as the browser resolves it: the root, then `.fc-dark`, then the palette's own blocks. */
  function resolved() {
    const text = readFileSync(join(STYLES, "tokens.css"), "utf8")
    const blocks = new Map<string, Record<string, string>>()
    for (const [, head, body] of text.matchAll(/^([^\s/@][^{]*)\{([^}]*)\}/gm)) {
      const values = Object.fromEntries(
        [...body!.matchAll(/(--fc-[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
      )
      blocks.set(head!.trim(), { ...blocks.get(head!.trim()), ...values })
    }
    const root = blocks.get(":root")!
    const dark = { ...root, ...blocks.get(".fc-dark") }
    const themes: Record<string, Record<string, string>> = { "flupcode light": root, "flupcode dark": dark }
    for (const [head, values] of blocks) {
      const match = /^\[data-fc-theme="([\w-]+)"\](\.fc-dark)?$/.exec(head)
      if (!match) continue
      const light = blocks.get(`[data-fc-theme="${match[1]}"]`)
      if (match[2]) themes[`${match[1]} dark`] = { ...dark, ...light, ...values }
      else themes[`${match[1]} light`] = { ...root, ...values }
    }
    return themes
  }

  /** A colour as sRGB channels, laid over `under` when it is translucent. */
  function rgb(value: string, under: number[] = [255, 255, 255]): number[] {
    if (value.startsWith("#")) return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
    const parts = /rgba?\(([^)]+)\)/.exec(value)![1]!.split(",").map(Number)
    const alpha = parts[3] ?? 1
    return [0, 1, 2].map((index) => parts[index]! * alpha + under[index]! * (1 - alpha))
  }

  function ratio(a: number[], b: number[]) {
    const luminance = (color: number[]) => {
      const [r, g, b] = color.map((channel) => {
        const s = channel / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (light! + 0.05) / (dark! + 0.05)
  }

  /** Every pair below `minimum`, as "palette: fg on bg = ratio", so a failure names what to fix. */
  function failures(pairs: Array<[string, string]>, minimum: number) {
    return Object.entries(resolved()).flatMap(([name, values]) =>
      pairs.flatMap(([fg, bg]) => {
        const canvas = rgb(values["--fc-bg"]!)
        const background = rgb(values[bg]!, canvas)
        const value = ratio(rgb(values[fg]!, background), background)
        return value < minimum ? [`${name}: ${fg} on ${bg} = ${value.toFixed(2)}`] : []
      }),
    )
  }

  test("is reading every palette, light and dark", () => {
    expect(Object.keys(resolved()).length).toBeGreaterThanOrEqual(14)
  })

  test("body text, secondary text and the status colours read at 4.5:1 on both canvases", () => {
    // The adaptive cards say their state in --fc-success / --fc-warning, and every hint is muted.
    const colours = ["--fc-text", "--fc-text-muted", "--fc-success", "--fc-warning", "--fc-danger"]
    const pairs = colours.flatMap(
      (fg): Array<[string, string]> => [
        [fg, "--fc-bg"],
        [fg, "--fc-bg-elevated"],
      ],
    )
    expect(failures(pairs, 4.5)).toEqual([])
  })

  test("a picked option reads at 4.5:1 and its accent edge at 3:1", () => {
    expect(failures([["--fc-text", "--fc-accent-soft"]], 4.5)).toEqual([])
    expect(
      failures(
        [
          ["--fc-accent", "--fc-bg"],
          ["--fc-accent", "--fc-bg-elevated"],
        ],
        3,
      ),
    ).toEqual([])
  })

  test("the focus ring is the secondary text colour, so it clears 3:1 wherever that clears 4.5:1", () => {
    const shell = readFileSync(join(STYLES, "shell.css"), "utf8")
    expect(shell).toContain("--fc-focus-border: var(--fc-text-muted);")
  })
})

describe("motion (UX-03)", () => {
  /** Everything that sets a time or a curve: transitions, animations, and their long-hand parts. */
  const MOTION = /^\s*(?:transition|animation)(?:-[a-z-]+)?\s*:/
  const LITERAL = /\b\d*\.?\d+m?s\b|cubic-bezier\(|\bease(?:-in|-out|-in-out)?\b/

  test("the durations and the easing are tokens, and nothing else writes one", () => {
    // A declaration's value can run over several lines: each one up to its semicolon is checked.
    const offenders = css()
      .filter((file) => file.name !== "tokens.css")
      .flatMap((file) =>
        [...file.text.matchAll(/^[^\S\n]*(?:transition|animation)(?:-[a-z-]+)?\s*:[^;]*;/gm)].flatMap((match) => {
          const value = match[0].replace(/var\(--fc-[\w-]+\)/g, "")
          if (!LITERAL.test(value)) return []
          const line = file.text.slice(0, match.index).split("\n").length
          return [`${file.name}:${line} ${match[0].trim().replace(/\s+/g, " ")}`]
        }),
      )
    expect(offenders).toEqual([])
  })

  test("no component writes a duration either", () => {
    const offenders = readdirSync(join(import.meta.dir), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .flatMap((name) =>
        readFileSync(join(import.meta.dir, name), "utf8")
          .split("\n")
          .flatMap((text, index) =>
            // An inline style, or the Web Animations API, are the two ways a component could.
            (/["']?(?:transition|animation)(?:-[a-z]+)?["']?\s*:/.test(text) && LITERAL.test(text)) ||
            /\.animate\(/.test(text)
              ? [`${name}:${index + 1} ${text.trim()}`]
              : [],
          ),
      )
    expect(offenders).toEqual([])
  })

  test("is reading the real declarations", () => {
    const declarations = css().flatMap((file) => file.text.split("\n").filter((text) => MOTION.test(text)))
    expect(declarations.length).toBeGreaterThan(30)
  })

  test("two durations and one easing, set to nothing under reduced motion in this one place", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8")
    expect(tokens).toContain("--fc-duration-short: 120ms")
    expect(tokens).toContain("--fc-duration-long: 200ms")
    expect(tokens).toContain("--fc-ease: cubic-bezier(0.2, 0, 0, 1)")
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? ""
    for (const name of ["--fc-duration-short", "--fc-duration-long", "--fc-duration-loop"]) {
      expect(reduced).toContain(`${name}: 0s`)
    }
    const elsewhere = css().filter(
      (file) => file.name !== "tokens.css" && file.text.includes("prefers-reduced-motion"),
    )
    expect(elsewhere.map((file) => file.name)).toEqual([])
  })
})

describe("type (UX-06)", () => {
  /** Every `font-size` and `font` declaration outside tokens.css, with where it is. */
  const declarations = () =>
    css()
      .filter((file) => file.name !== "tokens.css")
      .flatMap((file) =>
        [...file.text.matchAll(/^[^\S\n]*(font-size|font)\s*:\s*([^;]*);/gm)].map((match) => ({
          property: match[1]!,
          value: match[2]!.trim(),
          where: `${file.name}:${file.text.slice(0, match.index).split("\n").length}`,
        })),
      )

  test("every font size is a token, and nothing else writes one", () => {
    // A size written in pixels does not move when the scale does, and is how this file collected
    // 195 of them next to 197 that used the tokens. `font: inherit` sets no size of its own; the
    // shorthand may carry a line height after the slash, but its size is a token too.
    const offenders = declarations()
      .filter((declaration) => {
        if (declaration.value === "inherit") return false
        if (declaration.property === "font-size") return !/^var\(--fc-text-[\w-]+\)$/.test(declaration.value)
        return /\d*\.?\d+(?:px|r?em|pt|%)|\b(?:small|medium|large|smaller|larger)\b/.test(
          declaration.value.split("/")[0]!.replace(/var\(--fc-[\w-]+\)/g, ""),
        )
      })
      .map((declaration) => `${declaration.where} ${declaration.property}: ${declaration.value}`)
    expect(offenders).toEqual([])
  })

  test("is reading the real declarations", () => {
    expect(declarations().filter((declaration) => declaration.property === "font-size").length).toBeGreaterThan(400)
  })

  test("the scale is the one in docs/DESIGN.md", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8")
    const scale = { "2xs": 10, xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 18, "2xl": 20, "3xl": 26, "4xl": 32, display: 40 }
    for (const [name, size] of Object.entries(scale)) expect(tokens).toContain(`--fc-text-${name}: ${size}px;`)
    const design = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "DESIGN.md"), "utf8")
    expect(design).toContain(Object.values(scale).join(" / "))
  })

  test("docs/DESIGN.md sets FlupCode's own direction, not another product's", () => {
    // It used to open with "The target look is the Anthropic Claude Code desktop harness" (audit P1).
    const design = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "DESIGN.md"), "utf8")
    expect(design).not.toMatch(/target look|Claude|Anthropic|OpenChamber|-style palette/i)
    expect(design).toContain("supervised, verified and costed")
  })

  test("no component sets a font size of its own", () => {
    const offenders = readdirSync(join(import.meta.dir), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .flatMap((name) =>
        readFileSync(join(import.meta.dir, name), "utf8")
          .split("\n")
          .flatMap((text, index) =>
            /["']?font-?size["']?\s*:\s*["']?\d/i.test(text) ? [`${name}:${index + 1} ${text.trim()}`] : [],
          ),
      )
    expect(offenders).toEqual([])
  })
})

describe("icons (UX-06)", () => {
  // Arrows, technical symbols, enclosed and geometric shapes, dingbats, the multiplication sign, the
  // angle quotes, the full-width plus and emoji: the characters that end up standing in for an icon.
  // The minus sign (U+2212) is not here: "−12" is a number, not an icon.
  const GLYPH = /[×‹›←-⇿⌀-⏿①-⓿■-➿⬀-⯿＋\u{1f300}-\u{1faff}]/u
  const ONLY_GLYPHS = new RegExp(`^\\s*${GLYPH.source}(?:\\s|${GLYPH.source})*$`, "u")

  /** The app's own source, comments taken out: a comment may draw an arrow. */
  const sources = () =>
    readdirSync(join(import.meta.dir), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => ({
        name,
        text: readFileSync(join(import.meta.dir, name), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
          .replace(/(^|[^:"'`])\/\/[^\n]*/gm, "$1"),
      }))

  const at = (text: string, index: number) => text.slice(0, index).split("\n").length

  test("no glyph is used as an icon: an icon comes from components/Icon.tsx", () => {
    const offenders = sources().flatMap((file) => {
      // The names of keys, shown as keys: ⌘, ⌥ and ⇧ are what the keyboard says, not icons.
      if (file.name === "keybinds.ts") return []
      // A run of JSX text that is nothing but glyphs, unless it is a key in a <kbd>.
      const text = [...file.text.matchAll(/[>}]([^<>{}]*)[<{]/g)]
        .filter((match) => ONLY_GLYPHS.test(match[1]!) && !file.text.slice(0, match.index + 1).endsWith("<kbd>"))
        .map((match) => `${file.name}:${at(file.text, match.index)} ${match[1]!.trim()}`)
      // A string that is nothing but glyphs: a menu icon, a caret, a mark chosen in a ternary.
      const strings = [...file.text.matchAll(/(["'`])((?:(?!\1)[^\n\\])*)\1/g)]
        .filter((match) => ONLY_GLYPHS.test(match[2]!))
        .map((match) => `${file.name}:${at(file.text, match.index)} ${match[0]}`)
        // An arrow joining names in a sentence ("Runs: plan → build") is punctuation in the text.
        .filter((offender) => !/^components\/ResumeConfirm\.tsx:\d+ " → "$/.test(offender))
      return [...text, ...strings]
    })
    expect(offenders).toEqual([])
  })

  test("nor does a stylesheet draw one", () => {
    const offenders = css().flatMap((file) =>
      [...file.text.matchAll(/content:\s*([^;]*);/g)]
        .filter((match) => GLYPH.test(match[1]!))
        .map((match) => `${file.name}:${at(file.text, match.index)} ${match[0]}`),
    )
    expect(offenders).toEqual([])
  })

  test("is reading the real source", () => {
    // The set is in use, and the check above would have found the glyphs it replaced.
    const all = sources()
    expect(all.filter((file) => file.text.includes("<Icon ")).length).toBeGreaterThan(30)
    expect(ONLY_GLYPHS.test("▾")).toBe(true)
    expect(ONLY_GLYPHS.test("×")).toBe(true)
    expect(ONLY_GLYPHS.test("−")).toBe(false)
    expect(ONLY_GLYPHS.test("⌘K")).toBe(false)
  })
})
