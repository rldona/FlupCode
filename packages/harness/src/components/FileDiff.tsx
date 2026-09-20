import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { highlight, languageFor } from "../highlight"
import { hunkLabel, hunkLineCount, parseHunks, type PatchHunk } from "../patch"

export type FileChange = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

/** Past this, a file is folded until somebody asks for it: nobody reads 800 lines by accident. */
const FOLD_ABOVE = 300

/** The path either side of the last slash, so the folder can be the part that gets cut. */
const basename = (path: string) => path.split("/").at(-1) ?? path
const folder = (path: string) => path.slice(0, path.length - basename(path).length)

const STATUS_LABEL: Record<string, string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
}

const Hunk: Component<{ hunk: PatchHunk; lang: string }> = (props) => (
  <>
    <div class="fc-diff-hunk-head">{hunkLabel(props.hunk)}</div>
    <For each={props.hunk.lines}>
      {(line) => (
        <div class={`fc-diff-line fc-diff-line-${line.type}`}>
          <span class="fc-diff-no">{line.oldNo ?? ""}</span>
          <span class="fc-diff-no">{line.newNo ?? ""}</span>
          <span class="fc-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
          <span class="fc-diff-code" innerHTML={highlight(line.text, props.lang)} />
        </div>
      )}
    </For>
  </>
)

/**
 * One file's diff: a header that says what happened to it, and the hunks that say where.
 *
 * Both sides are numbered. A single column of numbers is enough while you only read the new file,
 * but the moment somebody wants to point at a line — which is the whole of H-32 — the number has to
 * be the one the file on disk has, and for a deletion that is the old file's.
 */
export const FileDiff: Component<{
  change: FileChange
  /** Whether it starts unfolded. A lone file opens; one of many stays shut until it is picked. */
  open?: boolean
}> = (props) => {
  const [open, setOpen] = createSignal(props.open ?? false)
  const [forced, setForced] = createSignal(false)
  const hunks = createMemo(() => parseHunks(props.change.patch))
  const lines = createMemo(() => hunkLineCount(hunks()))
  const folded = () => lines() > FOLD_ABOVE && !forced()
  const status = () => STATUS_LABEL[props.change.status ?? "modified"] ?? "modified"
  return (
    <article class="fc-diff-file" classList={{ "fc-diff-file-open": open() }}>
      <button class="fc-diff-file-head" type="button" aria-expanded={open()} onClick={() => setOpen((it) => !it)}>
        <span class="fc-diff-chevron" aria-hidden="true">
          {open() ? "▾" : "▸"}
        </span>
        <span class="fc-diff-path" title={props.change.file}>
          <span class="fc-diff-dir">{folder(props.change.file)}</span>
          <span class="fc-diff-name">{basename(props.change.file)}</span>
        </span>
        <span class={`fc-diff-status fc-diff-status-${props.change.status ?? "modified"}`}>{t(status())}</span>
        <span class="fc-diff-counts">
          <span class="fc-diff-plus">+{props.change.additions}</span>
          <span class="fc-diff-minus">−{props.change.deletions}</span>
        </span>
      </button>
      <Show when={open()}>
        <Show
          when={hunks().length > 0}
          fallback={<p class="fc-diff-empty">{t("No text diff for this file.")}</p>}
        >
          <Show
            when={!folded()}
            fallback={
              <button class="fc-diff-unfold" type="button" onClick={() => setForced(true)}>
                {t("Show {n} lines", { n: lines() })}
              </button>
            }
          >
            <div class="fc-diff-body">
              <For each={hunks()}>{(hunk) => <Hunk hunk={hunk} lang={languageFor(props.change.file)} />}</For>
            </div>
          </Show>
        </Show>
      </Show>
    </article>
  )
}
