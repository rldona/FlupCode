import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import type { MemoryInfo } from "../engine-types"
import type { ProjectMemory } from "../types"
import { createClient } from "../client"
import { formatMemoryTime, memoryConfidenceLabel, memoryScopeLabel } from "../memory"
import { t } from "../i18n"
import { Modal, ModalClose } from "./Modal"

type MemoryPanelProps = {
  open: boolean
  serverUrl: string
  /** The harness's own notes for this project (H-37), not the engine's memory. */
  notes?: ProjectMemory[]
  onAddNote?: (text: string) => void
  onRemoveNote?: (id: string) => void
  onClose: () => void
}

type StatusFilter = "all" | MemoryInfo["status"]
type ScopeFilter = "all" | MemoryInfo["scope"]

const SCOPES: ScopeFilter[] = ["all", "global", "project", "agent", "session"]
const STATUSES: StatusFilter[] = ["all", "active", "candidate", "stale", "archived"]
const SCOPES_SET = new Set<string>(["global", "project", "agent", "session"])
const STATUSES_SET = new Set<string>(["active", "candidate", "stale", "archived"])

const isScopeValue = (value: string): value is MemoryInfo["scope"] => SCOPES_SET.has(value)
const isStatusValue = (value: string): value is MemoryInfo["status"] => STATUSES_SET.has(value)
const isScopeFilter = (value: string): value is ScopeFilter => value === "all" || isScopeValue(value)
const isStatusFilter = (value: string): value is StatusFilter => value === "all" || isStatusValue(value)

