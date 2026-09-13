import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { ModelInfo } from "../engine-types"
import { t } from "../i18n"

type ModelPickerProps = {
  open: boolean
  models: ModelInfo[]
  loading?: boolean
  selectedKey: string | undefined
  favorites: string[]
  onRetry?: () => void
  onSelect: (providerID: string, id: string) => void
  onToggleFavorite: (key: string) => void
  onClose: () => void
}

export const ModelPicker: Component<ModelPickerProps> = (props) => {
  const [query, setQuery] = createSignal("")
  const key = (model: ModelInfo) => `${model.providerID}/${model.id}`
  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const filtered = needle
      ? props.models.filter((model) => `${model.name} ${model.id} ${model.providerID}`.toLowerCase().includes(needle))
      : props.models
    const map = new Map<string, ModelInfo[]>()
    for (const model of filtered) {
      map.set(model.providerID, [...(map.get(model.providerID) ?? []), model])
    }
    return [...map.entries()].map(([providerID, items]) => ({
      providerID,
      items: [...items].sort((a, b) => {
        const aFav = props.favorites.includes(key(a)) ? 0 : 1
        const bFav = props.favorites.includes(key(b)) ? 0 : 1
        if (aFav !== bFav) return aFav - bFav
        return a.name.localeCompare(b.name)
      }),
    }))
  })
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div class="fc-modal fc-modal-xl" role="dialog" aria-modal="true" aria-label={t("Choose a model")} onClick={(event) => event.stopPropagation()}>
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
          <div class="fc-model-picker">
            <Show when={!props.loading || groups().length > 0} fallback={<div class="fc-palette-empty">{t("Loading models…")}</div>}>
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
                            <button class="fc-model-main" type="button" onClick={() => props.onSelect(model.providerID, model.id)}>
                              <span class="fc-model-name">{model.name}</span>
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
