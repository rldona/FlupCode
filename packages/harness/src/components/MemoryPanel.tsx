import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import type { MemoryInfo } from "@opencode-ai/sdk/v2/client"
import { createClient } from "../client"
import { formatMemoryTime, memoryConfidenceLabel, memoryScopeLabel } from "../memory"
import { t } from "../i18n"

type MemoryPanelProps = {
  open: boolean
  serverUrl: string
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

  const load = async (generation: number) => {
    setLoading(true)
    setError(undefined)
    try {
      const scopeValue = scope()
      const statusValue = status()
      const result = await createClient(props.serverUrl).memory.list({
        ...(text() ? { text: text() } : {}),
        ...(isScopeValue(scopeValue) ? { scope: scopeValue } : {}),
        ...(isStatusValue(statusValue) ? { status: statusValue } : {}),
        limit: 200,
      })
      if (generation !== current) return
      setItems(result.data ?? [])
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

  const act = async (action: (client: ReturnType<typeof createClient>) => Promise<unknown>) => {
    setError(undefined)
    try {
      await action(createClient(props.serverUrl))
      current += 1
      await load(current)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const startEdit = (memory: MemoryInfo) => {
    setEditing(memory.id)
    setEditTitle(memory.title)
    setEditContent(memory.content)
  }

  const saveEdit = (id: string) =>
    act((client) => client.memory.update({ id, title: editTitle(), content: editContent() })).then(() =>
      setEditing(undefined),
    )

  const addMemory = () =>
    act((client) =>
      client.memory.create({
        scope: newScope(),
        title: newTitle(),
        content: newContent(),
        status: "active",
        source: "manual",
      }),
    ).then(() => {
      setCreating(false)
      setNewTitle("")
      setNewContent("")
    })

  const candidates = () => items().filter((memory) => memory.status === "candidate").length

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-xl"
          role="dialog"
          aria-modal="true"
          aria-label={t("Memory")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span class="fc-modal-heading">
              {t("Memory")}
              <Show when={candidates() > 0}>
                <span class="fc-memory-badge">{t("{count} candidates", { count: candidates() })}</span>
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
              <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
                ×
              </button>
            </div>
          </div>

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
        </div>
      </div>
    </Show>
  )
}
