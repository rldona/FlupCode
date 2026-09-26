import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { createHarnessClient } from "../client"
import { editorBrowserSessionID, frameClickFraction } from "../action-editor"
import { t } from "../i18n"
import type {
  ActionCatalog,
  ActionEvidence,
  ActionExtract,
  ActionInputKind,
  ActionPreview,
  ActionProfileDetail,
  ActionStep,
  ActionStepName,
  SelectorCapture,
} from "../types"

type ActionsPanelProps = {
  open: boolean
  /** The session's folder, which decides which project profiles load (WA-8). */
  directory?: string
  /** The project root the editor writes project profiles into and keys its browser by (WA-8). */
  project?: string
  serverUrl: string
  serverAvailable: boolean
  onClose: () => void
}

type PickTarget = { section: "step"; index: number } | { section: "extract"; name: string }

const STEP_KINDS: ActionStepName[] = ["goto", "waitFor", "fill", "click", "upload", "submit", "assert", "screenshot"]

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A fresh step of the named kind, so switching kinds does not leave another step's fields behind. */
const blankStep = (kind: ActionStepName): ActionStep => {
  if (kind === "goto") return { goto: "" }
  if (kind === "waitFor") return { waitFor: "" }
  if (kind === "fill") return { fill: { selector: "", text: "" } }
  if (kind === "click") return { click: "" }
  if (kind === "upload") return { upload: { selector: "", from: "" } }
  if (kind === "submit") return { submit: { selector: "" } }
  if (kind === "assert") return { assert: { selector: "" } }
  return { screenshot: "" }
}

const stepKindOf = (step: ActionStep): ActionStepName =>
  "goto" in step
    ? "goto"
    : "waitFor" in step
      ? "waitFor"
      : "fill" in step
        ? "fill"
        : "click" in step
          ? "click"
          : "upload" in step
            ? "upload"
            : "submit" in step
              ? "submit"
              : "assert" in step
                ? "assert"
                : "screenshot"

/** The sub-object of the step's own kind, so its fields can be shown without narrowing the union. */
const fillOf = (step: ActionStep) => ("fill" in step ? step.fill : undefined)
const uploadOf = (step: ActionStep) => ("upload" in step ? step.upload : undefined)
const assertOf = (step: ActionStep) => ("assert" in step ? step.assert : undefined)
const screenshotOf = (step: ActionStep) => ("screenshot" in step ? step.screenshot : undefined)

const selectorOf = (step: ActionStep): string => {
  if ("goto" in step) return step.goto
  if ("waitFor" in step) return step.waitFor
  if ("fill" in step) return step.fill.selector
  if ("click" in step) return step.click
  if ("upload" in step) return step.upload.selector
  if ("submit" in step) return step.submit.selector
  if ("assert" in step) return step.assert.selector
  return ""
}

/** The raw envelope the server validates and writes (WA-8): no id, no scope, no path. */
const rawProfile = (draft: ActionProfileDetail): Record<string, unknown> => ({
  tool: draft.tool,
  description: draft.description,
  kind: "browser",
  origin: draft.origin,
  ...(draft.credential ? { credential: draft.credential } : {}),
  inputs: draft.inputs,
  steps: draft.steps,
  ...(draft.extract && Object.keys(draft.extract).length > 0 ? { extract: draft.extract } : {}),
  guards: draft.guards,
  sensitive: draft.sensitive,
  availability: draft.availability,
  evidence: draft.evidence,
})

/**
 * The Actions editor (WA-8).
 *
 * Lists the profiles a folder loads, global and project, and edits one at a time. A profile can be
 * validated and saved, previewed against a real browser that runs only its read steps, and given a
 * selector by clicking the live page. A project profile is marked as not loaded by the agent's
 * plugin, with a button to move it to the global config where the plugin does read it.
 */
