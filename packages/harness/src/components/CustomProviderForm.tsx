import { For, Show, batch, createEffect, createSignal, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  editableProviderIDs,
  formFromConfigured,
  headerRow,
  isEditableProvider,
  modelRow,
  validateCustomProvider,
  type ConfiguredProvider,
  type CustomProviderResult,
  type FormState,
} from "../custom-provider"
import { t } from "../i18n"

type CustomProviderFormProps = {
  existingProviderIDs: string[]
  disabledProviders: string[]
  /** Providers already in the global config, so an existing one reopens with what is there. */
  configured: Record<string, ConfiguredProvider>
  /** Reopens an existing provider with its id locked, instead of adding a new one. */
  editing?: string
  busy: boolean
  onSave: (result: CustomProviderResult) => void
  onClose: () => void
}

export const CustomProviderForm: Component<CustomProviderFormProps> = (props) => {
  const [form, setForm] = createStore<FormState>({
    providerID: props.editing ?? "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })
  const [loadedID, setLoadedID] = createSignal("")

  const loadConfigured = (id: string) => {
    const entry = props.configured[id]
    if (!entry || !isEditableProvider(entry) || loadedID() === id) return
    const next = formFromConfigured(entry)
    batch(() => {
      setForm("name", next.name)
      setForm("baseURL", next.baseURL)
      setForm("models", next.models)
      setForm("headers", next.headers)
      setForm("err", {})
    })
    setLoadedID(id)
  }

  createEffect(() => {
    if (props.editing) loadConfigured(props.editing)
  })

  const addModel = () =>
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () =>
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  /** Typing the id of an existing OpenAI-compatible provider fills the form from the global config. */
  const setProviderID = (value: string) => {
    setField("providerID", value)
    loadConfigured(value.trim())
  }

  const setModel = (index: number, key: "id" | "name" | "effort", value: string) => {
    setForm("models", index, key, value)
    setForm("models", index, "err", key, undefined)
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    setForm("headers", index, key, value)
    setForm("headers", index, "err", key, undefined)
  }

  const save = () => {
    if (props.busy) return
    const output = validateCustomProvider({
      form,
      t,
      disabledProviders: props.disabledProviders,
      existingProviderIDs: new Set(props.existingProviderIDs),
      editableProviderIDs: editableProviderIDs(props.configured),
    })
    setForm("err", output.err)
    output.models.forEach((err, index) => setForm("models", index, "err", err))
    output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    if (output.result) props.onSave(output.result)
  }

  return (
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div
        class="fc-modal fc-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={props.editing ? t("Edit provider") : t("Custom provider")}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="fc-modal-header">
          <span>{props.editing ? t("Edit provider") : t("Custom provider")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>

        <p class="fc-modal-line">
          {t("Configure an OpenAI-compatible provider. See the ")}
          <a
            class="fc-link"
            href="https://opencode.ai/docs/providers/#custom-provider"
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
          >
            {t("provider config docs")}
          </a>
        </p>

        <label class="fc-field">
          <span>{t("Provider ID")}</span>
          <input
            class="fc-question-custom"
            placeholder={t("myprovider")}
            readOnly={props.editing !== undefined}
            value={form.providerID}
            onInput={(event) => setProviderID(event.currentTarget.value)}
          />
          <Show when={form.err.providerID}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
          <span class="fc-field-hint">{t("Lowercase letters, numbers, hyphens, or underscores")}</span>
        </label>

        <label class="fc-field">
          <span>{t("Display name")}</span>
          <input
            class="fc-question-custom"
            placeholder={t("My AI Provider")}
            value={form.name}
            onInput={(event) => setField("name", event.currentTarget.value)}
          />
          <Show when={form.err.name}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
        </label>

        <label class="fc-field">
          <span>{t("Base URL")}</span>
          <input
            class="fc-question-custom"
            placeholder={t("https://api.myprovider.com/v1")}
            value={form.baseURL}
            onInput={(event) => setField("baseURL", event.currentTarget.value)}
          />
          <Show when={form.err.baseURL}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
        </label>

        <label class="fc-field">
          <span>{t("API key")}</span>
          <input
            class="fc-question-custom"
            type="password"
            value={form.apiKey}
            onInput={(event) => setField("apiKey", event.currentTarget.value)}
          />
          <span class="fc-field-hint">{t("Optional. Leave empty if you manage auth via headers.")}</span>
        </label>

        <div class="fc-field">
          <span>{t("Models")}</span>
          <For each={form.models}>
            {(model, index) => (
              <div class="fc-field-row">
                <label class="fc-field">
                  <span>{t("ID")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder={t("model-id")}
                    value={model.id}
                    onInput={(event) => setModel(index(), "id", event.currentTarget.value)}
                  />
                  <Show when={model.err.id}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
                </label>
                <label class="fc-field">
                  <span>{t("Name")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder={t("Display Name")}
                    value={model.name}
                    onInput={(event) => setModel(index(), "name", event.currentTarget.value)}
                  />
                  <Show when={model.err.name}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
                </label>
                <label class="fc-field">
                  <span>{t("Effort levels")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder={t("low,medium,high")}
                    value={model.effort}
                    onInput={(event) => setModel(index(), "effort", event.currentTarget.value)}
                  />
                  <Show when={model.err.effort}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
                  <span class="fc-field-hint">{t("Optional. Comma-separated reasoning effort levels.")}</span>
                </label>
                <button
                  class="fc-button fc-button-danger"
                  type="button"
                  aria-label={t("Remove model")}
                  disabled={form.models.length <= 1}
                  onClick={() => removeModel(index())}
                >
                  ×
                </button>
              </div>
            )}
          </For>
          <button class="fc-button" type="button" onClick={addModel}>
            {t("Add model")}
          </button>
        </div>

        <div class="fc-field">
          <span>{t("Headers (optional)")}</span>
          <For each={form.headers}>
            {(header, index) => (
              <div class="fc-field-row">
                <label class="fc-field">
                  <span>{t("Header")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder={t("Header-Name")}
                    value={header.key}
                    onInput={(event) => setHeader(index(), "key", event.currentTarget.value)}
                  />
                  <Show when={header.err.key}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
                </label>
                <label class="fc-field">
                  <span>{t("Value")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder={t("value")}
                    value={header.value}
                    onInput={(event) => setHeader(index(), "value", event.currentTarget.value)}
                  />
                  <Show when={header.err.value}>{(message) => <span class="fc-modal-error">{message()}</span>}</Show>
                </label>
                <button
                  class="fc-button fc-button-danger"
                  type="button"
                  aria-label={t("Remove header")}
                  disabled={form.headers.length <= 1}
                  onClick={() => removeHeader(index())}
                >
                  ×
                </button>
              </div>
            )}
          </For>
          <button class="fc-button" type="button" onClick={addHeader}>
            {t("Add header")}
          </button>
        </div>

        <div class="fc-modal-actions">
          <span />
          <button class="fc-button" type="button" onClick={props.onClose}>
            {t("Cancel")}
          </button>
          <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={save}>
            {t("Save")}
          </button>
        </div>
      </div>
    </div>
  )
}
