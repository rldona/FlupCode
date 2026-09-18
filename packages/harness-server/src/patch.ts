/**
 * Unified diffs, split and put back together (H-20).
 *
 * The diff viewer already read hunks; what it could not do was send one back. Staging a single hunk
 * means handing git a patch that contains that hunk and not the others, which means taking a patch
 * apart and rebuilding it exactly — byte for byte, or git refuses to apply it.
 */

export type SplitPatch = { header: string; hunks: string[] }

/** The lines before the first `@@`, and the hunks after it. */
export function splitPatch(patch: string): SplitPatch {
  const text = patch.replace(/\r\n/g, "\n")
  const starts = [...text.matchAll(/^@@ /gm)].map((match) => match.index!)
  if (starts.length === 0) return { header: text.replace(/\s+$/, ""), hunks: [] }
  return {
    header: text.slice(0, starts[0]).replace(/\s+$/, ""),
    hunks: starts.map((start, index) =>
      text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length).replace(/\s+$/, ""),
    ),
  }
}

/**
 * The same patch with only the named hunks, in order.
 *
 * Throws rather than returning something git cannot use: a caller that asked to stage hunk 3 of a
 * patch with one hunk has a bug, and a silently empty patch would read as "nothing to do".
 */
export function selectHunks(patch: string, keep: number[]): string {
  const { header, hunks } = splitPatch(patch)
  const chosen = [...new Set(keep)]
    .sort((left, right) => left - right)
    .map((index) => hunks[index])
  if (chosen.length === 0 || chosen.some((hunk) => hunk === undefined)) {
    throw new Error("That hunk is not in this patch")
  }
  return `${[header, ...chosen].filter(Boolean).join("\n")}\n`
}

export function hunkCount(patch: string) {
  return splitPatch(patch).hunks.length
}
