import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { AgentFile } from "../types"
import type { AgentInfo, McpServer } from "../engine-types"

type AgentsPanelProps = {
  open: boolean
  /** The files on disk, which is what can be changed. */
  files: AgentFile[]
  /** What the engine says exists, which is more: built-ins and plugins have no file. */
  agents: AgentInfo[]
  tools: string[]
  mcp: McpServer[]
  models: string[]
  loading: boolean
  serverAvailable: boolean
  hasProject: boolean
  onSave: (draft: {
    name: string
    scope: "global" | "project"
    fields: Record<string, unknown>
    prompt: string
  }) => Promise<unknown>
  onDelete: (path: string) => Promise<unknown>
}

/** The three the engine accepts, in the order they are worth choosing between. */
const MODES = ["subagent", "primary", "all"] as const

/** The permission keys the engine names, with the two it treats as paths first. */
export const PERMISSIONS = ["edit", "bash", "read", "webfetch", "external_directory"] as const

const ACTIONS = ["allow", "ask", "deny"] as const

const text = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? String(value) : "")

/**
 * The keys this form owns. Everything else in a file's frontmatter is put back untouched, which is
 * the difference between an editor and a rewriter.
 */
export const OWNED = [
  "description",
  "mode",
  "model",
  "variant",
  "temperature",
  "steps",
  "color",
  "hidden",
  "disable",
  "tools",
  "permission",
] as const

/** What the form would write, given what it was shown and what it did not understand. */
export function fieldsFrom(
  form: {
    description: string
    mode: string
    model: string
    variant: string
    temperature: string
    steps: string
    color: string
    hidden: boolean
    disable: boolean
    tools: Record<string, boolean>
    permission: Record<string, string>
  },
  original: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(original)) {
    if (!(OWNED as readonly string[]).includes(key)) kept[key] = value
  }
  // A permission whose value is a map of patterns — `edit: { "src/**": allow }` — is a shape this
  // form does not show. It is carried over rather than replaced by the flat value, because a form
  // that silently deletes a rule it could not draw is worse than one that cannot draw it.
  const patterned = Object.fromEntries(
    Object.entries((original.permission ?? {}) as Record<string, unknown>).filter(
      ([, value]) => value && typeof value === "object",
    ),
  )
  const permission = { ...form.permission, ...patterned }
  const temperature = Number(form.temperature)
  const steps = Number(form.steps)
  return {
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.mode ? { mode: form.mode } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.variant.trim() ? { variant: form.variant.trim() } : {}),
    // An empty box means "do not set this", which is not the same as zero — and zero is a
    // temperature somebody might mean.
    ...(form.temperature.trim() && Number.isFinite(temperature) ? { temperature } : {}),
    ...(form.steps.trim() && Number.isInteger(steps) && steps > 0 ? { steps } : {}),
    ...(form.color.trim() ? { color: form.color.trim() } : {}),
    ...(form.hidden ? { hidden: true } : {}),
    ...(form.disable ? { disable: true } : {}),
    ...(Object.keys(form.tools).length > 0 ? { tools: form.tools } : {}),
    ...(Object.keys(permission).length > 0 ? { permission } : {}),
    ...kept,
  }
}

/** The agents the engine reports that no file here can change, and why. */
export function withoutFiles(agents: AgentInfo[], files: AgentFile[]) {
  const named = new Set(files.map((file) => file.name))
  return agents.filter((agent) => !named.has(agent.id))
}

const empty = {
  description: "",
  mode: "subagent",
  model: "",
  variant: "",
  temperature: "",
  steps: "",
  color: "",
  hidden: false,
  disable: false,
  tools: {} as Record<string, boolean>,
  permission: {} as Record<string, string>,
}

/**
 * Agents you can edit (H-13).
 *
 * An agent is a markdown file. The harness could list them and not change them, so configuring one
 * meant leaving for an editor and knowing which keys the engine reads — the audit's "sólo JSON
 * crudo". This is a form over the file, and it says plainly which agents have no file behind them:
 * the built-ins and the ones a plugin registers cannot be edited here, and pretending otherwise
 * would be a form that silently does nothing.
 */
