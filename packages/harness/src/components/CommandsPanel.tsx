import { For, Show, createSignal, type Component } from "solid-js"
import type { CommandFile } from "../types"
import { t } from "../i18n"

export type CommandDraft = {
  name: string
  scope: "global" | "project"
  fields: Record<string, unknown>
  template: string
}

type CommandsPanelProps = {
  files: CommandFile[]
  /** Agent names the engine reports, for the `agent` field; empty means the field is free text. */
  agents: string[]
  serverAvailable: boolean
  onSave: (draft: CommandDraft) => void
  onDelete: (path: string) => void
}

/** The frontmatter keys the form owns. Everything else is somebody else's and is put back. */
export const COMMAND_KEYS = ["description", "agent", "model", "variant", "subtask"] as const

type Values = {
  description: string
  agent: string
  model: string
  variant: string
  subtask: boolean
  template: string
}

/**
 * The file's settings with the form's values on top, keeping every key the form does not know.
 *
 * Same promise the agent editor makes: an editor that drops what it does not recognise eats work.
 */
export function fieldsFor(values: Values, original: Record<string, unknown>): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(original).filter(([key]) => !COMMAND_KEYS.includes(key as never)))
  const fields: Record<string, unknown> = { ...extra }
  if (values.description.trim()) fields.description = values.description.trim()
  if (values.agent.trim()) fields.agent = values.agent.trim()
  if (values.model.trim()) fields.model = values.model.trim()
  if (values.variant.trim()) fields.variant = values.variant.trim()
  if (values.subtask) fields.subtask = true
  return fields
}

const empty: Values = { description: "", agent: "", model: "", variant: "", subtask: false, template: "" }

