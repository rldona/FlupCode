import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type {
  ConsoleOrg,
  ConsoleState,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  IntegrationOAuthMethod,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderDirectoryInfo,
} from "../engine-types"
import { t } from "../i18n"

type ProvidersEditorProps = {
  providers: ProviderDirectoryInfo[]
  auth: Record<string, ProviderAuthMethod[]>
  connected: string[]
  integrations: IntegrationInfo[]
  /** Providers whose configured key is not a usable credential yet; ids only, never the key. */
  unlinked: string[]
  busy: boolean
  onSave: (providerID: string, key: string) => void
  onRemove: (providerID: string) => void
  onOAuth: (providerID: string, methodID?: string) => Promise<IntegrationAttempt>
  onOAuthStatus: (attemptID: string) => Promise<IntegrationAttemptStatus>
  onOAuthCancel: (attemptID: string) => Promise<void>
  onOAuthDone: () => void
  /**
   * The engine's legacy provider OAuth. The panel falls back to it when a provider advertises an
   * OAuth method in `provider.auth()` but its v2 integration has none (a stock OpenCode CLI
   * registers Copilot's device flow only there). `authorize` returns the URL and instructions;
   * `callback` blocks until the provider authorizes and stores the credential.
   */
  onOAuthLegacy: (
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ) => Promise<ProviderAuthAuthorization>
  onOAuthLegacyCallback: (providerID: string, method: number, code?: string) => Promise<void>
  onLinkConfigured: () => void
  /** The Console org behind providers, when the engine has one (CO-1). */
  consoleActive?: ConsoleState
  consoleOrgs?: ConsoleOrg[]
  onSwitchConsole?: (org: ConsoleOrg) => void
}

type ProvidersPanelProps = ProvidersEditorProps & {
  open: boolean
  onClose: () => void
}

/** A legacy provider OAuth sign-in in progress: prompts first, then the authorization to finish. */
type LegacyFlow = {
  /** Identifies this sign-in so a late response from a cancelled one is ignored. */
  token: number
  providerID: string
  methodIndex: number
  method: ProviderAuthMethod
  inputs: Record<string, string>
  authorization?: ProviderAuthAuthorization
}

/** A legacy prompt is shown only when its `when` condition matches the answers so far. */
export function matchesPrompt(prompt: NonNullable<ProviderAuthMethod["prompts"]>[number], inputs: Record<string, string>) {
  if (!prompt.when) return true
  const actual = inputs[prompt.when.key]
  return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
}

/** Select prompts start on their first option so the flow never submits an empty answer. */
export function defaultInputs(method: ProviderAuthMethod) {
  const inputs: Record<string, string> = {}
  for (const prompt of method.prompts ?? []) {
    if (prompt.type === "select" && prompt.options[0]) inputs[prompt.key] = prompt.options[0].value
  }
  return inputs
}

type LegacyPrompt = NonNullable<ProviderAuthMethod["prompts"]>[number]

