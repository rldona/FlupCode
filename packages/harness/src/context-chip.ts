import type { Attachment } from "./types"

/**
 * Something the reader pointed at, held in the composer as a removable chip until the message goes
 * (BU-06; the model UX-05 extends to files, artifacts, diff hunks and terminal selections).
 *
 * A chip is a part of the draft, not text in it: it has a type, says where it came from, and resolves
 * only on send, into a quoted block of the message and the files it carries. The first type is a
 * preview annotation: the page's address, the marked-up picture (also kept as an artifact) and the
 * reader's note.
 */
export type ContextChip = {
  id: string
  type: "preview"
  /** What the chip shows. */
  label: string
  /** Where it came from: the page's address. */
  source: string
  /** The artifact the picture was kept as. */
  artifactID?: string
  /** The marked-up picture, as a PNG data URL. */
  image?: string
  note?: string
}

/** What the chips add to the message: a block of text after the reader's, and their files. */
export function resolveChips(chips: ContextChip[]): { text: string; files: Attachment[] } {
  return {
    text: chips.map(blockOf).join("\n\n"),
    files: chips.flatMap((chip) =>
      chip.image ? [{ uri: chip.image, name: `preview-${chip.artifactID ?? chip.id}.png` }] : [],
    ),
  }
}

/** The reader's text with the chips' blocks after it. */
export function withChips(text: string, chips: ContextChip[]) {
  const block = resolveChips(chips).text
  if (!block) return text
  return text ? `${text}\n\n${block}` : block
}

function blockOf(chip: ContextChip) {
  return [
    `[Preview annotation of ${chip.source}${chip.artifactID ? `, artifact ${chip.artifactID}` : ""}]`,
    ...(chip.note?.trim() ? [`> ${chip.note.trim().replace(/\n/g, "\n> ")}`] : []),
    "The attached image is the page as FlupCode's preview showed it, with the marked areas numbered.",
  ].join("\n")
}