export const ActionsPanel: Component<ActionsPanelProps> = (props) => {
  const client = () => createHarnessClient(props.serverUrl)
  const [catalog, setCatalog] = createSignal<ActionCatalog>()
  const [draft, setDraft] = createSignal<ActionProfileDetail>()
  const [newID, setNewID] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [preview, setPreview] = createSignal<ActionPreview>()
  const [frame, setFrame] = createSignal<string>()
  const [pick, setPick] = createSignal<SelectorCapture>()
  const [pickTarget, setPickTarget] = createSignal<PickTarget>()

  const editorSession = () => editorBrowserSessionID(props.project ?? "")

  const reload = async () => {
    if (!props.serverAvailable) return
    try {
      setCatalog(await client().actions.list({ directory: props.directory, project: props.project }))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  createEffect(() => {
    if (!props.open || !props.serverAvailable) return
    void reload()
    // Re-read whenever the folder changes: the project profiles a screen shows are the folder's.
    props.directory
    props.project
  })

  // A live frame while a preview is up. The stream is a still every tick, not a video, which is all
  // the editor needs to see where a recipe landed.
  createEffect(() => {
    if (!props.open || !preview()) return
    const timer = setInterval(() => void refreshFrame(), 1500)
    void refreshFrame()
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => {
    const current = frame()
    if (current) URL.revokeObjectURL(current)
  })

  const refreshFrame = async () => {
    try {
      const { blob } = await client().agentBrowser.frame(editorSession(), { store: false })
      const next = URL.createObjectURL(blob)
      setFrame((old) => {
        if (old) URL.revokeObjectURL(old)
        return next
      })
    } catch {
      // A session that is not open (yet) is not an error worth showing.
    }
  }

  const profiles = createMemo(() => ({
    project: (catalog()?.profiles ?? []).filter((entry) => entry.scope === "project"),
    global: (catalog()?.profiles ?? []).filter((entry) => entry.scope === "global"),
  }))

  const select = (profile: ActionProfileDetail) => {
    setCreating(false)
    setDraft(clone(profile))
    setNewID("")
    setError(undefined)
    setNotice(undefined)
    setPreview(undefined)
    setPick(undefined)
    setPickTarget(undefined)
  }

  const beginCreate = () => {
    setCreating(true)
    setDraft({
      id: "",
      scope: "global",
      tool: "",
      description: "",
      kind: "browser",
      origin: "",
      inputs: {},
      steps: [{ goto: "{{origin}}/" }],
      guards: [],
      sensitive: false,
      availability: "host",
      evidence: { screenshots: "each" },
    })
    setNewID("")
    setError(undefined)
    setNotice(undefined)
  }

  const draftID = () => (creating() ? newID().trim() : draft()?.id ?? "")

  const update = (change: Partial<ActionProfileDetail>) => {
    const current = draft()
    if (!current) return
    setDraft({ ...current, ...change })
  }

  const updateStep = (index: number, patch: (step: ActionStep) => ActionStep) => {
    const current = draft()
    if (!current) return
    const steps = [...current.steps]
    steps[index] = patch(steps[index]!)
    update({ steps })
  }

  const validate = async () => {
    const current = draft()
    if (!current) return
    setBusy(true)
    setError(undefined)
    try {
      await client().actions.validate({ id: draftID(), profile: rawProfile(current) })
      setNotice(t("The profile is valid."))
    } catch (cause) {
      setError(messageOf(cause))
      setNotice(undefined)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const current = draft()
    if (!current) return
    const id = draftID()
    if (!id) {
      setError(t("An action needs an id."))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const written = await client().actions.save({
        id,
        scope: current.scope,
        profile: rawProfile(current),
        directory: props.directory,
        project: props.project,
      })
      setNotice(t("Saved to {path}", { path: written.path }))
      setCreating(false)
      setNewID("")
      await reload()
    } catch (cause) {
      setError(messageOf(cause))
      setNotice(undefined)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const current = draft()
    if (!current) return
    setBusy(true)
    setError(undefined)
    try {
      await client().actions.remove({
        id: current.id,
        scope: current.scope,
        directory: props.directory,
        project: props.project,
      })
      setDraft(undefined)
      setNotice(t("Action removed."))
      await reload()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Save the same profile globally and remove the project one the plugin would not load (WA-8). */
  const moveToGlobal = async () => {
    const current = draft()
    if (!current || current.scope !== "project") return
    setBusy(true)
    setError(undefined)
    try {
      const written = await client().actions.save({
        id: current.id,
        scope: "global",
        profile: rawProfile(current),
        directory: props.directory,
        project: props.project,
      })
      await client().actions.remove({
        id: current.id,
        scope: "project",
        directory: props.directory,
        project: props.project,
      })
      setDraft({ ...current, scope: "global" })
      setNotice(t("Moved to the global config at {path}.", { path: written.path }))
      await reload()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async () => {
    const current = draft()
    if (!current) return
    if (!props.project) {
      setError(t("Open a project folder to preview an action."))
      return
    }
    setBusy(true)
    setError(undefined)
    setPreview(undefined)
    setPick(undefined)
    try {
      setPreview(
        await client().actions.preview({
          profile: rawProfile(current),
          directory: props.directory,
          project: props.project,
          sessionID: editorSession(),
          headed: true,
        }),
      )
    } catch (cause) {
      const text = messageOf(cause)
      setError(
        /busy|browser_busy/i.test(text)
          ? t("That project already has a browser open. Close the other run or its window and try again.")
          : text,
      )
    } finally {
      setBusy(false)
    }
  }

  const onFrameClick = async (event: MouseEvent) => {
    const image = event.currentTarget as HTMLImageElement
    if (!image.naturalWidth) return
    const rect = image.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const point = frameClickFraction({
      clientX: event.clientX,
      clientY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    })
    try {
      setPick(await client().agentBrowser.pick(editorSession(), point))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  /** Put a picked selector where the focused field expected it (WA-8). */
  const applySelector = (selector: string) => {
    const current = draft()
    const target = pickTarget()
    if (!current || !target) return
    if (target.section === "extract") {
      const found = current.extract?.[target.name]
      if (!found) return
      update({ extract: { ...current.extract, [target.name]: { ...found, selector } } })
      return
    }
    const step = current.steps[target.index]
    if (!step) return
    updateStep(target.index, (entry) => {
      if ("fill" in entry) return { ...entry, fill: { ...entry.fill, selector } }
      if ("upload" in entry) return { ...entry, upload: { ...entry.upload, selector } }
      if ("submit" in entry) return { ...entry, submit: { ...entry.submit, selector } }
      if ("assert" in entry) return { ...entry, assert: { ...entry.assert, selector } }
      if ("click" in entry) return { ...entry, click: selector }
      if ("waitFor" in entry) return { ...entry, waitFor: selector }
      if ("goto" in entry) return { ...entry, goto: selector }
      return step
    })
  }

  return (
    <Show when={props.open}>
      <section class="fc-actions-screen" aria-label={t("Actions")}>
        <div class="fc-actions-header">
          <div>
            <div class="fc-actions-kicker">{t("Automation")}</div>
            <h1>{t("Actions")}</h1>
          </div>
          <div class="fc-actions-header-actions">
            <button class="fc-button" type="button" onClick={() => void reload()} disabled={!props.serverAvailable}>
              {t("Refresh")}
            </button>
            <button class="fc-button fc-button-primary" type="button" onClick={beginCreate} disabled={!props.serverAvailable}>
              ＋ {t("New action")}
            </button>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>

        <Show when={!props.serverAvailable} fallback={null}>
          <div class="fc-actions-notice">
            {t("The harness server is not available, so actions cannot be edited here.")}
          </div>
        </Show>
        <Show when={error()}>
          <div class="fc-actions-error" role="alert">
            {error()}
          </div>
        </Show>
        <Show when={notice()}>
          <div class="fc-actions-notice">{notice()}</div>
        </Show>

        <div class="fc-actions-layout">
          <div class="fc-actions-list">
            <Show when={profiles().project.length > 0}>
              <div class="fc-actions-group-label">{t("This project")}</div>
              <For each={profiles().project}>
                {(profile) => (
                  <button
                    class="fc-actions-card"
                    classList={{ "fc-actions-card-selected": draft()?.id === profile.id && draft()?.scope === "project" }}
                    type="button"
                    onClick={() => select(profile)}
                  >
                    <strong>{profile.id}</strong>
                    <span>{profile.description}</span>
                    <small>
                      {profile.origin} · {t("project")}
                    </small>
                  </button>
                )}
              </For>
            </Show>
            <div class="fc-actions-group-label">{t("Global")}</div>
            <For each={profiles().global} fallback={<p class="fc-actions-muted">{t("No global actions yet.")}</p>}>
              {(profile) => (
                <button
                  class="fc-actions-card"
                  classList={{ "fc-actions-card-selected": draft()?.id === profile.id && draft()?.scope === "global" }}
                  type="button"
                  onClick={() => select(profile)}
                >
                  <strong>{profile.id}</strong>
                  <span>{profile.description}</span>
                  <small>
                    {profile.origin} · {profile.sensitive ? t("needs approval") : t("read only")}
                  </small>
                </button>
              )}
            </For>
            <Show when={(catalog()?.rejected ?? []).length > 0}>
              <div class="fc-actions-group-label">{t("Not loaded")}</div>
              <For each={catalog()!.rejected}>
                {(entry) => (
                  <div class="fc-actions-card fc-actions-card-broken">
                    <strong>{entry.id}</strong>
                    <span>{entry.message}</span>
                    <small>{entry.code}</small>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={draft()} fallback={<div class="fc-actions-empty">{t("Select an action or create one.")}</div>}>
            {(current) => (
              <div class="fc-actions-editor">
                <div class="fc-actions-editor-head">
                  <h2>{creating() ? t("New action") : current().id}</h2>
                  <Show when={current().scope === "project"}>
                    <span class="fc-actions-badge">{t("project")}</span>
                  </Show>
                </div>
                <Show when={current().scope === "project"}>
                  <p class="fc-actions-warning">
                    {t("Project actions are stored in this project's .opencode. The agent's plugin loads global profiles only, so this action is not available to it.")}
                  </p>
                </Show>

                <label class="fc-actions-field">
                  <span>{t("Id")}</span>
                  <Show when={creating()} fallback={<input value={current().id} disabled />}>
                    <input
                      value={newID()}
                      placeholder={t("publish")}
                      onInput={(event) => setNewID(event.currentTarget.value)}
                    />
                  </Show>
                </label>
                <Show when={creating()}>
                  <label class="fc-actions-field">
                    <span>{t("Scope")}</span>
                    <select
                      value={current().scope}
                      onChange={(event) =>
                        update({ scope: event.currentTarget.value === "project" ? "project" : "global" })
                      }
                    >
                      <option value="global">{t("Global")}</option>
                      <option value="project" disabled={!props.project}>
                        {t("Project")}
                      </option>
                    </select>
                  </label>
                </Show>
                <label class="fc-actions-field">
                  <span>{t("Tool")}</span>
                  <input value={current().tool} onInput={(event) => update({ tool: event.currentTarget.value })} />
                </label>
                <label class="fc-actions-field">
                  <span>{t("Description")}</span>
                  <input
                    value={current().description}
                    onInput={(event) => update({ description: event.currentTarget.value })}
                  />
                </label>
                <label class="fc-actions-field">
                  <span>{t("Origin")}</span>
                  <input
                    value={current().origin}
                    placeholder="https://example.com"
                    onInput={(event) => update({ origin: event.currentTarget.value })}
                  />
                </label>
                <label class="fc-actions-field">
                  <span>{t("Credential")}</span>
                  <input
                    value={current().credential ?? ""}
                    placeholder={t("name (never the value)")}
                    onInput={(event) => update({ credential: event.currentTarget.value || undefined })}
                  />
                </label>
                <div class="fc-actions-field fc-actions-field-inline">
                  <label>
                    <input
                      type="checkbox"
                      checked={current().sensitive}
                      onChange={(event) => update({ sensitive: event.currentTarget.checked })}
                    />
                    {t("Needs approval")}
                  </label>
                  <label>
                    <span>{t("Where")}</span>
                    <select
                      value={current().availability}
                      onChange={(event) =>
                        update({ availability: event.currentTarget.value === "desktop" ? "desktop" : "host" })
                      }
                    >
                      <option value="host">{t("Host")}</option>
                      <option value="desktop">{t("Desktop")}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t("Screenshots")}</span>
                    <select
                      value={current().evidence.screenshots ?? "each"}
                      onChange={(event) =>
                        update({
                          evidence: {
                            ...current().evidence,
                            screenshots: event.currentTarget.value as ActionEvidence["screenshots"],
                          },
                        })
                      }
                    >
                      <option value="each">{t("Each step")}</option>
                      <option value="failure">{t("Only on failure")}</option>
                      <option value="none">{t("None")}</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current().evidence.text ?? false}
                      onChange={(event) =>
                        update({ evidence: { ...current().evidence, text: event.currentTarget.checked } })
                      }
                    />
                    {t("Keep page text")}
                  </label>
                </div>

                <section class="fc-actions-section">
                  <div class="fc-actions-section-head">
                    <h3>{t("Inputs")}</h3>
                    <button
                      class="fc-button"
                      type="button"
                      onClick={() => update({ inputs: { ...current().inputs, [`input${Object.keys(current().inputs).length + 1}`]: "string" } })}
                    >
                      ＋
                    </button>
                  </div>
                  <For each={Object.entries(current().inputs)}>
                    {([name, kind]) => (
                      <div class="fc-actions-row">
                        <input
                          value={name}
                          onInput={(event) => {
                            const next = { ...current().inputs }
                            delete next[name]
                            next[event.currentTarget.value] = kind
                            update({ inputs: next })
                          }}
                        />
                        <select
                          value={kind}
                          onChange={(event) => update({ inputs: { ...current().inputs, [name]: event.currentTarget.value as ActionInputKind } })}
                        >
                          <option value="string">{t("Text")}</option>
                          <option value="image">{t("Image")}</option>
                        </select>
                        <button
                          class="fc-icon-button"
                          type="button"
                          aria-label={t("Remove")}
                          onClick={() => {
                            const next = { ...current().inputs }
                            delete next[name]
                            update({ inputs: next })
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </section>

                <section class="fc-actions-section">
                  <div class="fc-actions-section-head">
                    <h3>{t("Steps")}</h3>
                    <button class="fc-button" type="button" onClick={() => update({ steps: [...current().steps, { goto: "" }] })}>
                      ＋
                    </button>
                  </div>
                  <For each={current().steps}>
                    {(step, index) => (
                      <div class="fc-actions-step">
                        <select
                          value={stepKindOf(step)}
                          onChange={(event) =>
                            updateStep(index(), () => blankStep(event.currentTarget.value as ActionStepName))
                          }
                        >
                          <For each={STEP_KINDS}>{(kind) => <option value={kind}>{kind}</option>}</For>
                        </select>
                        <input
                          value={selectorOf(step)}
                          placeholder={t("selector or URL")}
                          onFocus={() => setPickTarget({ section: "step", index: index() })}
                          onInput={(event) => {
                            const value = event.currentTarget.value
                            updateStep(index(), (entry) => {
                              if ("goto" in entry) return { ...entry, goto: value }
                              if ("waitFor" in entry) return { ...entry, waitFor: value }
                              if ("fill" in entry) return { ...entry, fill: { ...entry.fill, selector: value } }
                              if ("click" in entry) return { ...entry, click: value }
                              if ("upload" in entry) return { ...entry, upload: { ...entry.upload, selector: value } }
                              if ("submit" in entry) return { ...entry, submit: { ...entry.submit, selector: value } }
                              if ("assert" in entry) return { ...entry, assert: { ...entry.assert, selector: value } }
                              return entry
                            })
                          }}
                        />
                        <Show when={fillOf(step)}>
                          {(fill) => (
                            <input
                              value={fill().text ?? fill().credential ?? ""}
                              placeholder={t("text, {{input}} or credential")}
                              onInput={(event) =>
                                updateStep(index(), (entry) =>
                                  "fill" in entry ? { ...entry, fill: { ...entry.fill, text: event.currentTarget.value } } : entry,
                                )
                              }
                            />
                          )}
                        </Show>
                        <Show when={uploadOf(step)}>
                          {(upload) => (
                            <input
                              value={upload().from}
                              placeholder="{{image}}"
                              onInput={(event) =>
                                updateStep(index(), (entry) =>
                                  "upload" in entry ? { ...entry, upload: { ...entry.upload, from: event.currentTarget.value } } : entry,
                                )
                              }
                            />
                          )}
                        </Show>
                        <Show when={assertOf(step)}>
                          {(assertion) => (
                            <input
                              value={assertion().text ?? ""}
                              placeholder={t("expected text")}
                              onInput={(event) =>
                                updateStep(index(), (entry) =>
                                  "assert" in entry ? { ...entry, assert: { ...entry.assert, text: event.currentTarget.value } } : entry,
                                )
                              }
                            />
                          )}
                        </Show>
                        <Show when={screenshotOf(step)}>
                          {(label) => (
                            <input
                              value={label()}
                              placeholder={t("label")}
                              onInput={(event) =>
                                updateStep(index(), (entry) =>
                                  "screenshot" in entry ? { ...entry, screenshot: event.currentTarget.value } : entry,
                                )
                              }
                            />
                          )}
                        </Show>
                        <button
                          class="fc-icon-button"
                          type="button"
                          aria-label={t("Remove")}
                          onClick={() => update({ steps: current().steps.filter((_, at) => at !== index()) })}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </section>

                <section class="fc-actions-section">
                  <div class="fc-actions-section-head">
                    <h3>{t("Extract")}</h3>
                    <button
                      class="fc-button"
                      type="button"
                      onClick={() =>
                        update({
                          extract: {
                            ...(current().extract ?? {}),
                            [`field${Object.keys(current().extract ?? {}).length + 1}`]: { selector: "", as: "text" },
                          },
                        })
                      }
                    >
                      ＋
                    </button>
                  </div>
                  <For each={Object.entries(current().extract ?? {})}>
                    {([name, spec]) => (
                      <div class="fc-actions-row">
                        <input value={name} onInput={(event) => {
                          const next = { ...(current().extract ?? {}) }
                          delete next[name]
                          next[event.currentTarget.value] = spec
                          update({ extract: next })
                        }} />
                        <input
                          value={spec.selector}
                          placeholder={t("selector")}
                          onFocus={() => setPickTarget({ section: "extract", name })}
                          onInput={(event) =>
                            update({
                              extract: { ...current().extract, [name]: { ...spec, selector: event.currentTarget.value } },
                            })
                          }
                        />
                        <select
                          value={spec.as ?? "text"}
                          onChange={(event) =>
                            update({
                              extract: {
                                ...current().extract,
                                [name]: { ...spec, as: event.currentTarget.value as ActionExtract["as"] },
                              },
                            })
                          }
                        >
                          <option value="text">{t("Text")}</option>
                          <option value="html">{t("HTML")}</option>
                          <option value="attribute">{t("Attribute")}</option>
                        </select>
                        <button
                          class="fc-icon-button"
                          type="button"
                          aria-label={t("Remove")}
                          onClick={() => {
                            const next = { ...(current().extract ?? {}) }
                            delete next[name]
                            update({ extract: next })
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </section>

                <label class="fc-actions-field">
                  <span>{t("Guards")}</span>
                  <input
                    value={current().guards.join(", ")}
                    placeholder={t("lib/guards.ts, another.ts")}
                    onInput={(event) =>
                      update({
                        guards: event.currentTarget.value
                          .split(",")
                          .map((entry) => entry.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>

                <div class="fc-dialog-actions">
                  <button class="fc-button" type="button" onClick={() => void validate()} disabled={busy()}>
                    {t("Validate")}
                  </button>
                  <button class="fc-button" type="button" onClick={() => void runPreview()} disabled={busy() || !props.project}>
                    {t("Preview")}
                  </button>
                  <Show when={current().scope === "project"}>
                    <button class="fc-button" type="button" onClick={() => void moveToGlobal()} disabled={busy()}>
                      {t("Move to global")}
                    </button>
                  </Show>
                  <button class="fc-button fc-button-primary" type="button" onClick={() => void save()} disabled={busy()}>
                    {t("Save")}
                  </button>
                  <Show when={!creating()}>
                    <button class="fc-button fc-button-danger" type="button" onClick={() => void remove()} disabled={busy()}>
                      {t("Delete")}
                    </button>
                  </Show>
                </div>

                <Show when={preview()}>
                  {(result) => (
                    <section class="fc-actions-section">
                      <h3>{t("Preview")}</h3>
                      <p class="fc-actions-muted">{t("Read steps ran; the first side effect and everything after it were skipped.")}</p>
                      <ol class="fc-actions-preview">
                        <For each={result().steps}>
                          {(step) => (
                            <li classList={{ "fc-actions-preview-skipped": step.status === "skipped", "fc-actions-preview-failed": step.status === "failed" }}>
                              <span>{step.kind}</span>
                              <small>{step.status}</small>
                              <Show when={step.error}>
                                {(message) => <small class="fc-actions-preview-error">{message()}</small>}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ol>
                      <Show when={frame()}>
                        <p class="fc-actions-muted">{t("Click the page to pick a selector for the focused field.")}</p>
                        <img
                          class="fc-actions-frame"
                          src={frame()}
                          alt={t("Live browser view")}
                          onClick={(event) => void onFrameClick(event)}
                        />
                      </Show>
                      <Show when={pick()}>
                        {(found) => (
                          <div class="fc-actions-pick">
                            <Show
                              when={found().found && (found().candidates?.length ?? 0) > 0}
                              fallback={<p class="fc-actions-muted">{t("Nothing selectable at that point.")}</p>}
                            >
                              <p>
                                {t("Picked")} <code>{found().tag}</code> {found().text ? `— ${found().text}` : ""}
                              </p>
                              <div class="fc-actions-candidates">
                                <For each={found().candidates}>
                                  {(selector) => (
                                    <button class="fc-button" type="button" onClick={() => applySelector(selector)}>
                                      {selector}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </section>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </section>
    </Show>
  )
}
