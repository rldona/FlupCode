import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type {
  ConsoleOrg,
  ConsoleState,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  IntegrationOAuthMethod,
  ProviderDirectoryInfo,
} from "../engine-types"
import { isEditableProvider, type ConfiguredProvider, type CustomProviderResult } from "../custom-provider"
import { CustomProviderForm } from "./CustomProviderForm"
import { t } from "../i18n"
import { Modal, ModalClose } from "./Modal"

type ProvidersEditorProps = {
  providers: ProviderDirectoryInfo[]
  connected: string[]
  integrations: IntegrationInfo[]
  busy: boolean
  onSave: (providerID: string, key: string) => void
  onRemove: (providerID: string) => void
  /** Providers the engine already knows, so a custom one can be told apart. */
  existingProviderIDs: string[]
  /** Providers hidden by the global config; a custom save clears its own id from here. */
  disabledProviders: string[]
  /** The global config's provider entries, so an existing custom provider can be reopened. */
  configuredProviders: Record<string, ConfiguredProvider>
  onSaveCustomProvider: (result: CustomProviderResult) => Promise<void> | void
  onRemoveCustomProvider: (providerID: string) => Promise<void> | void
  onOAuth: (providerID: string, methodID?: string) => Promise<IntegrationAttempt>
  onOAuthStatus: (attemptID: string) => Promise<IntegrationAttemptStatus>
  onOAuthCancel: (attemptID: string) => Promise<void>
  onOAuthDone: () => void
  /** The Console org behind providers, when the engine has one (CO-1). */
  consoleActive?: ConsoleState
  consoleOrgs?: ConsoleOrg[]
  onSwitchConsole?: (org: ConsoleOrg) => void
}

type ProvidersPanelProps = ProvidersEditorProps & {
  open: boolean
  onClose: () => void
}

/**
 * The providers list on its own, so Settings can mount it as a section (CU-3) instead of
 * a second modal. The OAuth dialogs stay overlays: they interrupt, wherever the list lives.
 */
