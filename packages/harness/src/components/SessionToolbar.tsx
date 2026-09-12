import { For, Show, createSignal, type Component } from "solid-js"
import type { AgentInfo, SessionInfo } from "../engine-types"
import type { ProjectItem } from "../types"
import { t } from "../i18n"

type SessionToolbarProps = {
  session: SessionInfo
  agents: AgentInfo[]
  projects: ProjectItem[]
  busy: boolean
  reverting: boolean
  tags: string[]
  onFork: () => void
  onCompact: () => void
  onRename: () => void
  onExport: () => void
  onMove: (directory: string) => void
  onDelete: () => void
  onAgentChange: (agent: string) => void
  onUndo: () => void
  onRedo: () => void
  onCommitRevert: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
}

function primaryAgents(agents: AgentInfo[]) {
  return agents.filter((agent) => agent.mode === "primary" && !agent.hidden)
}

function projectLabel(project: ProjectItem) {
  return project.name || project.directory.split("/").filter(Boolean).at(-1) || project.directory
}

export const SessionToolbar: Component<SessionToolbarProps> = (props) => {
  const [tag, setTag] = createSignal("")

  const addTag = () => {
    const value = tag().trim()
    if (!value) return
    props.onAddTag(value)
    setTag("")
  }

  return (
    <div class="fc-session-toolbar">
      <div class="fc-session-toolbar-title">{props.session.title || t("Session without title")}</div>
      <div class="fc-session-toolbar-actions">
        <select
          class="fc-toolbar-select"
          aria-label={t("Agent")}
          value={props.session.agent ?? ""}
          disabled={props.busy}
          onChange={(event) => props.onAgentChange(event.currentTarget.value)}
        >
          <option value="" disabled>
            {t("Agent")}
          </option>
          <For each={primaryAgents(props.agents)}>
            {(agent) => <option value={agent.id}>{agent.id}</option>}
          </For>
        </select>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onFork}>
          {t("Fork")}
        </button>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onCompact}>
          {t("Compact")}
        </button>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onUndo}>
          {t("Undo")}
        </button>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onRedo}>
          {t("Redo")}
        </button>
        <Show when={props.reverting}>
          <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={props.onCommitRevert}>
            {t("Confirm revert")}
          </button>
        </Show>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onRename}>
          {t("Rename")}
        </button>
        <button class="fc-button" type="button" disabled={props.busy} onClick={props.onExport}>
          {t("Export MD")}
        </button>
        <select
          class="fc-toolbar-select"
          aria-label={t("Move to…")}
          value=""
          disabled={props.busy}
          onChange={(event) => {
            if (event.currentTarget.value) props.onMove(event.currentTarget.value)
          }}
        >
          <option value="" disabled>
            {t("Move to…")}
          </option>
          <For each={props.projects}>
            {(project) => <option value={project.directory}>{projectLabel(project)}</option>}
          </For>
        </select>
        <button class="fc-button fc-button-danger" type="button" disabled={props.busy} onClick={props.onDelete}>
          {t("Delete")}
        </button>
      </div>
      <div class="fc-session-tags">
        <For each={props.tags}>
          {(value) => (
            <span class="fc-tag">
              {value}
              <button
                class="fc-tag-remove"
                type="button"
                aria-label={`${t("Remove")} ${value}`}
                onClick={() => props.onRemoveTag(value)}
              >
                ×
              </button>
            </span>
          )}
        </For>
        <input
          class="fc-tag-input"
          placeholder={t("Add tag")}
          value={tag()}
          onInput={(event) => setTag(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addTag()
            }
          }}
        />
      </div>
    </div>
  )
}
