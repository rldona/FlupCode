import { createEffect, createSignal, type Component, Show } from "solid-js"
import type { EngineClient } from "../client"
import { t } from "../i18n"
import { toast } from "../toast"
import { failureDetail } from "./PanelBoundary"
import { Modal, ModalClose } from "./Modal"
import { Icon } from "./Icon"

type ConfigPanelProps = {
  open: boolean
  client: EngineClient
  /** The app's own copies of the config are read again once a save lands. */
  onSaved: () => void
  onClose: () => void
  onBack?: () => void
}

/**
 * The engine's config file as JSON (TI-12). OpenCode 2 neither serves nor writes the file in the
 * shape it loads, so it is read and patched through the adapter, which goes to the harness server
 * (`/harness/engine-config`) and asks the engine to reload, the same path the settings panels take.
 */
export const ConfigPanel: Component<ConfigPanelProps> = (props) => {
  const [text, setText] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  // A file that could not be read is said, not shown as an empty `{}` a save would write back.
  const [failure, setFailure] = createSignal<string>()
  // The advanced editor writes to the engine folder's own file by default, like it always did; the
  // global one is shared by every directory, so it is an explicit choice.
  const [scope, setScope] = createSignal<"project" | "global">("project")

  const load = async (target: "project" | "global") => {
    setLoading(true)
    setFailure(undefined)
    await props.client
      .configFile(target)
      .then((config) => setText(JSON.stringify(config, null, 2)))
      .catch((cause) => {
        setText("")
        setFailure(cause instanceof Error ? failureDetail(cause) : String(cause))
      })
    setLoading(false)
  }

  // Reload whenever the scope changes, not only when the panel opens: the textarea must never keep
  // one file's JSON while Save names another.
  createEffect(() => {
    if (props.open) void load(scope())
  })

  const save = async () => {
    const parsed = parseObject(text())
    if (!parsed) {
      toast(t("Invalid JSON"), "error")
      return
    }
    await (scope() === "global" ? props.client.updateGlobalConfig(parsed) : props.client.updateConfig(parsed)).then(
      () => {
        toast(t("Config saved"), "success")
        props.onSaved()
      },
      (cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"),
    )
  }

  return (
    <Modal open={props.open} onClose={props.onClose} class="fc-modal fc-modal-wide" label={t("Config (advanced)")}>
      <div class="fc-modal-header">
        <span class="fc-modal-heading">
          <Show when={props.onBack}>
            <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
              <Icon name="arrow-left" />
            </button>
          </Show>
          <span>{t("Config (advanced)")}</span>
        </span>
        <ModalClose />
      </div>
      <Show when={failure()}>{(message) => <p class="fc-modal-error">{message()}</p>}</Show>
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
        <button
          class="fc-button fc-button-primary"
          type="button"
          disabled={loading() || !!failure()}
          onClick={() => void save()}
        >
          {t("Save")}
        </button>
      </div>
    </Modal>
  )
}

/** The editor's text as the object a patch needs, or nothing when it is not one. */
function parseObject(text: string) {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
