import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import type { ModelInfo } from "../engine-types"
import { t } from "../i18n"
import { groupedModels, isDeprecated, modelKey } from "../model-catalog"

type ModelPickerProps = {
  open: boolean
  models: ModelInfo[]
  loading?: boolean
  selectedKey: string | undefined
  favorites: string[]
  onRetry?: () => void
  /** When set, a row above the catalog leaves the choice unset — "the default" — instead of picking one. */
  emptyLabel?: string
  onClear?: () => void
  onSelect: (providerID: string, id: string) => void
  onToggleFavorite: (key: string) => void
  onClose: () => void
}

export const ModelPicker: Component<ModelPickerProps> = (props) => {
  const [query, setQuery] = createSignal("")
  // Each opening starts with an empty search.
  createEffect(() => {
    if (!props.open) setQuery("")
  })
  const key = (model: ModelInfo) => modelKey(model)
  const groups = createMemo(() => groupedModels(props.models, query(), props.favorites))
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-xl"
          role="dialog"
          aria-modal="true"
          aria-label={t("Choose a model")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Choose a model")}</span>
            <button class="fc-icon-button" type="button" onClick={props.onClose} aria-label={t("Close")}>
              ×
            </button>
          </div>
          <input
            class="fc-filter-input"
            value={query()}
            placeholder={t("Search models")}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show when={props.onClear}>
            <button
              class="fc-model-clear"
              classList={{ "fc-model-clear-on": !props.selectedKey }}
              type="button"
              onClick={props.onClear}
            >
              <span class="fc-model-name">{props.emptyLabel}</span>
              <Show when={!props.selectedKey}>
                <span class="fc-model-clear-check" aria-hidden="true">
                  ✓
                </span>
              </Show>
            </button>
          </Show>
          <div class="fc-model-picker">
            <Show
              when={!props.loading || groups().length > 0}
              fallback={<div class="fc-palette-empty">{t("Loading models…")}</div>}
            >
              <Show
                when={groups().length > 0}
                fallback={
                  <div class="fc-palette-empty">
                    <span>{t("No models")}</span>
                    <Show when={props.onRetry}>
                      <button class="fc-button" type="button" onClick={props.onRetry}>
                        {t("Retry")}
                      </button>
                    </Show>
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <div class="fc-model-group">
                      <div class="fc-model-group-label">{group.providerID}</div>
                      <ul>
                        <For each={group.items}>
                          {(model) => {
                            const selected = () => props.selectedKey === key(model)
                            return (
                              <li class="fc-model-row" classList={{ "fc-model-row-active": selected() }}>
                                <button
                                  class="fc-model-main"
                                  type="button"
                                  onClick={() => props.onSelect(model.providerID, model.id)}
                                >
                                  <span class="fc-model-title">
                                    <span class="fc-model-name">{model.name}</span>
                                    <Show when={isDeprecated(model)}>
                                      <span class="fc-model-badge">{t("Deprecated")}</span>
                                    </Show>
                                  </span>
                                  <span class="fc-model-id">{model.id}</span>
                                </button>
                                <button
                                  class="fc-model-star"
                                  classList={{ "fc-model-star-on": props.favorites.includes(key(model)) }}
                                  type="button"
                                  aria-label={t("Favorite")}
                                  onClick={() => props.onToggleFavorite(key(model))}
                                >
                                  {props.favorites.includes(key(model)) ? "★" : "☆"}
                                </button>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
