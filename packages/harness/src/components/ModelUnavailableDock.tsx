import { Show, type Component } from "solid-js"
import type { ModelInfo } from "../engine-types"
import { t } from "../i18n"

type ModelUnavailableDockProps = {
  /** The model the session is pinned to, which the engine no longer serves. */
  model: { providerID: string; id: string }
  /** Closest live model in the same provider, when the catalog offers one. */
  replacement?: ModelInfo
  /** A turn is running: switching now would break it, same as the model docks. */
  disabled?: boolean
  onUse: (model: ModelInfo) => void
  onChoose: () => void
}

/**
 * A session is pinned to the model the engine reuses on its next turn. When the catalog drops that
 * model the turn would fail, so say which one is gone and how to carry on.
 */
export const ModelUnavailableDock: Component<ModelUnavailableDockProps> = (props) => (
  <div class="fc-dock fc-dock-warning" role="status">
    <div class="fc-dock-header">
      <span class="fc-dock-title">{t("Model not available")}</span>
      <span class="fc-chip">{`${props.model.providerID}/${props.model.id}`}</span>
    </div>
    <p class="fc-status-line">
      {t("This session is pinned to a model the catalog no longer serves. Pick another one to carry on.")}
    </p>
    <div class="fc-dock-actions">
      <Show when={props.replacement}>
        {(replacement) => (
          <button
            class="fc-button fc-button-primary"
            type="button"
            disabled={props.disabled}
            onClick={() => props.onUse(replacement())}
          >
            {t("Use {model}", { model: replacement().name })}
          </button>
        )}
      </Show>
      <button class="fc-button" type="button" disabled={props.disabled} onClick={props.onChoose}>
        {t("Choose a model")}
      </button>
    </div>
  </div>
)