export const ProvidersEditor: Component<ProvidersEditorProps> = (props) => {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [query, setQuery] = createSignal("")
  const [attempt, setAttempt] = createSignal<IntegrationAttempt | undefined>()
  const [attemptProvider, setAttemptProvider] = createSignal<string | undefined>()
  const [attemptState, setAttemptState] = createSignal<IntegrationAttemptStatus | undefined>()
  const [attemptError, setAttemptError] = createSignal<string | undefined>()
  const [customOpen, setCustomOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<string | undefined>()

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }))

  /**
   * A provider the engine already knew keeps the plain remove. Any provider defined in the config
   * file loses its credential and is added to `disabled_providers`: `source` cannot tell a custom
   * provider from a known one a user overrode in config, and a merged PATCH cannot delete the key.
   */
  const isConfigProvider = (provider: ProviderDirectoryInfo) => provider.source === "config"

  const removeProvider = (provider: ProviderDirectoryInfo) => {
    if (isConfigProvider(provider)) return props.onRemoveCustomProvider(provider.id)
    return props.onRemove(provider.id)
  }

  /** Opens the form blank for a new provider, or with an existing one's values when editing. */
  const openCustom = (providerID?: string) => {
    setEditing(providerID)
    setCustomOpen(true)
  }

  const closeCustom = () => {
    setCustomOpen(false)
    setEditing(undefined)
  }

  const saveCustom = async (result: CustomProviderResult) => {
    await props.onSaveCustomProvider(result)
    closeCustom()
  }

  const integrationFor = (providerID: string) => props.integrations.find((integration) => integration.id === providerID)
  const oauthMethods = (providerID: string) =>
    (integrationFor(providerID)?.methods ?? []).filter(
      (method): method is IntegrationOAuthMethod => method.type === "oauth",
    )
  const isConnected = (providerID: string) =>
    props.connected.includes(providerID) || (integrationFor(providerID)?.connections.length ?? 0) > 0
  const connectedInV2 = (providerID: string) => (integrationFor(providerID)?.connections.length ?? 0) > 0
  const signingIn = (providerID: string) => attemptProvider() === providerID


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
      <p class="fc-modal-line">{t("Add an API key for a provider. It is stored by the OpenCode server.")}</p>
      {/* The Console org behind these providers (CO-1). One org is a label; several are a choice. */}
      <Show when={props.consoleActive?.activeOrgName}>
        {(name) => (
          <p class="fc-modal-line">
            {t("Console organization")}: <strong>{name()}</strong>
          </p>
        )}
      </Show>
      <Show when={(props.consoleOrgs ?? []).length > 1}>
        <label class="fc-field">
          <span>{t("Switch organization")}</span>
          <select
            class="fc-toolbar-select"
            value={props.consoleActive?.activeOrgName ?? ""}
            onChange={(event) => {
              const org = (props.consoleOrgs ?? []).find((entry) => entry.orgName === event.currentTarget.value)
              if (org) props.onSwitchConsole?.(org)
            }}
          >
            <option value="">{t("Choose…")}</option>
            <For each={props.consoleOrgs ?? []}>
              {(org) => (
                <option value={org.orgName}>
                  {org.orgName} · {org.accountEmail}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
            <div class="fc-field-row">
              <input
                class="fc-filter-input"
                style={{ flex: "1" }}
                placeholder={t("Search providers")}
                aria-label={t("Search providers")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button class="fc-button" type="button" disabled={props.busy} onClick={() => openCustom()}>
                {t("Add provider")}
              </button>
            </div>
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
                    const oauth = () => oauthMethods(provider.id)
                    const signedIn = () => connectedInV2(provider.id)
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
                        <Show when={oauth().length > 0}>
                          <button
                            class="fc-button"
                            type="button"
                            disabled={props.busy || signedIn() || signingIn(provider.id)}
                            onClick={() => void startOAuth(provider.id, oauth()[0]!.id)}
                          >
                            <Show
                              when={signingIn(provider.id)}
                              fallback={
                                <Show when={signedIn()} fallback={t("Sign in")}>
                                  {t("Signed in")}
                                </Show>
                              }
                            >
                              <span class="fc-spinner">◐</span> {t("Signing in…")}
                            </Show>
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
                        <Show when={isEditableProvider(props.configuredProviders[provider.id] ?? {})}>
                          <button class="fc-button" type="button" disabled={props.busy} onClick={() => openCustom(provider.id)}>
                            {t("Edit")}
                          </button>
                        </Show>
                        <Show when={configured() || isConfigProvider(provider)}>
                          <button
                            class="fc-button fc-button-danger"
                            type="button"
                            disabled={props.busy}
                            onClick={() => removeProvider(provider)}
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
      <Show when={attempt()}>
        {(current) => (
          <Modal
            onClose={closeOAuth}
            label={t("Sign in to {name}", { name: providerName(attemptProvider()) })}
          >
            <div class="fc-modal-header">
              <span>{t("Sign in to {name}", { name: providerName(attemptProvider()) })}</span>
              <ModalClose />
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
          </Modal>
        )}
      </Show>
      <Modal
        open={!!attemptError() && !attempt()}
        onClose={() => setAttemptError(undefined)}
        class="fc-modal"
        role="alertdialog"
        label={t("Sign in failed")}
      >
        <div class="fc-modal-header">
          <span>{t("Sign in failed")}</span>
          <ModalClose />
        </div>
        <p class="fc-modal-error">{attemptError()}</p>
        <div class="fc-modal-actions">
          <span />
          <button class="fc-button" type="button" onClick={() => setAttemptError(undefined)}>
            {t("Close")}
          </button>
        </div>
      </Modal>
      <Show when={customOpen()}>
        <CustomProviderForm
          existingProviderIDs={props.existingProviderIDs}
          disabledProviders={props.disabledProviders}
          configured={props.configuredProviders}
          editing={editing()}
          busy={props.busy}
          onSave={(result) => void saveCustom(result)}
          onClose={closeCustom}
        />
      </Show>
    </>
  )
}
