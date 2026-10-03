import { hunkLabel, type PatchHunk } from "./patch"
import type { Attachment, ResolvedRef } from "./types"

/**
 * Something the reader pointed at, held in the composer as a removable chip until the message goes
 * (BU-06, UX-05).
 *
 * A chip is a part of the draft, not text in it: it has a type, says where it came from, and resolves
 * only on send. A file becomes a file part the engine reads; an artifact its content, by the rules a
 * run's packs follow (`harness-server/src/packs.ts`); a diff hunk, a terminal selection, a failing
 * check and a preview annotation a quoted block of the message (the annotation with its picture).
 * One that cannot be found when it resolves is marked, and the message does not go (P4).
 */
export type ContextChip = {
  id: string
  /** What the chip shows. */
  label: string
  /** Where it came from: a path, an address, a check's workflow. */
  source: string
  /** What resolving found wrong: gone, or too long and cut. */
  problem?: "missing" | "cut"
} & (
  | {
      /** A file of the project or an artifact, by the ref a pack would hold (`@src/a.ts`, `@artifact:<id>`). */
      type: "file" | "artifact"
      ref: string
    }
  | {
      type: "hunk"
      path: string
      /** The new file's lines the hunk covers, as `12-18`. */
      lines: string
      diff: string
    }
  | { type: "terminal" | "check"; text: string }
  | {
      type: "preview"
      /** The artifact the picture was kept as. */
      artifactID?: string
      /** The marked-up picture, as a PNG data URL. */
      image?: string
      note?: string
    }
)

/** Past this many characters a selection or a log is cut where it is taken, and the chip says so. */
export const CHIP_TEXT_LIMIT = 20_000

/** A chip for a ref a pack or the `@` menu holds; `undefined` for one that is not a file or an artifact. */
export function chipForRef(ref: string, label?: string): ContextChip | undefined {
  const value = ref.replace(/^@/, "")
  if (!value) return undefined
  if (value.startsWith("artifact:"))
    return { id: crypto.randomUUID(), type: "artifact", ref: `@${value}`, label: label ?? value.slice(9), source: value }
  // Anything else with a scheme, an absolute path or a climb is not a project file: it stays text.
  if (value.includes(":") || value.startsWith("/") || value.split("/").includes("..")) return undefined
  return { id: crypto.randomUUID(), type: "file", ref: `@${value}`, label: label ?? value, source: value }
}

/** A text chip (a terminal selection, a check's log), cut at the limit where it is taken. */
export function textChip(
  type: "terminal" | "check",
  label: string,
  source: string,
  text: string,
): ContextChip {
  const cut = text.length > CHIP_TEXT_LIMIT
  return {
    id: crypto.randomUUID(),
    type,
    label,
    source,
    text: cut ? text.slice(0, CHIP_TEXT_LIMIT) : text,
    ...(cut ? { problem: "cut" as const } : {}),
  }
}

/** A diff hunk as a chip: its file, the new file's lines it covers, and the hunk as git wrote it. */
export function hunkChip(path: string, hunk: PatchHunk): ContextChip {
  const count = hunk.lines.filter((line) => line.type !== "del").length
  const lines = count > 1 ? `${hunk.newStart}-${hunk.newStart + count - 1}` : `${hunk.newStart}`
  return {
    id: crypto.randomUUID(),
    type: "hunk",
    label: `${path.split("/").at(-1) ?? path}:${lines}`,
    source: path,
    path,
    lines,
    diff: [
      hunkLabel(hunk),
      ...hunk.lines.map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`),
    ].join("\n"),
  }
}

/** The refs the server has to resolve: the files and artifacts, in order. */
export function chipRefs(chips: ContextChip[]) {
  return [...new Set(chips.flatMap((chip) => (chip.type === "file" || chip.type === "artifact" ? [chip.ref] : [])))]
}

/**
 * What the chips add to the message: a block of text after the reader's, their files, and the chips
 * that could not be found. `resolved` is the server's answer for the refs; without one (no harness to
 * ask) a file or an artifact goes as its ref, as typed text always did.
 */
export function resolveChips(chips: ContextChip[], resolved?: ResolvedRef[]) {
  const answer = (chip: ContextChip) =>
    chip.type === "file" || chip.type === "artifact" ? resolved?.find((entry) => entry.ref === chip.ref) : undefined
  const missing = resolved
    ? chips.filter((chip) => (chip.type === "file" || chip.type === "artifact") && !hasContent(answer(chip)))
    : []
  return {
    text: chips
      .flatMap((chip) => {
        const found = answer(chip)
        if (found && "uri" in found) return []
        if (found && "quote" in found) return [found.quote]
        return [blockOf(chip)]
      })
      .join("\n\n"),
    files: chips.flatMap((chip): Attachment[] => {
      const found = answer(chip)
      if (found && "uri" in found) return [{ uri: found.uri, name: found.name }]
      if (chip.type === "preview" && chip.image)
        return [{ uri: chip.image, name: `preview-${chip.artifactID ?? chip.id}.png` }]
      return []
    }),
    missing: missing.map((chip) => chip.id),
    cut: chips
      .filter((chip) => {
        const found = answer(chip)
        return !!found && "cut" in found && found.cut
      })
      .map((chip) => chip.id),
  }
}

/** The reader's text with the chips' blocks after it. */
export function withChips(text: string, block: string) {
  if (!block) return text
  return text ? `${text}\n\n${block}` : block
}

const hasContent = (found: ResolvedRef | undefined) => !!found && !("missing" in found)

function blockOf(chip: ContextChip) {
  switch (chip.type) {
    case "file":
    case "artifact":
      return chip.ref
    case "hunk":
      return [`[Diff hunk of ${chip.path}, lines ${chip.lines}]`, fenced(chip.diff, "diff")].join("\n")
    case "terminal":
      return ["[Terminal selection]", fenced(chip.text)].join("\n")
    case "check":
      return [`[Failing check ${chip.label}${chip.source ? ` (${chip.source})` : ""}]`, fenced(chip.text)].join("\n")
    case "preview":
      return [
        `[Preview annotation of ${chip.source}${chip.artifactID ? `, artifact ${chip.artifactID}` : ""}]`,
        ...(chip.note?.trim() ? [`> ${chip.note.trim().replace(/\n/g, "\n> ")}`] : []),
        "The attached image is the page as FlupCode's preview showed it, with the marked areas numbered.",
      ].join("\n")
  }
}

/** A code fence longer than any run of backticks inside, so quoted text cannot close it early. */
function fenced(text: string, lang = "") {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`
}