export const AgentsPanel: Component<AgentsPanelProps> = (props) => {
  const [openPath, setOpenPath] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<"global" | "project">("project")
  const [form, setForm] = createSignal({ ...empty })
  const [prompt, setPrompt] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()

  const selected = createMemo(() => props.files.find((file) => file.path === openPath()))

  /** Puts a file into the form. A file is loaded once; typing in it must not be overwritten. */
  const load = (file: AgentFile | undefined) => {
    setProblem(undefined)
    setSaved(undefined)
    if (!file) {
      setForm({ ...empty })
      setPrompt("")
      setName("")
      return
    }
    const fields = file.fields
    setForm({
      description: text(fields.description),
      mode: text(fields.mode) || "subagent",
      model: text(fields.model),
      variant: text(fields.variant),
      temperature: num(fields.temperature),
      steps: num(fields.steps),
      color: text(fields.color),
      hidden: fields.hidden === true,
      disable: fields.disable === true,
      tools: (fields.tools && typeof fields.tools === "object" ? { ...(fields.tools as Record<string, boolean>) } : {}),
      // Only the flat form, `edit: deny`. The engine also accepts a map of patterns per key, and
      // this form does not show those — so they are left in `fields` and put back untouched rather
      // than flattened into something they are not.
      permission: Object.fromEntries(
        Object.entries((fields.permission ?? {}) as Record<string, unknown>).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value] as [string, string]] : [],
        ),
      ),
    })
    setPrompt(file.prompt)
    setName(file.name)
    setScope(file.scope)
  }

  const openFile = (file: AgentFile) => {
    if (openPath() === file.path) {
      setOpenPath(undefined)
      return
    }
    setCreating(false)
    setOpenPath(file.path)
    load(file)
  }

  const startNew = () => {
    setOpenPath(undefined)
    setCreating(true)
    load(undefined)
    setScope(props.hasProject ? "project" : "global")
  }

  const save = async () => {
    setProblem(undefined)
    setSaved(undefined)
    if (!name().trim()) {
      setProblem(t("An agent needs a name"))
      return
    }
    setSaving(true)
    try {
      await props.onSave({
        name: name().trim(),
        scope: scope(),
        fields: fieldsFrom(form(), selected()?.fields ?? {}),
        prompt: prompt(),
      })
      setSaved(t("Saved. The engine reads it on the next turn."))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggleTool = (tool: string) => {
    const tools = { ...form().tools }
    // Three states, and the middle one is the point: unset means "whatever the agent already has",
    // which is not the same as switching it off.
    if (tools[tool] === undefined) tools[tool] = false
    else if (tools[tool] === false) tools[tool] = true
    else delete tools[tool]
    setForm({ ...form(), tools })
  }

  const setPermission = (key: string, action: string) => {
    const permission = { ...form().permission }
    if (!action) delete permission[key]
    else permission[key] = action
    setForm({ ...form(), permission })
  }

  const orphans = createMemo(() => withoutFiles(props.agents, props.files))
  const editing = createMemo(() => creating() || !!selected())

  /** Closes the editor dialog: whichever of the two states opened it is cleared. */
  const closeEditor = () => {
    setCreating(false)
    setOpenPath(undefined)
  }

  createEffect(() => {
    if (!props.open) {
      setCreating(false)
      setOpenPath(undefined)
    }
  })

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Agents")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Agents")}</h1>
            <p>{t("Each one is a markdown file. This edits the file.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button fc-button-primary" type="button" onClick={startNew}>
              {t("New agent")}
            </button>
          </div>
        </div>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>

        <div class="fc-context-screen">
          <section class="fc-usage-block">
            <h2>
              {t("On disk")}
              <span class="fc-context-aside">{props.files.length}</span>
            </h2>
            <Show
              when={props.files.length > 0}
              fallback={
                <p class="fc-usage-note">
                  {props.loading ? t("Reading…") : t("No agent files yet. A new one is written where the engine looks.")}
                </p>
              }
            >
              <div class="fc-routine-cards">
                <For each={props.files}>
                  {(file) => (
                    <div class="fc-agent-file">
                      <button
                        class="fc-routine-card fc-agent-row"
                        classList={{ "fc-routine-card-selected": openPath() === file.path }}
                        type="button"
                        onClick={() => openFile(file)}
                        aria-expanded={openPath() === file.path}
                      >
                        <span class="fc-routine-card-icon" aria-hidden="true">
                          ◍
                        </span>
                        <span class="fc-routine-card-content">
                          <strong>{file.name}</strong>
                          <small>{text(file.fields.description) || file.prompt.slice(0, 80)}</small>
                        </span>
                        <span class="fc-artifact-kind">{t(file.scope)}</span>
                        <span class="fc-artifact-kind">{text(file.fields.mode) || "subagent"}</span>
                      </button>
                      <Show when={file.problem}>
                        {(why) => <p class="fc-usage-note fc-agent-problem">{why()}</p>}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <Show when={editing()}>
            <div class="fc-modal-backdrop" onClick={closeEditor}>
              <div
                class="fc-modal fc-form-modal fc-agent-form"
                role="dialog"
                aria-modal="true"
                aria-label={creating() ? t("New agent") : selected()?.name}
                onClick={(event) => event.stopPropagation()}
              >
                <div class="fc-modal-header">
                  <span>{creating() ? t("New agent") : selected()?.name}</span>
                  <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={closeEditor}>
                    ×
                  </button>
                </div>
                <Show when={selected()?.problem}>
                {(why) => (
                  <div class="fc-routines-notice">
                    {t("Saving would overwrite what this file says: {why}", { why: why() })}
                  </div>
                )}
              </Show>

              <label class="fc-field">
                <span>{t("Name")}</span>
                <input
                  class="fc-question-custom"
                  value={name()}
                  disabled={!creating()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder="reviewer"
                />
              </label>
              <Show when={creating()}>
                <label class="fc-field">
                  <span>{t("Where")}</span>
                  <select
                    class="fc-question-custom"
                    value={scope()}
                    onChange={(event) => setScope(event.currentTarget.value as "global" | "project")}
                  >
                    <option value="project" disabled={!props.hasProject}>
                      {t("This project")}
                    </option>
                    <option value="global">{t("Everywhere")}</option>
                  </select>
                </label>
              </Show>

              <label class="fc-field">
                <span>{t("Description")}</span>
                <input
                  class="fc-question-custom"
                  value={form().description}
                  onInput={(event) => setForm({ ...form(), description: event.currentTarget.value })}
                  placeholder={t("When to use it")}
                />
              </label>

              <div class="fc-field-row">
                <label class="fc-field">
                  <span>{t("Mode")}</span>
                  <select
                    class="fc-question-custom"
                    value={form().mode}
                    onChange={(event) => setForm({ ...form(), mode: event.currentTarget.value })}
                  >
                    <For each={MODES}>{(mode) => <option value={mode}>{t(mode)}</option>}</For>
                  </select>
                </label>
                <label class="fc-field">
                  <span>{t("Model")}</span>
                  <input
                    class="fc-question-custom"
                    list="fc-agent-models"
                    value={form().model}
                    onInput={(event) => setForm({ ...form(), model: event.currentTarget.value })}
                    placeholder={t("the default")}
                  />
                  <datalist id="fc-agent-models">
                    <For each={props.models}>{(model) => <option value={model} />}</For>
                  </datalist>
                </label>
                <label class="fc-field">
                  <span>{t("Variant")}</span>
                  <input
                    class="fc-question-custom"
                    value={form().variant}
                    onInput={(event) => setForm({ ...form(), variant: event.currentTarget.value })}
                  />
                </label>
              </div>

              <div class="fc-field-row">
                <label class="fc-field">
                  <span>{t("Temperature")}</span>
                  <input
                    class="fc-question-custom"
                    value={form().temperature}
                    onInput={(event) => setForm({ ...form(), temperature: event.currentTarget.value })}
                    placeholder={t("unset")}
                  />
                </label>
                <label class="fc-field">
                  <span>{t("Steps")}</span>
                  <input
                    class="fc-question-custom"
                    value={form().steps}
                    onInput={(event) => setForm({ ...form(), steps: event.currentTarget.value })}
                    placeholder={t("unset")}
                  />
                </label>
                <label class="fc-field">
                  <span>{t("Colour")}</span>
                  <input
                    class="fc-question-custom"
                    value={form().color}
                    onInput={(event) => setForm({ ...form(), color: event.currentTarget.value })}
                    placeholder="#44BA81"
                  />
                </label>
              </div>

              <div class="fc-field-row">
                <label class="fc-check">
                  <input
                    type="checkbox"
                    checked={form().hidden}
                    onChange={(event) => setForm({ ...form(), hidden: event.currentTarget.checked })}
                  />
                  <span>{t("Hidden from the @ menu")}</span>
                </label>
                <label class="fc-check">
                  <input
                    type="checkbox"
                    checked={form().disable}
                    onChange={(event) => setForm({ ...form(), disable: event.currentTarget.checked })}
                  />
                  <span>{t("Disabled")}</span>
                </label>
              </div>

              <h3>{t("Tools")}</h3>
              <p class="fc-usage-note">{t("Click to switch off, again to switch on, again to leave it unset.")}</p>
              <div class="fc-context-chips">
                <For each={[...props.tools, ...props.mcp.map((server) => server.name)]}>
                  {(tool) => (
                    <button
                      class="fc-context-chip fc-agent-tool"
                      type="button"
                      data-state={form().tools[tool] === undefined ? "unset" : form().tools[tool] ? "on" : "off"}
                      onClick={() => toggleTool(tool)}
                    >
                      {tool}
                    </button>
                  )}
                </For>
              </div>

              <h3>{t("Permissions")}</h3>
              <For each={PERMISSIONS}>
                {(key) => (
                  <div class="fc-usage-row">
                    <span class="fc-usage-key">{key}</span>
                    <select
                      class="fc-question-custom fc-agent-permission"
                      value={form().permission[key] ?? ""}
                      onChange={(event) => setPermission(key, event.currentTarget.value)}
                    >
                      <option value="">{t("unset")}</option>
                      <For each={ACTIONS}>{(action) => <option value={action}>{t(action)}</option>}</For>
                    </select>
                  </div>
                )}
              </For>

              <h3>{t("Prompt")}</h3>
              <p class="fc-usage-note">{t("The body of the file: what this agent is told before your own message.")}</p>
              <textarea
                class="fc-question-custom fc-agent-prompt"
                rows={10}
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
              />

              <Show when={problem()}>{(why) => <p class="fc-run-error">{why()}</p>}</Show>
              <Show when={saved()}>{(message) => <p class="fc-usage-note fc-agent-saved">{message()}</p>}</Show>

              <div class="fc-dialog-actions">
                <button class="fc-button fc-button-primary" type="button" disabled={saving()} onClick={save}>
                  {saving() ? t("Saving…") : t("Save")}
                </button>
                <Show when={selected()}>
                  {(file) => (
                    <Show
                      when={confirming() === file().path}
                      fallback={
                        <button class="fc-button" type="button" onClick={() => setConfirming(file().path)}>
                          {t("Delete")}
                        </button>
                      }
                    >
                      <span class="fc-confirm-inline">
                        <span>{t("Delete {name}?", { name: file().name })}</span>
                        <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
                          {t("Cancel")}
                        </button>
                        <button
                          class="fc-button fc-button-danger"
                          type="button"
                          onClick={async () => {
                            await props.onDelete(file().path)
                            setConfirming(undefined)
                            setOpenPath(undefined)
                          }}
                        >
                          {t("Delete")}
                        </button>
                      </span>
                    </Show>
                  )}
                </Show>
              </div>
              <Show when={selected()}>
                {(file) => <p class="fc-usage-note fc-agent-path">{file().path}</p>}
              </Show>
              </div>
            </div>
          </Show>

          {/*
            Said rather than quietly missing: the engine reports more agents than there are files,
            and a form that appeared to edit one of those would do nothing.
          */}
          <Show when={orphans().length > 0}>
            <section class="fc-usage-block">
              <h2>
                {t("Not editable here")}
                <span class="fc-context-aside">{orphans().length}</span>
              </h2>
              <p class="fc-usage-note">
                {t("The engine reports these and there is no file behind them: they are built in or come from a plugin.")}
              </p>
              <div class="fc-routine-cards">
                <For each={orphans()}>
                  {(agent) => (
                    <div class="fc-routine-card fc-routine-card-static">
                      <span class="fc-routine-card-content">
                        <strong>{agent.id}</strong>
                        <small>{agent.description}</small>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </section>
    </Show>
  )
}
