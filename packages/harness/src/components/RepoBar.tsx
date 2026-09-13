import { Show, type Component } from "solid-js"
import { t } from "../i18n"

type RepoBarProps = {
  directory: string
  branch?: string
  additions: number
  deletions: number
  onCommit: () => void
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
        <Show when={hasChanges()}>
          <span class="fc-repo-add">+{props.additions.toLocaleString()}</span>
          <span class="fc-repo-del">-{props.deletions.toLocaleString()}</span>
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
