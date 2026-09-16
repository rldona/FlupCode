import { Show, type Component } from "solid-js"
import { t } from "../i18n"

type RepoBarProps = {
  directory: string
  branch?: string
  additions: number
  deletions: number
  onCommit: () => void
  /** Opens the diff viewer. Absent where there is no screen to open, as on the mobile layout. */
  onOpenChanges?: () => void
  /** Clears the folder picked for a new session. */
  onClear?: () => void
}

export const RepoBar: Component<RepoBarProps> = (props) => {
  const name = () => props.directory.split("/").filter(Boolean).at(-1) ?? props.directory
  const hasChanges = () => props.additions > 0 || props.deletions > 0
  return (
    <div class="fc-repo-bar">
      <div class="fc-repo-left">
        <span class="fc-repo-name">{name()}</span>
        <Show when={props.branch}>
          <span class="fc-repo-branch">{props.branch}</span>
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
        <Show when={props.onClear}>
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
      </div>
    </div>
  )
}
