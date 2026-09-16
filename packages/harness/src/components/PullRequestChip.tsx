import { Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { BranchState } from "../types"

type PullRequestChipProps = {
  state: BranchState | undefined
  creating: boolean
  /** The title to open the pull request with — the branch's last commit subject, usually. */
  suggestedTitle: string
  onOpenPullRequest: (title: string) => void
  onOpen: (url: string) => void
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
export const PullRequestChip: Component<PullRequestChipProps> = (props) => {
  const [asking, setAsking] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const pr = () => props.state?.pullRequest
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
      <div class="fc-pr-chip" classList={{ "fc-pr-chip-merged": pr()?.state === "merged" }}>
        <Show
          when={pr()}
          fallback={
            <>
              <span class="fc-pr-branch">{props.state?.branch}</span>
              <span class="fc-pr-repo">{props.state?.repository}</span>
              <Show
                when={asking()}
                fallback={
                  <button class="fc-pr-action" type="button" disabled={props.creating} onClick={start}>
                    {/* Pushing is part of it when the branch has never been pushed, so it says so. */}
                    {props.creating
                      ? t("Opening…")
                      : props.state?.pushed
                        ? t("Create PR")
                        : t("Push and create PR")}
                  </button>
                }
              >
                <input
                  class="fc-input fc-pr-title"
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
            </>
          }
        >
          {(request) => (
            <>
              <button class="fc-pr-number" type="button" onClick={() => props.onOpen(request().url)}>
                #{request().number}
              </button>
              <span class="fc-pr-branch">{props.state?.branch}</span>
              <span class="fc-pr-counts">
                <span class="fc-diff-plus">+{request().additions.toLocaleString()}</span>
                <span class="fc-diff-minus">−{request().deletions.toLocaleString()}</span>
              </span>
              <Show when={request().draft}>
                <span class="fc-pr-state">{t("Draft")}</span>
              </Show>
              <Show
                when={request().state === "open"}
                fallback={
                  <span class="fc-pr-state" data-state={request().state}>
                    {request().state === "merged" ? t("Merged") : t("Closed")}
                  </span>
                }
              >
                <Show when={checkLabel()}>
                  {(label) => (
                    <span class="fc-pr-checks" data-verdict={verdict()}>
                      <span class="fc-pr-dot" aria-hidden="true" />
                      {label()}
                    </span>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
