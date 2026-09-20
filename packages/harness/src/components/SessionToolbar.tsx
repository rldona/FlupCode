import { For, Show, type Component } from "solid-js"
import type { AgentInfo, Project, SessionInfo } from "@opencode-ai/client"

type SessionToolbarProps = {
  session: SessionInfo
  agents: AgentInfo[]
  projects: Project[]
  busy: boolean
  reverting: boolean
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
}

function projectLabel(project: Project) {
  if (project.name) return project.name
  const segments = project.worktree.split("/").filter(Boolean)
  return segments.at(-1) ?? project.worktree
}

export const SessionToolbar: Component<SessionToolbarProps> = (props) => (
  <div class="oh-session-toolbar">
    <div class="oh-session-toolbar-title">{props.session.title || "Sesión sin título"}</div>
    <div class="oh-session-toolbar-actions">
      <select
        class="oh-toolbar-select"
        aria-label="Agente"
        value={props.session.agent ?? ""}
        disabled={props.busy}
        onChange={(event) => props.onAgentChange(event.currentTarget.value)}
      >
        <option value="" disabled>
          Agente
        </option>
        <For each={props.agents.filter((agent) => agent.mode !== "subagent")}>
          {(agent) => <option value={agent.name}>{agent.name}</option>}
        </For>
      </select>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onFork}>
        Fork
      </button>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onCompact}>
        Compactar
      </button>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onUndo}>
        Undo
      </button>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onRedo}>
        Rehacer
      </button>
      <Show when={props.reverting}>
        <button class="oh-button oh-button-primary" type="button" disabled={props.busy} onClick={props.onCommitRevert}>
          Confirmar reversión
        </button>
      </Show>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onRename}>
        Renombrar
      </button>
      <button class="oh-button" type="button" disabled={props.busy} onClick={props.onExport}>
        Exportar MD
      </button>
      <select
        class="oh-toolbar-select"
        aria-label="Mover a proyecto"
        value=""
        disabled={props.busy}
        onChange={(event) => {
          if (event.currentTarget.value) props.onMove(event.currentTarget.value)
        }}
      >
        <option value="" disabled>
          Mover a…
        </option>
        <For each={props.projects}>{(project) => <option value={project.worktree}>{projectLabel(project)}</option>}</For>
      </select>
      <button class="oh-button oh-button-danger" type="button" disabled={props.busy} onClick={props.onDelete}>
        Eliminar
      </button>
    </div>
  </div>
)
