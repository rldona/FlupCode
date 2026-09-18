import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { highlight, languageFor } from "../highlight"
import { hunkLabel, hunkLineCount, parseHunks, type PatchHunk } from "../patch"
import type { Finding } from "../types"

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

/**
 * A review's point, sitting on the line it is about (H-32).
 *
 * Under the line rather than beside it: the code keeps its full width, and a finding with three
 * sentences of detail does not have to fit in a margin.
 */
const Comment: Component<{ finding: Finding; onResolve: (id: string, resolved: boolean) => void }> = (props) => (
  <div
    class="fc-diff-finding"
    data-severity={props.finding.severity}
    data-source={props.finding.source ?? "review"}
    classList={{ "fc-diff-finding-done": !!props.finding.resolved }}
  >
    <div class="fc-diff-finding-head">
      {/*
        Who said it. A model's review is an opinion and can be wrong; a check that exited non-zero
        is a fact. Drawing them identically would make the reader weigh them the same.
      */}
      <span class="fc-diff-finding-severity">
        {props.finding.source === "check" ? t("check") : t(props.finding.severity)}
      </span>
      <span class="fc-diff-finding-title">{props.finding.title}</span>
      <button
        class="fc-pr-action"
        type="button"
        onClick={() => props.onResolve(props.finding.id, !props.finding.resolved)}
      >
        {props.finding.resolved ? t("Reopen") : t("Done")}
      </button>
    </div>
    <Show when={props.finding.detail}>{(detail) => <p class="fc-diff-finding-detail">{detail()}</p>}</Show>
  </div>
)

