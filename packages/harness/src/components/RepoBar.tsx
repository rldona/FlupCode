import { Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { PullRequestDone, PullRequestFailures, PullRequestInline, type PullRequestProps } from "./PullRequestChip"

type RepoBarProps = {
  directory: string
  branch?: string
  additions: number
  deletions: number
  onCommit: () => void
  /** Opens the diff viewer. Absent where there is no screen to open, as on the mobile layout. */
  onOpenChanges?: () => void
  /** Closes the open session and goes back to its home. */
  onClose?: () => void
  /** Clears the folder picked for a new session. Only while picking one. */
  onClear?: () => void
  /** Where the branch stands on GitHub. Absent when `gh` cannot say. */
  pullRequest?: PullRequestProps
}

/**
 * Where you are, in one bar above the composer.
 *
 * The folder, the branch, what has changed and what GitHub says about it are **one** fact, and they
 * used to be drawn as two stacked bubbles — the pull request in its own box above the repository's.
 * Two boxes for one fact makes the reader join them up themselves, and it stole a line of the
 * screen. They are one row now.
 *
 * The failing checks still get a bubble of their own, below: that one is a different thing, opened
 * on purpose, and long enough to deserve the room.
 */
export const RepoBar: Component<RepoBarProps> = (props) => {
  const [showing, setShowing] = createSignal(false)
  const [hidden, setHidden] = createSignal<string>()
  /** A finished pull request is dismissed on its own: the bar behind it is still about the branch. */
  const [hiddenDone, setHiddenDone] = createSignal<number>()

  const name = () => props.directory.split("/").filter(Boolean).at(-1) ?? props.directory
  /**
   * The branch, from whichever source also answered about the pull request.
   *
   * Two things report it — the engine's `/vcs` and the harness server's own `git` — and on one row
   * they have to agree. The harness's wins because it is the one the button acts on: the branch
   * shown is the branch that would be pushed.
   */
  const branch = () => props.pullRequest?.state?.branch ?? props.branch
  const hasChanges = () => props.additions > 0 || props.deletions > 0
  const request = () => props.pullRequest?.state?.pullRequest
  /** The repository slug, when it is not just this folder's name again. */
  const elsewhere = createMemo(() => {
    const repository = props.pullRequest?.state?.repository
    if (!repository) return undefined
    return repository.split("/").at(-1) === name() ? undefined : repository
  })

  /**
   * What the bar is about right now.
   *
   * Dismissing hides *this* — this folder, this branch, this pull request in this state. Anything
   * new to say brings the bar back, which is the difference between closing something and turning
   * it off.
   */
  const subject = createMemo(
    () => `${props.directory}\n${branch() ?? ""}\n${request()?.number ?? ""}\n${request()?.state ?? ""}`,
  )
  const dismissed = createMemo(() => hidden() === subject())
  /** Merged or closed, and not already waved away. Narrowed here so nobody has to assert it later. */
  const finished = createMemo(() => {
    const pull = request()
    if (!pull || hiddenDone() === pull.number) return undefined
    const state = pull.state
    return state === "open" ? undefined : { ...pull, state }
  })

  return (
    <Show when={!dismissed()}>
      <div class="fc-branch">
        <div class="fc-repo-bar">
          <div class="fc-repo-left">
            <span class="fc-repo-name">{name()}</span>
            <Show when={branch()}>
              <span class="fc-repo-branch">{branch()}</span>
            </Show>
            {/*
              The repository this would open a pull request in, and only when it is not simply the
              folder's name. Usually they are the same word and printing it twice says nothing; when
              they differ — a fork, a folder renamed on disk — it is the thing worth knowing before
              pressing the button.
            */}
            <Show when={elsewhere()}>
              {(repository) => <span class="fc-pr-repo">{repository()}</span>}
            </Show>
          </div>
          <div class="fc-repo-right">
            {/*
              The counts are the way in to the diff. Two numbers with no affordance is where a reader
              stops: the question they raise — "changed how?" — had no answer on this bar until now.
            */}
            <Show when={hasChanges()}>
              <Show
                when={props.onOpenChanges}
                fallback={
                  <span class="fc-repo-counts">
                    <span class="fc-repo-add">+{props.additions.toLocaleString()}</span>
                    <span class="fc-repo-del">-{props.deletions.toLocaleString()}</span>
                  </span>
                }
              >
                <button
                  class="fc-repo-counts fc-repo-counts-open"
                  type="button"
                  title={t("See what changed")}
                  onClick={() => props.onOpenChanges?.()}
                >
                  <span class="fc-repo-add">+{props.additions.toLocaleString()}</span>
                  <span class="fc-repo-del">-{props.deletions.toLocaleString()}</span>
                </button>
              </Show>
            </Show>
            <Show when={hasChanges()}>
              <button class="fc-repo-commit" type="button" onClick={props.onCommit}>
                {t("Commit changes")}
              </button>
            </Show>
            <Show when={props.pullRequest}>
              {(pr) => (
                <PullRequestInline
                  {...pr()}
                  expanded={showing()}
                  onExpand={() => setShowing((open) => !open)}
                  showCounts={!hasChanges()}
                />
              )}
            </Show>
          {/*
              One glyph, and it leaves whichever thing the bar is standing in for: the open session
              (back to its home), the folder picked for one that has not started, or — with neither —
              the bar itself.
          */}
          <Show
            when={props.onClose}
            fallback={
              <Show
                when={props.onClear}
                fallback={
                  <button
                    class="fc-repo-clear"
                    type="button"
                    aria-label={t("Hide this")}
                    title={t("Hide until there is something new to say")}
                    onClick={() => setHidden(subject())}
                  >
                    ×
                  </button>
                }
              >
                <button
                  class="fc-repo-clear"
                  type="button"
                  aria-label={t("Remove folder")}
                  title={t("Remove folder")}
                  onClick={() => props.onClear?.()}
                >
                  ×
                </button>
              </Show>
            }
          >
            <button
              class="fc-repo-clear"
              type="button"
              aria-label={t("Close session")}
              title={t("Close session")}
              onClick={() => props.onClose?.()}
            >
              ×
            </button>
          </Show>
          </div>
        </div>
        {/*
          A pull request that is over gets a row of its own, under the bar. It is a different fact
          from "where you are" — the bar is still offering to open the next one — and it is the one
          that is worth colouring.
        */}
        <Show when={finished()}>
          {(done) => (
            <PullRequestDone
              number={done().number}
              url={done().url}
              state={done().state}
              repository={props.pullRequest?.state?.repository}
              branch={branch()}
              onOpen={(url) => props.pullRequest?.onOpen(url)}
              onDismiss={() => setHiddenDone(done().number)}
            />
          )}
        </Show>
        <Show when={showing() && (request()?.failures.length ?? 0) > 0 && props.pullRequest}>
          {(pr) => (
            <PullRequestFailures
              failures={request()?.failures ?? []}
              onLog={pr().onCheckLog}
              onOpen={pr().onOpen}
            />
          )}
        </Show>
      </div>
    </Show>
  )
}