function promptPlaceholder(prompt: LegacyPrompt) {
  return prompt.type === "text" ? (prompt.placeholder ?? "") : ""
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
  const [legacy, setLegacy] = createSignal<LegacyFlow | undefined>()
  const [legacyError, setLegacyError] = createSignal<string | undefined>()
  const [legacyPending, setLegacyPending] = createSignal(false)
  const [legacyCode, setLegacyCode] = createSignal("")
  const [legacySeq, setLegacySeq] = createSignal(0)

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }))

  const integrationFor = (providerID: string) => props.integrations.find((integration) => integration.id === providerID)
  const oauthMethods = (providerID: string) =>
    (integrationFor(providerID)?.methods ?? []).filter(
      (method): method is IntegrationOAuthMethod => method.type === "oauth",
    )
  const isConnected = (providerID: string) =>
    props.connected.includes(providerID) || (integrationFor(providerID)?.connections.length ?? 0) > 0
  const connectedInV2 = (providerID: string) => (integrationFor(providerID)?.connections.length ?? 0) > 0

  /** The engine's legacy OAuth method for a provider, with the index `authorize`/`callback` expect. */
  const legacyOAuth = (providerID: string) => {
    const methods = props.auth[providerID] ?? []
    const index = methods.findIndex((method) => method.type === "oauth")
    const method = index === -1 ? undefined : methods[index]
    return method ? { index, method } : undefined
  }
  const hasOAuth = (providerID: string) => oauthMethods(providerID).length > 0 || legacyOAuth(providerID) !== undefined
  const signingIn = (providerID: string) =>
    attemptProvider() === providerID || legacy()?.providerID === providerID

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

  const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

  const promptsFor = (flow: LegacyFlow) =>
    (flow.method.prompts ?? []).filter((prompt) => matchesPrompt(prompt, flow.inputs))
  const visibleLegacyPrompts = () => {
    const flow = legacy()
    return flow ? promptsFor(flow) : []
  }
  const legacyPromptsValid = () =>
    visibleLegacyPrompts().every((prompt) => prompt.type !== "text" || (legacy()?.inputs[prompt.key] ?? "").trim() !== "")

  const setLegacyInput = (key: string, value: string) =>
    setLegacy((current) => (current ? { ...current, inputs: { ...current.inputs, [key]: value } } : current))

  const closeLegacy = () => {
    setLegacy(undefined)
    setLegacyError(undefined)
    setLegacyPending(false)
    setLegacyCode("")
  }

  /** True while `flow` is still the sign-in on screen; a late response from a cancelled one is dropped. */
  const isActive = (flow: LegacyFlow) => legacy()?.token === flow.token

  /** `callback` blocks until the provider authorizes (device flow) and stores the credential itself. */
  const finishLegacyCallback = (flow: LegacyFlow, code?: string) => {
    setLegacyPending(true)
    setLegacyError(undefined)
    props
      .onOAuthLegacyCallback(flow.providerID, flow.methodIndex, code)
      .then(() => {
        // The engine may still have stored the credential after a cancel, so refresh either way.
        if (isActive(flow)) closeLegacy()
        props.onOAuthDone()
      })
      .catch((cause) => {
        if (!isActive(flow)) return
        setLegacyPending(false)
        setLegacyError(message(cause))
      })
  }

  const beginLegacyAuthorize = (flow: LegacyFlow) => {
    setLegacyPending(true)
    setLegacyError(undefined)
    props
      .onOAuthLegacy(flow.providerID, flow.methodIndex, flow.inputs)
      .then((authorization) => {
        if (!isActive(flow)) return
        if (!authorization) throw new Error(t("This provider did not offer OAuth"))
        setLegacyPending(false)
        setLegacy({ ...flow, authorization })
        if (authorization.method === "auto") finishLegacyCallback(flow)
      })
      .catch((cause) => {
        if (!isActive(flow)) return
        setLegacyPending(false)
        setLegacyError(message(cause))
      })
  }

  const startLegacyOAuth = (providerID: string) => {
    const entry = legacyOAuth(providerID)
    if (!entry) return
    const token = legacySeq() + 1
    setLegacySeq(token)
    const flow: LegacyFlow = {
      token,
      providerID,
      methodIndex: entry.index,
      method: entry.method,
      inputs: defaultInputs(entry.method),
    }
    setLegacyError(undefined)
    setLegacyPending(false)
    setLegacyCode("")
    setLegacy(flow)
    if (promptsFor(flow).length === 0) beginLegacyAuthorize(flow)
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
            <Show when={props.unlinked.length > 0}>
              <div class="fc-provider-notice">
                <span>
                  {t("{count} providers have a key in the engine's configuration that sessions cannot use yet", {
                    count: props.unlinked.length,
                  })}
                </span>
                <button class="fc-button" type="button" disabled={props.busy} onClick={props.onLinkConfigured}>
                  {t("Connect them")}
                </button>
              </div>
            </Show>
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
                    const oauth = () => oauthMethods(provider.id)
                    // The v2 path keys off the integration's own connection; the legacy path has no
                    // v2 connection to read, so it uses the engine's connected list instead.
                    const signedIn = () => (oauth().length > 0 ? connectedInV2(provider.id) : configured())
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
                        <Show when={hasOAuth(provider.id)}>
                          <button
                            class="fc-button"
                            type="button"
                            disabled={props.busy || signedIn() || signingIn(provider.id)}
                            onClick={() => {
                              const method = oauth()[0]
                              if (method) {
                                void startOAuth(provider.id, method.id)
                                return
                              }
                              startLegacyOAuth(provider.id)
                            }}
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
      <Show when={legacy()}>
        {(flow) => (
          <div class="fc-modal-backdrop" onClick={closeLegacy}>
            <div
              class="fc-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t("Sign in to {name}", { name: providerName(flow().providerID) })}
              onClick={(event) => event.stopPropagation()}
            >
              <div class="fc-modal-header">
                <span>{t("Sign in to {name}", { name: providerName(flow().providerID) })}</span>
                <button class="fc-icon-button" type="button" aria-label={t("Cancel")} onClick={closeLegacy}>
                  ×
                </button>
              </div>
              <Show when={!flow().authorization}>
                <For each={visibleLegacyPrompts()}>
                  {(prompt) => (
                    <label class="fc-field">
                      <span>{prompt.message}</span>
                      <Show
                        when={prompt.type === "select" ? prompt : undefined}
                        fallback={
                          <input
                            class="fc-question-custom"
                            type="text"
                            placeholder={promptPlaceholder(prompt)}
                            value={flow().inputs[prompt.key] ?? ""}
                            onInput={(event) => setLegacyInput(prompt.key, event.currentTarget.value)}
                          />
                        }
                      >
                        {(select) => (
                          <select
                            class="fc-toolbar-select"
                            value={flow().inputs[prompt.key] ?? ""}
                            onChange={(event) => setLegacyInput(prompt.key, event.currentTarget.value)}
                          >
                            <For each={select().options}>
                              {(option) => <option value={option.value}>{option.label}</option>}
                            </For>
                          </select>
                        )}
                      </Show>
                    </label>
                  )}
                </For>
              </Show>
              <Show when={flow().authorization}>
                {(authorization) => (
                  <>
                    <p class="fc-modal-line">{authorization().instructions}</p>
                    <p class="fc-modal-line">
                      <a class="fc-link" href={authorization().url} target="_blank" rel="noreferrer">
                        {authorization().url}
                      </a>
                    </p>
                    <Show when={authorization().method === "code"}>
                      <label class="fc-field">
                        <span>{t("Authorization code")}</span>
                        <input
                          class="fc-question-custom"
                          type="text"
                          value={legacyCode()}
                          onInput={(event) => setLegacyCode(event.currentTarget.value)}
                        />
                      </label>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={legacyError()}>
                <p class="fc-modal-error">{legacyError()}</p>
              </Show>
              <div class="fc-modal-actions">
                <span class="fc-status-line">{legacyPending() ? t("Waiting for authorization…") : ""}</span>
                <Show when={!flow().authorization}>
                  <button
                    class="fc-button fc-button-primary"
                    type="button"
                    disabled={legacyPending() || !legacyPromptsValid()}
                    onClick={() => beginLegacyAuthorize(flow())}
                  >
                    {t("Continue")}
                  </button>
                </Show>
                <Show when={flow().authorization?.method === "code"}>
                  <button
                    class="fc-button fc-button-primary"
                    type="button"
                    disabled={legacyPending() || !legacyCode().trim()}
                    onClick={() => finishLegacyCallback(flow(), legacyCode().trim())}
                  >
                    {t("Continue")}
                  </button>
                </Show>
                <button class="fc-button" type="button" onClick={closeLegacy}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={attemptError() && !attempt()}>
        <div class="fc-modal-backdrop" onClick={() => setAttemptError(undefined)}>
          <div
            class="fc-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={t("Sign in failed")}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="fc-modal-header">
              <span>{t("Sign in failed")}</span>
              <button
                class="fc-icon-button"
                type="button"
                aria-label={t("Close")}
                onClick={() => setAttemptError(undefined)}
              >
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
