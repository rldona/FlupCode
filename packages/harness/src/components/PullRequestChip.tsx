import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { BranchState, CheckLog, FailedCheck } from "../types"

export type PullRequestProps = {
  state: BranchState | undefined
  creating: boolean
  /** The title to open the pull request with — the branch's last commit subject, usually. */
  suggestedTitle: string
  onOpenPullRequest: (title: string) => void
  onOpen: (url: string) => void
  /** What a failing check printed. Called when somebody asks for it, never on the poll. */
  onCheckLog: (job: string) => Promise<CheckLog>
}

/** What the checks add up to, in one word. Running wins over failed: it is not over yet. */
type Verdict = "running" | "failed" | "passed" | "none"

export function verdictOf(checks: { total: number; passed: number; failed: number; running: number }): Verdict {
  if (checks.running > 0) return "running"
  if (checks.failed > 0) return "failed"
  // Green only when something actually passed. Checks that all skipped have vouched for nothing,
  // and painting that the same as four green runs is a claim nobody made.
  return checks.passed > 0 ? "passed" : "none"
}

/**
 * Where the branch stands, above the composer (H-20).
 *
 * Three things a reader otherwise leaves the app to find out: whether this branch has a pull
 * request, what CI says about it, and whether it has been merged. The chip is only ever as certain
 * as `gh` is — when `gh` is missing or logged out the server answers `available: false` and nothing
 * is drawn at all, because a chip that cannot tell you the state is worse than no chip.
 */
