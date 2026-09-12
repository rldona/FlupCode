import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { ProviderAuthMethod, ProviderDirectoryInfo } from "../engine-types"
import { t } from "../i18n"

type ProvidersPanelProps = {
  open: boolean
  providers: ProviderDirectoryInfo[]
  auth: Record<string, ProviderAuthMethod[]>
  connected: string[]
  busy: boolean
  onSave: (providerID: string, key: string) => void
  onRemove: (providerID: string) => void
  onClose: () => void
}

export const ProvidersPanel: Component<ProvidersPanelProps> = (props) => {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [query, setQuery] = createSignal("")

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }))

  const list = createMemo(() => {
    const value = query().trim().toLowerCase()
    const filtered = props.providers.filter((provider) => {
      if (!value) return true
      return `${provider.name} ${provider.id} ${provider.env.join(" ")}`.toLowerCase().includes(value)
    })
    return [...filtered].sort((a, b) => {
      const ca = props.connected.includes(a.id) ? 0 : 1
      const cb = props.connected.includes(b.id) ? 0 : 1
      if (ca !== cb) return ca - cb
      return a.name.localeCompare(b.name)
    })
  })

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div class="fc-modal fc-modal-xl" role="dialog" aria-modal="true" aria-label={t("Providers & API keys")} onClick={(event) => event.stopPropagation()}>
          <div class="fc-modal-header">
            <span>{t("Providers & API keys")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <p class="fc-modal-line">{t("Add an API key for a provider. It is stored by the OpenCode server.")}</p>
          <input
            class="fc-filter-input"
            placeholder={t("Search providers")}
            aria-label={t("Search providers")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show
            when={list().length > 0}
            fallback={
              <div class="fc-empty-state">
                <span class="fc-empty-title">{t("No providers")}</span>
              </div>
            }
          >
            <ul class="fc-provider-list">
              <For each={list()}>
                {(provider) => {
                  const configured = () => props.connected.includes(provider.id)
                  const models = () => Object.keys(provider.models ?? {}).length
                  const methods = () => props.auth[provider.id] ?? []
                  const hasOauth = () => methods().some((method) => method.type === "oauth")
                  return (
                    <li class="fc-provider-row">
                      <div class="fc-provider-info">
                        <span class="fc-provider-name">{provider.name}</span>
                        <span class="fc-provider-id">
                          {provider.id}
                          <Show when={models() > 0}> · {t("{count} models", { count: models() })}</Show>
                        </span>
                      </div>
                      <span class="fc-chip" classList={{ "fc-chip-active": configured() }}>
                        {configured() ? t("Configured") : t("Not configured")}
                      </span>
                      <Show when={hasOauth()}>
                        <span class="fc-chip">{t("OAuth available")}</span>
                      </Show>
                      <input
                        class="fc-question-custom"
                        type="password"
                        placeholder={provider.env.length > 0 ? provider.env.join(" / ") : t("API key")}
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
                      <Show when={configured()}>
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
                  )
                }}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  )
}
