import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { Workflow, WorkflowFile } from "../types"
import { workflowGraph, type WorkflowGraphNode } from "../workflow-graph"

type WorkflowsPanelProps = {
  open: boolean
  files: Workflow[]
  loading: boolean
  serverAvailable: boolean
  directory?: string
  onRead: (name: string) => Promise<WorkflowFile>
  onSave: (name: string, input: { source: string; directory?: string; scope?: "project" | "global" }) => Promise<WorkflowFile>
  onDelete: (name: string) => Promise<unknown>
  onRun?: (workflow: Workflow) => void
}

const NEW_WORKFLOW = `name: new-workflow
description: What this process is for
inputs: [goal]
tasks:
  - id: plan
    agent: plan
    prompt: |
      Plan: {{goal}}
  - id: build
    agent: build
    prompt: |
      Do it.
  - id: verify
    kind: verify
    onFail: { max: 2 }
`

/** The template with the name the modal field asks for, so the field and the file agree. */
const template = (name: string) => NEW_WORKFLOW.replace(/^name:.*$/m, () => `name: ${name}`)

const NODE_WIDTH = 132
const NODE_HEIGHT = 34
const COLUMN_GAP = 44
const ROW_GAP = 22
const PAD = 12

/**
 * The graph a workflow describes (H-28), drawn as columns by dependency depth.
 *
 * A picture, not a diagram of the runner: a task one column to the right of the last thing it waits
 * for, and everything that can run together in the same column. The layout comes from a pure
 * function so it can be tested without a browser.
 */