/** One failing check, and its log once it has been asked for. */
const Failure: Component<{ check: FailedCheck; onLog: (job: string) => Promise<CheckLog>; onOpen: (url: string) => void }> = (
  props,
) => {
  const [log, setLog] = createSignal<CheckLog>()
  const [loading, setLoading] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const read = () => {
    const job = props.check.job
    if (!job || log() || loading()) return
    setLoading(true)
    setProblem(undefined)
    props
      .onLog(job)
      .then(setLog)
      .catch((cause) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false))
  }
  return (
    <div class="fc-pr-failure">
      <div class="fc-pr-failure-head">
        <span class="fc-pr-failure-name">{props.check.name}</span>
        <Show when={props.check.workflow}>
          <span class="fc-pr-failure-workflow">{props.check.workflow}</span>
        </Show>
        {/* A status context has no Actions job, so there is no log here to offer for it. */}
        <Show when={props.check.job && !log()}>
          <button class="fc-pr-action" type="button" disabled={loading()} onClick={read}>
            {loading() ? t("Reading…") : t("Why")}
          </button>
        </Show>
        <Show when={props.check.url}>
          <button class="fc-pr-action" type="button" onClick={() => props.onOpen(props.check.url)}>
            {t("On GitHub")}
          </button>
        </Show>
      </div>
      <Show when={problem()}>{(message) => <p class="fc-pr-failure-problem">{message()}</p>}</Show>
      <Show when={log()}>
        {(read) => (
          <>
            <Show when={read().step}>
              {(step) => <div class="fc-pr-failure-step">{step()}</div>}
            </Show>
            <pre class="fc-pr-log">{read().text}</pre>
            <Show when={read().truncated}>
              <p class="fc-pr-failure-problem">{t("Only the end of the log is shown.")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

/**
 * The pull request's part of the branch bar (H-20), drawn inline.
 *
 * Inline rather than in a box of its own: a branch and its pull request are one fact about where you
 * are, and splitting them into two bubbles above the composer made the reader's eye do the joining.
 * What does get its own bubble is the failures panel below — that one is a different thing, opened
 * on purpose, and long.
 */
export const PullRequestInline: Component<
  PullRequestProps & { expanded: boolean; onExpand: () => void; showCounts: boolean }
> = (props) => {
  const [asking, setAsking] = createSignal(false)
  const [title, setTitle] = createSignal("")
  /**
   * Only an open one belongs on the bar.
   *
   * A merged or closed pull request has its own row underneath, and leaving its number here too
   * printed `#121` twice on two lines about the same thing. The bar goes back to offering the next
   * pull request, which is what the branch is now good for.
   */
  const pr = () => {
    const pull = props.state?.pullRequest
    return pull?.state === "open" ? pull : undefined
  }
  const verdict = createMemo<Verdict>(() => {
    const checks = pr()?.checks
    return checks ? verdictOf(checks) : "none"
  })
  const checkLabel = () => {
    const checks = pr()?.checks
    if (!checks || checks.total === 0) return undefined
    if (checks.running > 0) return t("CI {done}/{total}", { done: checks.total - checks.running, total: checks.total })
    return checks.failed > 0 ? t("{n} failed", { n: checks.failed }) : t("CI")
  }

  const start = () => {
    setTitle(props.suggestedTitle)
    setAsking(true)
  }
  const create = () => {
    const value = title().trim()
    if (!value) return
    props.onOpenPullRequest(value)
    setAsking(false)
  }

  return (
    <Show when={props.state?.available && props.state.repository}>
      <span class="fc-pr-chip" classList={{ "fc-pr-chip-merged": pr()?.state === "merged" }}>
        <Show
          when={pr()}
          fallback={
            <Show
              when={asking()}
              fallback={
                <button class="fc-pr-action" type="button" disabled={props.creating} onClick={start}>
                  {/* Pushing is part of it when the branch has never been pushed, so it says so. */}
                  {props.creating ? t("Opening…") : props.state?.pushed ? t("Create PR") : t("Push and create PR")}
                </button>
              }
            >
              <input
                class="fc-pr-title"
                value={title()}
                aria-label={t("Pull request title")}
                onInput={(event) => setTitle(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setAsking(false)
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  create()
                }}
              />
              <button class="fc-pr-action" type="button" disabled={!title().trim()} onClick={create}>
                {t("Open")}
              </button>
              <button class="fc-pr-action" type="button" onClick={() => setAsking(false)}>
                {t("Cancel")}
              </button>
            </Show>
          }
        >
          {(request) => (
            <>
              <button
                class="fc-pr-number"
                type="button"
                title={t("{additions} added, {deletions} removed on this branch", {
                  additions: request().additions.toLocaleString(),
                  deletions: request().deletions.toLocaleString(),
                })}
                onClick={() => props.onOpen(request().url)}
              >
                #{request().number}
              </button>
              {/*
                One pair of counts on the bar at a time. The working tree's win while there is
                anything uncommitted, because those are the ones changing as you watch; the pull
                request's are shown once there is nothing else to confuse them with, and are on the
                number's tooltip either way.
              */}
              <Show when={props.showCounts}>
                <span class="fc-pr-counts">
                  <span class="fc-diff-plus">+{request().additions.toLocaleString()}</span>
                  <span class="fc-diff-minus">−{request().deletions.toLocaleString()}</span>
                </span>
              </Show>
              <Show when={request().draft}>
                <span class="fc-pr-state">{t("Draft")}</span>
              </Show>
              <Show when={request().state === "open"}>
                <Show when={checkLabel()}>
                  {(label) => (
                    <Show
                      when={request().failures.length > 0}
                      fallback={
                        <span class="fc-pr-checks" data-verdict={verdict()}>
                          <span class="fc-pr-dot" aria-hidden="true" />
                          {label()}
                        </span>
                      }
                    >
                      {/* "2 failed" is where a reader gives up and opens a browser. Not any more. */}
                      <button
                        class="fc-pr-checks fc-pr-checks-open"
                        type="button"
                        data-verdict={verdict()}
                        aria-expanded={props.expanded}
                        onClick={() => props.onExpand()}
                      >
                        <span class="fc-pr-dot" aria-hidden="true" />
                        {label()}
                        <span aria-hidden="true">{props.expanded ? "▴" : "▾"}</span>
                      </button>
                    </Show>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
      </span>
    </Show>
  )
}

/** The failing checks, in a bubble of their own under the bar: opened on purpose, and long. */
export const PullRequestFailures: Component<{
  failures: FailedCheck[]
  onLog: (job: string) => Promise<CheckLog>
  onOpen: (url: string) => void
}> = (props) => (
  <div class="fc-pr-failures">
    <For each={props.failures}>{(check) => <Failure check={check} onLog={props.onLog} onOpen={props.onOpen} />}</For>
  </div>
)

/**
 * A pull request that is over, in a bubble of its own (H-20).
 *
 * Merged and closed are not part of "where you are" — the bar behind this one still offers to open
 * the next pull request, and it should. This is a notice about something finished, so it is drawn
 * as one: its own row, the state's colour, and an × because a notice you cannot dismiss is a
 * notice that becomes furniture.
 */
export const PullRequestDone: Component<{
  number: number
  url: string
  state: "merged" | "closed"
  repository?: string
  branch?: string
  onOpen: (url: string) => void
  onDismiss: () => void
}> = (props) => (
  <div class="fc-pr-done" data-state={props.state}>
    <span class="fc-pr-done-icon" aria-hidden="true">
      ⑂
    </span>
    <button class="fc-pr-number" type="button" onClick={() => props.onOpen(props.url)}>
      #{props.number}
    </button>
    <Show when={props.repository}>
      {(repository) => <span class="fc-pr-done-repo">{repository().split("/").at(-1)}</span>}
    </Show>
    <Show when={props.branch}>{(branch) => <span class="fc-pr-done-branch">{branch()}</span>}</Show>
    <span class="fc-pr-done-state">{props.state === "merged" ? t("Merged") : t("Closed")}</span>
    <button
      class="fc-repo-clear fc-pr-done-close"
      type="button"
      aria-label={t("Hide this")}
      title={t("Hide until there is something new to say")}
      onClick={() => props.onDismiss()}
    >
      ×
    </button>
  </div>
)