const Hunk: Component<{
  hunk: PatchHunk
  lang: string
  /** Findings for this file, by the line they are anchored to. */
  comments: Map<number, Finding[]>
  onResolve: (id: string, resolved: boolean) => void
  /** Whether this hunk can go into the next commit, and whether it is going in. */
  pick?: { selected: boolean; onToggle: (selected: boolean) => void }
  /** Throws this hunk away. Absent where discarding is unavailable. */
  onDiscard?: () => void
}> = (props) => (
  <>
    <div class="fc-diff-hunk-head">
      <Show when={props.pick}>
        {(pick) => (
          <label class="fc-diff-hunk-pick">
            <input
              type="checkbox"
              checked={pick().selected}
              aria-label={t("Include this hunk")}
              onChange={(event) => pick().onToggle(event.currentTarget.checked)}
            />
          </label>
        )}
      </Show>
      <span class="fc-diff-hunk-label">{hunkLabel(props.hunk)}</span>
      <Show when={props.onDiscard}>
        <button class="fc-pr-action fc-diff-discard" type="button" onClick={() => props.onDiscard?.()}>
          {t("Discard")}
        </button>
      </Show>
    </div>
    <For each={props.hunk.lines}>
      {(line) => (
        <>
          <div class={`fc-diff-line fc-diff-line-${line.type}`}>
            <span class="fc-diff-no">{line.oldNo ?? ""}</span>
            <span class="fc-diff-no">{line.newNo ?? ""}</span>
            <span class="fc-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
            <span class="fc-diff-code" innerHTML={highlight(line.text, props.lang)} />
          </div>
          {/*
            Anchored to the new file's number: a review is about the code as it now stands, and a
            deleted line is not there to comment on.
          */}
          <For each={(line.newNo !== undefined && props.comments.get(line.newNo)) || []}>
            {(finding) => <Comment finding={finding} onResolve={props.onResolve} />}
          </For>
        </>
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
  /** Whether this file is going into the next commit. Absent where nothing is being committed. */
  selected?: boolean
  onSelect?: (selected: boolean) => void
  /** Which of its hunks go into the next commit, when only some of them do (H-20). */
  selectedHunks?: number[]
  onHunk?: (index: number, selected: boolean) => void
  /** Throws a hunk away, or the whole file. Absent where discarding is unavailable. */
  onDiscardHunk?: (index: number) => void
  onDiscardFile?: () => void
  discarding?: boolean
  /** A review's points about this file (H-32). */
  findings?: Finding[]
  onResolveFinding?: (id: string, resolved: boolean) => void
}> = (props) => {
  const [open, setOpen] = createSignal(props.open ?? false)
  const [forced, setForced] = createSignal(false)
  const hunks = createMemo(() => parseHunks(props.change.patch))
  const lines = createMemo(() => hunkLineCount(hunks()))
  const folded = () => lines() > FOLD_ABOVE && !forced()
  const status = () => STATUS_LABEL[props.change.status ?? "modified"] ?? "modified"
  const byLine = createMemo(() => {
    const map = new Map<number, Finding[]>()
    for (const finding of props.findings ?? []) {
      if (finding.line === undefined) continue
      map.set(finding.line, [...(map.get(finding.line) ?? []), finding])
    }
    return map
  })
  // A finding about the file rather than a line still has to appear, or a review loses points.
  const aboutTheFile = createMemo(() => (props.findings ?? []).filter((finding) => finding.line === undefined))
  const resolve = (id: string, resolved: boolean) => props.onResolveFinding?.(id, resolved)
  const stillOpen = () => (props.findings ?? []).filter((finding) => !finding.resolved).length
  return (
    <article class="fc-diff-file" classList={{ "fc-diff-file-open": open() }}>
      {/*
        The checkbox is a sibling of the header, not inside it. A button may not contain another
        control — and a reader who means to tick a file should not have its diff unfold at them.
      */}
      <div class="fc-diff-file-bar">
        <Show when={props.onSelect}>
          <label class="fc-diff-pick">
            <input
              type="checkbox"
              checked={props.selected ?? false}
              aria-label={t("Include {file}", { file: props.change.file })}
              onChange={(event) => props.onSelect?.(event.currentTarget.checked)}
            />
          </label>
        </Show>
        <button class="fc-diff-file-head" type="button" aria-expanded={open()} onClick={() => setOpen((it) => !it)}>
          <span class="fc-diff-chevron" aria-hidden="true">
            {open() ? "▾" : "▸"}
          </span>
          <span class="fc-diff-path" title={props.change.file}>
            <span class="fc-diff-dir">{folder(props.change.file)}</span>
            <span class="fc-diff-name">{basename(props.change.file)}</span>
          </span>
          <span class={`fc-diff-status fc-diff-status-${props.change.status ?? "modified"}`}>{t(status())}</span>
          {/* How many points are still open on this file, before it is even unfolded. */}
          <Show when={stillOpen() > 0}>
            <span class="fc-diff-finding-count">{stillOpen()}</span>
          </Show>
          <span class="fc-diff-counts">
            <span class="fc-diff-plus">+{props.change.additions}</span>
            <span class="fc-diff-minus">−{props.change.deletions}</span>
          </span>
        </button>
        <Show when={props.onDiscardFile}>
          <button
            class="fc-pr-action fc-diff-discard-file"
            type="button"
            disabled={props.discarding}
            onClick={() => props.onDiscardFile?.()}
          >
            {t("Discard")}
          </button>
        </Show>
      </div>
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
              <For each={aboutTheFile()}>
                {(finding) => <Comment finding={finding} onResolve={resolve} />}
              </For>
              <For each={hunks()}>
                {(hunk, index) => (
                  <Hunk
                    hunk={hunk}
                    lang={languageFor(props.change.file)}
                    comments={byLine()}
                    onResolve={resolve}
                    pick={
                      props.onHunk
                        ? {
                            selected: (props.selectedHunks ?? []).includes(index()),
                            onToggle: (value) => props.onHunk?.(index(), value),
                          }
                        : undefined
                    }
                    onDiscard={props.onDiscardHunk ? () => props.onDiscardHunk?.(index()) : undefined}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </article>
  )
}