export const MemoryPanel: Component<MemoryPanelProps> = (props) => {
  const [items, setItems] = createSignal<MemoryInfo[]>([])
  // Candidates awaiting review, whatever the filters show: they never reach a prompt until approved.
  const [candidates, setCandidates] = createSignal(0)
  const [text, setText] = createSignal("")
  const [scope, setScope] = createSignal<ScopeFilter>("all")
  const [status, setStatus] = createSignal<StatusFilter>("all")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  const [editTitle, setEditTitle] = createSignal("")
  const [editContent, setEditContent] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [newTitle, setNewTitle] = createSignal("")
  const [newContent, setNewContent] = createSignal("")
  const [newScope, setNewScope] = createSignal<MemoryInfo["scope"]>("project")
  const [note, setNote] = createSignal("")

  const load = async (generation: number) => {
    setLoading(true)
    setError(undefined)
    try {
      const scopeValue = scope()
      const statusValue = status()
      const client = createClient(props.serverUrl)
      const [result, pending] = await Promise.all([
        client.memory.list({
          ...(text() ? { text: text() } : {}),
          ...(isScopeValue(scopeValue) ? { scope: scopeValue } : {}),
          ...(isStatusValue(statusValue) ? { status: statusValue } : {}),
          limit: 200,
        }),
        client.memory.list({ status: "candidate", limit: 500 }),
      ])
      if (generation !== current) return
      setItems(result.data ?? [])
      setCandidates(pending.data?.length ?? 0)
    } catch (cause) {
      if (generation !== current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === current) setLoading(false)
    }
  }

  let current = 0
  createEffect(() => {
    if (!props.open) return
    text()
    scope()
    status()
    current += 1
    void load(current)
  })

  // Whether the action went through: a refused write keeps what was typed.
  const act = async (action: (client: ReturnType<typeof createClient>) => Promise<unknown>) => {
    setError(undefined)
    try {
      await action(createClient(props.serverUrl))
      current += 1
      await load(current)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }

  const startEdit = (memory: MemoryInfo) => {
    setEditing(memory.id)
    setEditTitle(memory.title)
    setEditContent(memory.content)
  }

  const saveEdit = (id: string) =>
    act((client) => client.memory.update({ id, title: editTitle(), content: editContent() })).then((done) => {
      if (done) setEditing(undefined)
    })

  const addMemory = () =>
    act((client) =>
      client.memory.create({
        scope: newScope(),
        title: newTitle(),
        content: newContent(),
        status: "active",
        source: "manual",
      }),
    ).then((done) => {
      if (!done) return
      setCreating(false)
      setNewTitle("")
      setNewContent("")
    })

  return (
    <Modal open={props.open} onClose={props.onClose} class="fc-modal fc-modal-xl" label={t("Memory")}>
      <div class="fc-modal-header">
        <span class="fc-modal-heading">
          {t("Memory")}
          <Show when={candidates() > 0}>
            <button
              class="fc-memory-badge"
              type="button"
              title={t("Candidates are not used in prompts until you approve them.")}
              onClick={() => setStatus("candidate")}
            >
              {t("{count} candidates to review", { count: candidates() })}
            </button>
          </Show>
        </span>
        <div class="fc-modal-actions">
          <button class="fc-button" type="button" onClick={() => setCreating((value) => !value)}>
            {t("Add memory")}
          </button>
          <button
            class="fc-button"
            type="button"
            onClick={() => {
              current += 1
              void load(current)
            }}
          >
            {t("Refresh")}
          </button>
          <ModalClose />
        </div>
      </div>

      <Show when={props.onAddNote}>
        {/*
          The harness's notes, not the engine's memory: what a person wants every turn in this
          project to know, written by hand (H-37).
        */}
        <section class="fc-usage-block">
          <h2>{t("Project notes")}</h2>
          <p class="fc-usage-note">
            {t("Kept by FlupCode and handed to every turn in this project, not the engine's memory.")}
          </p>
          <Show
            when={(props.notes ?? []).length > 0}
            fallback={<p class="fc-settings-hint">{t("Nothing written down.")}</p>}
          >
            <For each={props.notes}>
              {(entry) => (
                <div class="fc-usage-row fc-skill-row">
                  <span class="fc-usage-key">{entry.text}</span>
                  <button class="fc-button" type="button" onClick={() => props.onRemoveNote?.(entry.id)}>
                    {t("Remove")}
                  </button>
                </div>
              )}
            </For>
          </Show>
          <div class="fc-field-row">
            <label class="fc-field">
              <span>{t("A decision or convention")}</span>
              <input
                class="fc-input"
                value={note()}
                placeholder={t("Use the server, not the browser, for anything durable")}
                onInput={(event) => setNote(event.currentTarget.value)}
              />
            </label>
            <button
              class="fc-button"
              type="button"
              disabled={!note().trim()}
              onClick={() => {
                props.onAddNote?.(note().trim())
                setNote("")
              }}
            >
              {t("Add note")}
            </button>
          </div>
        </section>
      </Show>

      <Show when={creating()}>
        <div class="fc-memory-form">
          <input
            class="fc-input"
            value={newTitle()}
            placeholder={t("Title")}
            onInput={(event) => setNewTitle(event.currentTarget.value)}
          />
          <textarea
            class="fc-input fc-memory-textarea"
            value={newContent()}
            placeholder={t("What should the agent remember?")}
            onInput={(event) => setNewContent(event.currentTarget.value)}
          />
          <div class="fc-memory-form-actions">
            <select
              class="fc-input fc-memory-select"
              value={newScope()}
              onChange={(event) => {
                const value = event.currentTarget.value
                if (isScopeValue(value)) setNewScope(value)
              }}
            >
              <For each={["global", "project", "agent", "session"] as const}>
                {(option) => <option value={option}>{memoryScopeLabel(option)}</option>}
              </For>
            </select>
            <button
              class="fc-button fc-button-primary"
              type="button"
              disabled={newTitle().trim().length === 0 || newContent().trim().length === 0}
              onClick={() => void addMemory()}
            >
              {t("Save")}
            </button>
          </div>
        </div>
      </Show>

      <div class="fc-memory-filters">
        <input
          class="fc-input fc-memory-search"
          value={text()}
          placeholder={t("Search memory")}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <select
          class="fc-input fc-memory-select"
          value={scope()}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (isScopeFilter(value)) setScope(value)
          }}
        >
          <For each={SCOPES}>
            {(option) => (
              <option value={option}>{option === "all" ? t("All scopes") : memoryScopeLabel(option)}</option>
            )}
          </For>
        </select>
        <select
          class="fc-input fc-memory-select"
          value={status()}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (isStatusFilter(value)) setStatus(value)
          }}
        >
          <For each={STATUSES}>
            {(option) => <option value={option}>{option === "all" ? t("All statuses") : t(option)}</option>}
          </For>
        </select>
      </div>

      <Show when={error()}>
        <div class="fc-modal-error">{error()}</div>
      </Show>

      <Show when={!loading() || items().length > 0} fallback={<div class="fc-empty-state">{t("Loading…")}</div>}>
        <Show
          when={items().length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("Nothing remembered yet")}</span>
              <span>{t("FlupCode learns useful project and user knowledge as you work.")}</span>
            </div>
          }
        >
          <ul class="fc-memory-list">
            <For each={items()}>
              {(memory) => (
                <li class="fc-memory-row" classList={{ "fc-memory-row-editing": editing() === memory.id }}>
                  <div class="fc-memory-row-head">
                    <span class={`fc-memory-scope fc-memory-scope-${memory.scope}`}>
                      {memoryScopeLabel(memory.scope)}
                    </span>
                    <span class="fc-memory-title">{memory.title}</span>
                    <span class={`fc-memory-status fc-memory-status-${memory.status}`}>{t(memory.status)}</span>
                  </div>
                  <Show when={editing() === memory.id} fallback={<p class="fc-memory-content">{memory.content}</p>}>
                    <input
                      class="fc-input"
                      value={editTitle()}
                      onInput={(event) => setEditTitle(event.currentTarget.value)}
                    />
                    <textarea
                      class="fc-input fc-memory-textarea"
                      value={editContent()}
                      onInput={(event) => setEditContent(event.currentTarget.value)}
                    />
                  </Show>
                  <div class="fc-memory-meta">
                    <span>{memory.kind}</span>
                    <span>
                      {t("Source")}: {memory.source}
                    </span>
                    <span>
                      {t("Confidence")}: {memoryConfidenceLabel(memory.confidence)}
                    </span>
                    <span>
                      {t("Used")}: {memory.useCount}
                    </span>
                    <span>
                      {t("Updated")}: {formatMemoryTime(memory.timeLastUsed ?? memory.timeUpdated)}
                    </span>
                  </div>
                  <div class="fc-memory-actions">
                    <Show
                      when={editing() === memory.id}
                      fallback={
                        <>
                          <button class="fc-button" type="button" onClick={() => startEdit(memory)}>
                            {t("Edit")}
                          </button>
                          <button
                            class="fc-button"
                            type="button"
                            onClick={() => void act((client) => client.memory.verify({ id: memory.id }))}
                          >
                            {t("Verify")}
                          </button>
                          <Show when={memory.status === "candidate"}>
                            <button
                              class="fc-button fc-button-primary"
                              type="button"
                              onClick={() =>
                                void act((client) => client.memory.update({ id: memory.id, status: "active" }))
                              }
                            >
                              {t("Approve")}
                            </button>
                          </Show>
                          <button
                            class="fc-button fc-button-danger"
                            type="button"
                            onClick={() => void act((client) => client.memory.remove({ id: memory.id }))}
                          >
                            {t("Delete")}
                          </button>
                        </>
                      }
                    >
                      <button
                        class="fc-button fc-button-primary"
                        type="button"
                        onClick={() => void saveEdit(memory.id)}
                      >
                        {t("Save")}
                      </button>
                      <button class="fc-button" type="button" onClick={() => setEditing(undefined)}>
                        {t("Cancel")}
                      </button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </Modal>
  )
}