const WorkflowGraphView: Component<{ tasks: Workflow["tasks"] }> = (props) => {
  const graph = createMemo(() => workflowGraph(props.tasks))
  const place = (node: WorkflowGraphNode) => ({
    x: PAD + node.depth * (NODE_WIDTH + COLUMN_GAP),
    y: PAD + node.row * (NODE_HEIGHT + ROW_GAP),
  })
  const width = () => PAD * 2 + Math.max(1, graph().columns) * NODE_WIDTH + Math.max(0, graph().columns - 1) * COLUMN_GAP
  const height = () => PAD * 2 + Math.max(1, graph().rows) * NODE_HEIGHT + Math.max(0, graph().rows - 1) * ROW_GAP
  const byID = (id: string) => {
    const node = graph().nodes.find((entry) => entry.id === id)
    return node ? place(node) : undefined
  }

  return (
    <div class="fc-workflow-graph" aria-label={t("Workflow graph")}>
      {/* Never larger than it is drawn: a single node must not stretch to fill the panel. */}
      <svg viewBox={`0 0 ${width()} ${height()}`} role="img" style={{ "max-width": `${width()}px` }}>
        <For each={graph().edges}>
          {(edge) => {
            const from = byID(edge.from)
            const to = byID(edge.to)
            if (!from || !to) return null
            const x1 = from.x + NODE_WIDTH
            const y1 = from.y + NODE_HEIGHT / 2
            const x2 = to.x
            const y2 = to.y + NODE_HEIGHT / 2
            const middle = (x1 + x2) / 2
            return (
              <path
                class="fc-workflow-edge"
                d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
                fill="none"
              />
            )
          }}
        </For>
        <For each={graph().nodes}>
          {(node) => {
            const at = place(node)
            return (
              <g class="fc-workflow-node" data-kind={node.kind}>
                <rect x={at.x} y={at.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="6" />
                <text x={at.x + 10} y={at.y + NODE_HEIGHT / 2 + 4}>
                  {node.id}
                </text>
                <Show when={node.gate}>
                  <text class="fc-workflow-node-mark" x={at.x + NODE_WIDTH - 10} y={at.y + NODE_HEIGHT / 2 + 4}>
                    ⎇
                  </text>
                </Show>
                <Show when={node.kind === "verify"}>
                  <text class="fc-workflow-node-mark" x={at.x + NODE_WIDTH - 10} y={at.y + NODE_HEIGHT / 2 + 4}>
                    ✓
                  </text>
                </Show>
                {/* Another vendor's CLI does this one (H-38), so the picture says so. */}
                <Show when={node.kind === "external"}>
                  <text class="fc-workflow-node-mark" x={at.x + NODE_WIDTH - 10} y={at.y + NODE_HEIGHT / 2 + 4}>
                    ▸
                  </text>
                </Show>
              </g>
            )
          }}
        </For>
      </svg>
    </div>
  )
}

/**
 * The workflow editor (H-28): the files this project can run, the graph they describe, and the YAML
 * as written.
 *
 * The source is the thing edited, not a form: a workflow is a file, and an editor that only lets you
 * change what it already understands is an editor that cannot introduce `dependsOn`. What it writes
 * is validated by reading it back, so a mistake is refused rather than saved. A new one is written in
 * a dialog, because creating a file is a moment of its own and not a row in the list.
 */
export const WorkflowsPanel: Component<WorkflowsPanelProps> = (props) => {
  const [openName, setOpenName] = createSignal<string>()
  const [file, setFile] = createSignal<WorkflowFile>()
  const [source, setSource] = createSignal("")
  const [scope, setScope] = createSignal<"project" | "global">("project")
  const [problem, setProblem] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()
  const [reading, setReading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)

  // The new-workflow dialog: its own name, source and place, kept apart from the open editor so
  // cancelling cannot touch what is already on screen.
  const [creating, setCreating] = createSignal(false)
  const [newName, setNewName] = createSignal("new-workflow")
  const [newSource, setNewSource] = createSignal(NEW_WORKFLOW)
  const [newScope, setNewScope] = createSignal<"project" | "global">("project")
  const [newProblem, setNewProblem] = createSignal<string>()
  const [newSaving, setNewSaving] = createSignal(false)

  const open = (name: string) => {
    if (!name.trim()) return
    setOpenName(name)
    setFile(undefined)
    setProblem(undefined)
    setSaved(undefined)
    setConfirming(false)
    setReading(true)
    props
      .onRead(name)
      .then((read) => {
        setFile(read)
        setSource(read.source)
        setScope(read.scope)
      })
      .catch((cause) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReading(false))
  }

  const openCreate = () => {
    setCreating(true)
    setNewName("new-workflow")
    setNewSource(template("new-workflow"))
    setNewScope(props.directory ? "project" : "global")
    setNewProblem(undefined)
  }

  // Renaming the field renames the file it will write, without discarding the rest of an edit.
  const rename = (name: string) => {
    setNewName(name)
    setNewSource((current) => current.replace(/^name:.*$/m, () => `name: ${name}`))
  }

  const create = async () => {
    const name = newName().trim()
    if (!name) return
    setNewSaving(true)
    setNewProblem(undefined)
    try {
      const written = await props.onSave(name, { source: newSource(), directory: props.directory, scope: newScope() })
      setCreating(false)
      setOpenName(written.name)
      setFile(written)
      setSource(written.source)
      setScope(written.scope)
      setProblem(undefined)
      setSaved(t("Saved. It is what this project will run next time."))
    } catch (cause) {
      setNewProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setNewSaving(false)
    }
  }

  const save = async () => {
    const name = openName()
    if (!name) return
    setSaving(true)
    setProblem(undefined)
    setSaved(undefined)
    try {
      const written = await props.onSave(name, { source: source(), directory: props.directory, scope: scope() })
      setFile(written)
      setSource(written.source)
      setSaved(t("Saved. It is what this project will run next time."))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  // A component, not a fragment: JSX nodes are real DOM, and the same ones cannot sit in two
  // selects at once.
  const PlaceOptions: Component = () => (
    <>
      <option value="project" disabled={!props.directory}>
        {t("This project (.flupcode/workflows)")}
      </option>
      <option value="global">{t("Everywhere (~/.local/share/flupcode/workflows)")}</option>
    </>
  )

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Workflows")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Workflows")}</h1>
            <p>{t("Processes written down as files: the plan, the build, the check, and what waits for what.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable} onClick={openCreate}>
              {t("New workflow")}
            </button>
          </div>
        </div>

        {/* Only when the workflow list itself could not be read, so it names a real failure. */}
        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">
            <span class="fc-routines-notice-icon">⚠</span>
            <span>{t("The harness server is not reachable, so this is the last it said.")}</span>
          </div>
        </Show>

        <section class="fc-workflow-list" aria-label={t("Workflows")}>
          <div class="fc-workflow-list-head">
            <h2>{t("Here")}</h2>
            <span class="fc-workflow-count">{props.files.length}</span>
          </div>
          <Show
            when={props.files.length > 0}
            fallback={
              <p class="fc-workflow-empty">
                {props.loading ? t("Reading…") : t("None in this project yet.")}
              </p>
            }
          >
            <div class="fc-routine-cards">
              <For each={props.files}>
                {(workflow) => (
                  <button
                    class="fc-routine-card fc-workflow-row"
                    classList={{ "fc-routine-card-selected": openName() === workflow.name }}
                    type="button"
                    onClick={() => open(workflow.name)}
                  >
                    <span class="fc-routine-card-icon" aria-hidden="true">
                      ⛓
                    </span>
                    <span class="fc-routine-card-content">
                      <strong>{workflow.name}</strong>
                      <small>{workflow.description}</small>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </section>

        <Show when={openName()}>
          <div class="fc-modal-backdrop" onClick={() => setOpenName(undefined)}>
            <div
              class="fc-modal fc-workflow-modal"
              role="dialog"
              aria-modal="true"
              aria-label={openName()}
              onClick={(event) => event.stopPropagation()}
            >
              <div class="fc-modal-header">
                <span class="fc-workflow-modal-title">
                  {openName()}
                  <Show when={file()}>
                    {(read) => (
                      <span class="fc-context-aside">{read().scope === "project" ? t("project") : t("global")}</span>
                    )}
                  </Show>
                </span>
                <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setOpenName(undefined)}>
                  ×
                </button>
              </div>
              <Show when={reading()}>
                <p class="fc-usage-note">{t("Reading…")}</p>
              </Show>

              {/*
                The graph is of what the file says, which is the last thing that parsed. While an edit
                is half-typed it stays where it was rather than drawing a shape that would not run.
              */}
              <Show when={file()?.workflow.tasks?.length}>
                <WorkflowGraphView tasks={file()!.workflow.tasks} />
              </Show>

              <label class="fc-field">
                <span>{t("Where it is written")}</span>
                <select
                  class="fc-question-custom"
                  value={scope()}
                  onChange={(event) => setScope(event.currentTarget.value as "project" | "global")}
                >
                  <PlaceOptions />
                </select>
              </label>

              <textarea
                class="fc-question-custom fc-workflow-source"
                aria-label={t("Workflow source")}
                spellcheck={false}
                value={source()}
                onInput={(event) => setSource(event.currentTarget.value)}
              />

              <div class="fc-workflow-editor-actions">
                <Show
                  when={confirming()}
                  fallback={
                    <button class="fc-button" type="button" disabled={!file()} onClick={() => setConfirming(true)}>
                      {t("Delete")}
                    </button>
                  }
                >
                  <span class="fc-confirm-inline">
                    <span>{t("Delete {name}?", { name: openName() ?? "" })}</span>
                    <button class="fc-button" type="button" onClick={() => setConfirming(false)}>
                      {t("Cancel")}
                    </button>
                    <button
                      class="fc-button fc-button-danger"
                      type="button"
                      onClick={async () => {
                        const name = openName()
                        if (!name) return
                        await props.onDelete(name).catch(() => undefined)
                        setConfirming(false)
                        setOpenName(undefined)
                        setFile(undefined)
                      }}
                    >
                      {t("Delete")}
                    </button>
                  </span>
                </Show>
                <Show when={props.onRun && file()}>
                  <button class="fc-button" type="button" onClick={() => props.onRun?.(file()!.workflow)}>
                    {t("Run")}
                  </button>
                </Show>
                <button class="fc-button fc-button-primary" type="button" disabled={saving()} onClick={() => void save()}>
                  {saving() ? t("Saving…") : t("Save")}
                </button>
              </div>
              <Show when={problem()}>{(text) => <p class="fc-run-error">{text()}</p>}</Show>
              <Show when={saved()}>{(text) => <p class="fc-agent-saved">{text()}</p>}</Show>
            </div>
          </div>
        </Show>

        <Show when={creating()}>
          <div class="fc-modal-backdrop" onClick={() => setCreating(false)}>
            <div
              class="fc-modal fc-workflow-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t("New workflow")}
              onClick={(event) => event.stopPropagation()}
            >
              <div class="fc-modal-header">
                <span>{t("New workflow")}</span>
                <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setCreating(false)}>
                  ×
                </button>
              </div>
              <p class="fc-modal-note">{t("A workflow is a file: write the tasks it runs, in order.")}</p>

              <label class="fc-field">
                <span>{t("Name")}</span>
                <input
                  class="fc-question-custom"
                  value={newName()}
                  aria-label={t("Name")}
                  onInput={(event) => rename(event.currentTarget.value)}
                />
              </label>

              <label class="fc-field">
                <span>{t("Where it is written")}</span>
                <select
                  class="fc-question-custom"
                  value={newScope()}
                  onChange={(event) => setNewScope(event.currentTarget.value as "project" | "global")}
                >
                  <PlaceOptions />
                </select>
              </label>

              <textarea
                class="fc-question-custom fc-workflow-source"
                aria-label={t("Workflow source")}
                spellcheck={false}
                value={newSource()}
                onInput={(event) => setNewSource(event.currentTarget.value)}
              />

              <Show when={newProblem()}>{(text) => <p class="fc-modal-error">{text()}</p>}</Show>

              <div class="fc-dialog-actions">
                <button class="fc-button" type="button" onClick={() => setCreating(false)}>
                  {t("Cancel")}
                </button>
                <button
                  class="fc-button fc-button-primary"
                  type="button"
                  disabled={!newName().trim() || newSaving()}
                  onClick={() => void create()}
                >
                  {newSaving() ? t("Creating…") : t("Create")}
                </button>
              </div>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  )
}