export const CommandsPanel: Component<CommandsPanelProps> = (props) => {
  const [openPath, setOpenPath] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<"global" | "project">("project")
  const [values, setValues] = createSignal<Values>(empty)
  const [confirming, setConfirming] = createSignal(false)

  const selected = () => props.files.find((file) => file.path === openPath())

  const load = (file: CommandFile) => {
    if (openPath() === file.path) {
      setOpenPath(undefined)
      return
    }
    setCreating(false)
    setConfirming(false)
    setOpenPath(file.path)
    setName(file.name)
    setScope(file.scope)
    setValues({
      description: typeof file.fields.description === "string" ? file.fields.description : "",
      agent: typeof file.fields.agent === "string" ? file.fields.agent : "",
      model: typeof file.fields.model === "string" ? file.fields.model : "",
      variant: typeof file.fields.variant === "string" ? file.fields.variant : "",
      subtask: file.fields.subtask === true,
      template: file.template,
    })
  }

  const startNew = () => {
    setCreating(true)
    setOpenPath(undefined)
    setConfirming(false)
    setName("")
    setScope("project")
    setValues(empty)
  }

  const save = () => {
    const commandName = name().trim()
    if (!commandName) return
    props.onSave({
      name: commandName,
      scope: scope(),
      fields: fieldsFor(values(), selected()?.fields ?? {}),
      template: values().template,
    })
    setCreating(false)
    setOpenPath(undefined)
  }

  const remove = (file: CommandFile) => {
    if (!confirming()) {
      setConfirming(true)
      return
    }
    props.onDelete(file.path)
    setConfirming(false)
    setOpenPath(undefined)
  }

  return (
    <div class="fc-command-editor">
      <Show
        when={props.serverAvailable}
        fallback={<p class="fc-settings-hint">{t("Editing commands needs the harness server running.")}</p>}
      >
        <Show
          when={props.files.length > 0}
          fallback={<p class="fc-settings-hint">{t("No commands yet.")}</p>}
        >
          <ul class="fc-command-list">
            <For each={props.files}>
              {(file) => (
                <li class="fc-command-row" classList={{ "fc-command-row-open": openPath() === file.path }}>
                  <button class="fc-command-open" type="button" onClick={() => load(file)}>
                    <code>/{file.name}</code>
                    <span class="fc-command-scope">{file.scope === "global" ? t("Global") : t("Project")}</span>
                  </button>
                  <Show when={file.problem}>
                    <span class="fc-settings-hint">{file.problem}</span>
                  </Show>
                  <Show when={openPath() === file.path}>
                    <button
                      class="fc-button"
                      classList={{ "fc-button-danger": confirming() }}
                      type="button"
                      onClick={() => remove(file)}
                    >
                      {confirming() ? t("Click again to delete") : t("Delete")}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={creating() || selected()}>
          <div class="fc-command-form">
            <div class="fc-field-row">
              <label class="fc-field">
                <span>{t("Name")}</span>
                <input
                  class="fc-question-custom"
                  placeholder="git/release"
                  value={name()}
                  disabled={!creating()}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
                <span class="fc-field-hint">{t("A slash makes a nested command.")}</span>
              </label>
              <label class="fc-field">
                <span>{t("Where")}</span>
                <select
                  class="fc-toolbar-select"
                  value={scope()}
                  disabled={!creating()}
                  onChange={(event) => setScope(event.currentTarget.value as "global" | "project")}
                >
                  <option value="project">{t("Project")}</option>
                  <option value="global">{t("Global")}</option>
                </select>
              </label>
            </div>

            <label class="fc-field">
              <span>{t("Description")}</span>
              <input
                class="fc-question-custom"
                value={values().description}
                onInput={(event) => setValues({ ...values(), description: event.currentTarget.value })}
              />
            </label>

            <div class="fc-field-row">
              <label class="fc-field">
                <span>{t("Agent")}</span>
                <Show
                  when={props.agents.length > 0}
                  fallback={
                    <input
                      class="fc-question-custom"
                      value={values().agent}
                      onInput={(event) => setValues({ ...values(), agent: event.currentTarget.value })}
                    />
                  }
                >
                  <select
                    class="fc-toolbar-select"
                    value={values().agent}
                    onChange={(event) => setValues({ ...values(), agent: event.currentTarget.value })}
                  >
                    <option value="">{t("Default")}</option>
                    <For each={props.agents}>{(agent) => <option value={agent}>{agent}</option>}</For>
                  </select>
                </Show>
              </label>
              <label class="fc-field">
                <span>{t("Model")}</span>
                <input
                  class="fc-question-custom"
                  placeholder={t("Optional")}
                  value={values().model}
                  onInput={(event) => setValues({ ...values(), model: event.currentTarget.value })}
                />
              </label>
              <label class="fc-field">
                <span>{t("Variant")}</span>
                <input
                  class="fc-question-custom"
                  placeholder={t("Optional")}
                  value={values().variant}
                  onInput={(event) => setValues({ ...values(), variant: event.currentTarget.value })}
                />
              </label>
              <label class="fc-field fc-check">
                <input
                  type="checkbox"
                  checked={values().subtask}
                  onChange={(event) => setValues({ ...values(), subtask: event.currentTarget.checked })}
                />
                <span>{t("Run in a subtask")}</span>
              </label>
            </div>

            <label class="fc-field">
              <span>{t("Template")}</span>
              <textarea
                class="fc-field-area"
                rows={6}
                placeholder={t("What the command says. $ARGUMENTS is what was typed after it.")}
                value={values().template}
                onInput={(event) => setValues({ ...values(), template: event.currentTarget.value })}
              />
            </label>

            <div class="fc-settings-actions">
              <button class="fc-button fc-button-primary" type="button" onClick={save}>
                {t("Save")}
              </button>
              <button
                class="fc-button"
                type="button"
                onClick={() => {
                  setCreating(false)
                  setOpenPath(undefined)
                }}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </Show>

        <Show when={!creating() && !selected()}>
          <button class="fc-button" type="button" onClick={startNew}>
            {t("New command")}
          </button>
        </Show>
      </Show>
    </div>
  )
}
