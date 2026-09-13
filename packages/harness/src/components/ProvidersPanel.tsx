import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type {
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  IntegrationOAuthMethod,
  ProviderAuthMethod,
  ProviderDirectoryInfo,
} from "../engine-types"
import { t } from "../i18n"

type ProvidersPanelProps = {
  open: boolean
  providers: ProviderDirectoryInfo[]
  auth: Record<string, ProviderAuthMethod[]>
  connected: string[]
  integrations: IntegrationInfo[]
  busy: boolean
  onSave: (providerID: string, key: string) => void
  onRemove: (providerID: string) => void
  onOAuth: (providerID: string, methodID?: string) => Promise<IntegrationAttempt>
  onOAuthStatus: (attemptID: string) => Promise<IntegrationAttemptStatus>
  onOAuthCancel: (attemptID: string) => Promise<void>
  onOAuthDone: () => void
  onClose: () => void
}

export const ProvidersPanel: Component<ProvidersPanelProps> = (props) => {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [query, setQuery] = createSignal("")
  const [attempt, setAttempt] = createSignal<IntegrationAttempt | undefined>()
  const [attemptProvider, setAttemptProvider] = createSignal<string | undefined>()
  const [attemptState, setAttemptState] = createSignal<IntegrationAttemptStatus | undefined>()
  const [attemptError, setAttemptError] = createSignal<string | undefined>()

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }))

  const integrationFor = (providerID: string) =>
    props.integrations.find((integration) => integration.id === providerID)
  const oauthMethods = (providerID: string) =>
    (integrationFor(providerID)?.methods ?? []).filter(
      (method): method is IntegrationOAuthMethod => method.type === "oauth",
    )
  const isConnected = (providerID: string) =>
    props.connected.includes(providerID) || (integrationFor(providerID)?.connections.length ?? 0) > 0
  const connectedInV2 = (providerID: string) => (integrationFor(providerID)?.connections.length ?? 0) > 0

  const list = createMemo(() => {
    const value = query().trim().toLowerCase()
    const filtered = props.providers.filter((provider) => {
      if (!value) return true
      return `${provider.name} ${provider.id} ${provider.env.join(" ")}`.toLowerCase().includes(value)
    })
    return [...filtered].sort((a, b) => {
      const ca = isConnected(a.id) ? 0 : 1
      const cb = isConnected(b.id) ? 0 : 1
      if (ca !== cb) return ca - cb
      return a.name.localeCompare(b.name)
    })
  })

  const startOAuth = async (providerID: string, methodID: string) => {
    setAttemptError(undefined)
    setAttemptState(undefined)
    setAttemptProvider(providerID)
    try {
      const started = await props.onOAuth(providerID, methodID)
      setAttempt(started)
      setAttemptState({ status: "pending", time: started.time })
    } catch (cause) {
      setAttemptProvider(undefined)
      setAttemptError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const closeOAuth = () => {
    const current = attempt()
    if (current) void props.onOAuthCancel(current.attemptID).catch(() => undefined)
    setAttempt(undefined)
    setAttemptProvider(undefined)
    setAttemptState(undefined)
    setAttemptError(undefined)
  }

  createEffect(() => {
    const current = attempt()
    if (!current) return
    const timer = setInterval(async () => {
      try {
        const status = await props.onOAuthStatus(current.attemptID)
        setAttemptState(status)
        if (status.status === "complete") {
          clearInterval(timer)
          props.onOAuthDone()
          setAttempt(undefined)
          setAttemptProvider(undefined)
        }
        if (status.status === "failed") {
          clearInterval(timer)
          setAttemptError(status.message)
        }
        if (status.status === "expired") {
          clearInterval(timer)
          setAttemptError(t("The sign-in request expired. Try again."))
        }
      } catch (cause) {
        clearInterval(timer)
        setAttemptError(cause instanceof Error ? cause.message : String(cause))
      }
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  const providerName = (providerID: string | undefined) =>
    props.providers.find((provider) => provider.id === providerID)?.name ?? providerID ?? ""

  return (
    <>
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
                  const configured = () => isConnected(provider.id)
                  const models = () => Object.keys(provider.models ?? {}).length
                  const methods = () => props.auth[provider.id] ?? []
                  const oauth = () => oauthMethods(provider.id)
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
                      <Show when={methods().some((method) => method.type === "oauth") && oauth().length === 0}>
                        <span class="fc-chip">{t("OAuth available")}</span>
                      </Show>
                      <Show when={oauth().length > 0 && !connectedInV2(provider.id)}>
                        <button
                          class="fc-button"
                          type="button"
                          disabled={props.busy || attemptProvider() === provider.id}
                          onClick={() => {
                            const method = oauth()[0]
                            if (method) void startOAuth(provider.id, method.id)
                          }}
                        >
                          {t("Sign in")}
                        </button>
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
    <Show when={attempt()}>
      {(current) => (
        <div class="fc-modal-backdrop" onClick={closeOAuth}>
          <div
            class="fc-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("Sign in to {name}", { name: providerName(attemptProvider()) })}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="fc-modal-header">
              <span>{t("Sign in to {name}", { name: providerName(attemptProvider()) })}</span>
              <button class="fc-icon-button" type="button" aria-label={t("Cancel")} onClick={closeOAuth}>
                ×
              </button>
            </div>
            <p class="fc-modal-line">{current().instructions}</p>
            <p class="fc-modal-line">
              <a class="fc-link" href={current().url} target="_blank" rel="noreferrer">
                {current().url}
              </a>
            </p>
            <Show when={attemptError()}>
              <p class="fc-modal-error">{attemptError()}</p>
            </Show>
            <div class="fc-modal-actions">
              <span class="fc-status-line">
                {attemptState()?.status === "pending" ? t("Waiting for authorization…") : ""}
              </span>
              <button class="fc-button" type="button" onClick={closeOAuth}>
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
    <Show when={attemptError() && !attempt()}>
      <div class="fc-modal-backdrop" onClick={() => setAttemptError(undefined)}>
        <div class="fc-modal" role="alertdialog" aria-modal="true" aria-label={t("Sign in failed")} onClick={(event) => event.stopPropagation()}>
          <div class="fc-modal-header">
            <span>{t("Sign in failed")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setAttemptError(undefined)}>
              ×
            </button>
          </div>
          <p class="fc-modal-error">{attemptError()}</p>
          <div class="fc-modal-actions">
            <span />
            <button class="fc-button" type="button" onClick={() => setAttemptError(undefined)}>
              {t("Close")}
            </button>
          </div>
        </div>
      </div>
    </Show>
    </>
  )
}
