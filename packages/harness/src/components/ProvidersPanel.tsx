import { For, Show, createSignal, type Component } from "solid-js"
import type { ProviderInfo } from "../engine-types"
import { t } from "../i18n"

type ProvidersPanelProps = {
  open: boolean
  providers: ProviderInfo[]
  busy: boolean
  onSave: (providerID: string, key: string) => void
  onRemove: (providerID: string) => void
  onClose: () => void
}

const isConfigured = (provider: ProviderInfo) => {
  const body = provider.request?.body as Record<string, unknown> | undefined
  const key = body?.apiKey
  return typeof key === "string" && key.length > 0 && key !== "public"
}

export const ProvidersPanel: Component<ProvidersPanelProps> = (props) => {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }))

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>{t("Providers & API keys")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <p class="fc-modal-line">{t("Add an API key for a provider. It is stored by the OpenCode server.")}</p>
        <Show
          when={props.providers.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No providers")}</span>
            </div>
          }
        >
          <ul class="fc-provider-list">
            <For each={props.providers}>
              {(provider) => (
                <li class="fc-provider-row">
                  <div class="fc-provider-info">
                    <span class="fc-provider-name">{provider.name}</span>
                    <span class="fc-provider-id">{provider.id}</span>
                  </div>
                  <span class="fc-chip" classList={{ "fc-chip-active": isConfigured(provider) }}>
                    {isConfigured(provider) ? t("Configured") : t("Not configured")}
                  </span>
                  <input
                    class="fc-question-custom"
                    type="password"
                    placeholder={t("API key")}
                    value={drafts()[provider.id] ?? ""}
                    onInput={(event) => setDraft(provider.id, event.currentTarget.value)}
                  />
                  <button
                    class="fc-button fc-button-primary"
                    type="button"
                    disabled={props.busy || !(drafts()[provider.id] ?? "").trim()}
                    onClick={() => {
                      props.onSave(provider.id, (drafts()[provider.id] ?? "").trim())
                      setDraft(provider.id, "")
                    }}
                  >
                    {t("Save")}
                  </button>
                  <Show when={isConfigured(provider)}>
                    <button
                      class="fc-button fc-button-danger"
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onRemove(provider.id)}
                    >
                      {t("Remove")}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
    </Show>
  )
}
