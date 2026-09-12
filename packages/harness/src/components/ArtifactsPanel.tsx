import { For, Show, type Component } from "solid-js"
import { t } from "../i18n"

type ArtifactsPanelProps = {
  open: boolean
  artifacts: string[]
  onCopy: (path: string) => void
  onClose: () => void
}

export const ArtifactsPanel: Component<ArtifactsPanelProps> = (props) => {
  if (!props.open) return null

  return (
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>{t("Artifacts")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <Show
          when={props.artifacts.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No artifacts yet")}</span>
              <span class="fc-empty-hint">{t("Files changed by the session appear here")}</span>
            </div>
          }
        >
          <ul class="fc-artifact-list">
            <For each={props.artifacts}>
              {(path) => (
                <li class="fc-artifact-row">
                  <span class="fc-artifact-path">{path}</span>
                  <button class="fc-button" type="button" onClick={() => props.onCopy(path)}>
                    {t("Copy")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}
