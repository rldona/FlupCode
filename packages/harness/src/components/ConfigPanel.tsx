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

  const base = () => props.serverUrl.replace(/\/$/, "")

  const load = async () => {
    setLoading(true)
    try {
      const response = await engineFetch(`${base()}/config`)
      setText(JSON.stringify(await response.json(), null, 2))
    } catch {
      setText("{}")
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    if (props.open) void load()
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
      const response = await engineFetch(`${base()}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      toast(t("Config saved"), "success")
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), "error")
    }
  }

  return (
    <Show when={props.open}>
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" aria-label={t("Config (advanced)")} onClick={(event) => event.stopPropagation()}>
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
        <div class="fc-modal-links">
          <button class="fc-button" type="button" disabled={loading()} onClick={() => void load()}>
            {t("Reload")}
          </button>
          <button class="fc-button fc-button-primary" type="button" onClick={save}>
            {t("Save")}
          </button>
        </div>
      </div>
    </div>
    </Show>
  )
}
