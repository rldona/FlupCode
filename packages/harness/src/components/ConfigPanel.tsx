import { createEffect, createSignal, type Component, Show } from "solid-js"
import { t } from "../i18n"
import { toast } from "../toast"
import { engineFetch } from "../transport"

type ConfigPanelProps = {
  open: boolean
  serverUrl: string
  onClose: () => void
  onBack?: () => void
}

export const ConfigPanel: Component<ConfigPanelProps> = (props) => {
  const [text, setText] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  // The advanced editor writes to the directory's own file by default, like it always did; the
  // global one is shared by every directory, so it is an explicit choice.
  const [scope, setScope] = createSignal<"project" | "global">("project")

  const base = () => props.serverUrl.replace(/\/$/, "")
  const path = () => (scope() === "global" ? "/global/config" : "/config")

  const load = async (target: "project" | "global") => {
    setLoading(true)
    try {
      const response = await engineFetch(`${base()}${target === "global" ? "/global/config" : "/config"}`)
      setText(JSON.stringify(await response.json(), null, 2))
    } catch {
      setText("{}")
    } finally {
      setLoading(false)
    }
  }

  // Reload whenever the scope changes, not only when the panel opens: the textarea must never keep
  // one file's JSON while Save names another.
  createEffect(() => {
    if (props.open) void load(scope())
  })

  const save = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text())
    } catch {
      toast(t("Invalid JSON"), "error")
      return
    }
    try {
      const response = await engineFetch(`${base()}${path()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), "error")
    }
  }

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-wide"
          role="dialog"
          aria-modal="true"
          aria-label={t("Config (advanced)")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span class="fc-modal-heading">
              <Show when={props.onBack}>
                <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
                  ←
                </button>
              </Show>
              <span>{t("Config (advanced)")}</span>
            </span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <textarea
            class="fc-config-editor"
            spellcheck={false}
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
          />
          <div class="fc-field-row">
            <label class="fc-field">
              <span>{t("Scope")}</span>
              <select
                class="fc-toolbar-select"
                value={scope()}
                onChange={(event) => setScope(event.currentTarget.value as "project" | "global")}
              >
                <option value="project">{t("Project")}</option>
                <option value="global">{t("Global")}</option>
              </select>
            </label>
          </div>
          <div class="fc-modal-links">
            <button class="fc-button" type="button" disabled={loading()} onClick={() => void load(scope())}>
              {t("Reload")}
            </button>
            <button class="fc-button fc-button-primary" type="button" disabled={loading()} onClick={save}>
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
