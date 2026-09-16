/**
 * Unified diffs, read as hunks.
 *
 * A patch arrives from the engine as one string per file. Rendering it line by line is what the
 * files panel used to do, and it put `diff --git`, `index 1234..5678` and the two `---`/`+++` rows
 * on screen as if they were code: four rows of file identity above a header that already says which
 * file this is. Hunks drop them and keep the only header worth showing, `@@`, which is where in the
 * file the change lands.
 */

export type PatchLine = {
  type: "add" | "del" | "same"
  /** The line's number in the old file; absent on an addition, which has no old line. */
  oldNo?: number
  /** The line's number in the new file; absent on a deletion. */
  newNo?: number
  text: string
}

export type PatchHunk = {
  /** What the `@@` row said, minus the counts: the section heading git puts after them, if any. */
  heading: string
  oldStart: number
  newStart: number
  lines: PatchLine[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Splits a unified diff into its hunks.
 *
 * Anything before the first `@@` is the file header and is dropped: the caller already knows the
 * path, the status and the counts, because the API hands them alongside the patch. A patch with no
 * `@@` at all — a binary file, or a rename with no content change — yields no hunks, which is the
 * honest answer and lets the caller say so instead of printing git's own prose as code.
 */
export function parseHunks(patch: string | undefined): PatchHunk[] {
  if (!patch) return []
  const hunks: PatchHunk[] = []
  let current: PatchHunk | undefined
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[3])
      current = { heading: header[5]?.trim() ?? "", oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    // "\ No newline at end of file" annotates the line above it. It is not a line of the file, and
    // showing it numbered among them says the file has a row it does not have.
    if (line.startsWith("\\")) continue
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", newNo, text: line.slice(1) })
      newNo++
      continue
    }
    if (line.startsWith("-")) {
      current.lines.push({ type: "del", oldNo, text: line.slice(1) })
      oldNo++
      continue
    }
    // A context line starts with a space. The last line of a patch is often empty because the
    // string ends with a newline, and an empty string is not a context line — it is the end.
    if (line === "") continue
    current.lines.push({ type: "same", oldNo, newNo, text: line.startsWith(" ") ? line.slice(1) : line })
    oldNo++
    newNo++
  }
  return hunks
}

/** How many lines a patch would draw, so a caller can decide whether to draw it unasked. */
export function hunkLineCount(hunks: PatchHunk[]) {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
}

/** What the `@@` row says, rebuilt for the reader: where this hunk sits in the file. */
export function hunkLabel(hunk: PatchHunk) {
  const position = `@@ -${hunk.oldStart} +${hunk.newStart} @@`
  return hunk.heading ? `${position} ${hunk.heading}` : position
}
