import { For, Show, type Component } from "solid-js"
import type { Project, SessionInfo } from "@opencode-ai/client"

type SidebarProps = {
  collapsed: boolean
  displayName: string
  projects: Project[] | undefined
  projectsLoading: boolean
  pinned: string[]
  sessions: SessionInfo[] | undefined
  sessionsLoading: boolean
  selectedSession?: string
  onDisplayName: (value: string) => void
  onTogglePin: (id: string) => void
  onNewSession: (directory?: string) => void
  onSelectSession: (id: string) => void
  onRefresh: () => void
}

function projectLabel(project: Project) {
  if (project.name) return project.name
  const segments = project.worktree.split("/").filter(Boolean)
  return segments.at(-1) ?? project.worktree
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const orderedProjects = () => {
    const list = props.projects ?? []
    return [...list].sort(
      (a, b) => Number(props.pinned.includes(b.id)) - Number(props.pinned.includes(a.id)),
    )
  }

  return (
    <aside class="oh-sidebar" classList={{ "oh-sidebar-collapsed": props.collapsed }}>
      <div class="oh-sidebar-top">
        <button class="oh-new" type="button" onClick={() => props.onNewSession()}>
          <span class="oh-new-icon">+</span>
          <span>Nuevo</span>
        </button>
        <nav class="oh-nav">
          <button class="oh-nav-item" type="button">
            Artefactos
          </button>
          <button class="oh-nav-item" type="button">
            Rutinas
          </button>
          <button class="oh-nav-item" type="button">
            Personalizar
          </button>
        </nav>
      </div>

      <div class="oh-sidebar-section oh-grow">
        <div class="oh-section-header">
          <span class="oh-section-label">Proyectos</span>
          <button class="oh-icon-button" type="button" title="Actualizar" onClick={() => props.onRefresh()}>
            ↻
          </button>
        </div>
        <div class="oh-scroll">
          <Show when={!props.projectsLoading} fallback={<div class="oh-empty">Cargando…</div>}>
            <Show
              when={orderedProjects().length}
              fallback={<div class="oh-empty">Sin proyectos abiertos</div>}
            >
              <ul class="oh-list">
                <For each={orderedProjects()}>
                  {(project) => (
                    <li>
                      <div class="oh-row">
                        <button
                          class="oh-row-action"
                          classList={{ "oh-row-action-on": props.pinned.includes(project.id) }}
                          type="button"
                          title="Fijar"
                          onClick={() => props.onTogglePin(project.id)}
                        >
                          {props.pinned.includes(project.id) ? "★" : "☆"}
                        </button>
                        <button
                          class="oh-row-main"
                          type="button"
                          onClick={() => props.onNewSession(project.worktree)}
                        >
                          <span class="oh-row-title">{projectLabel(project)}</span>
                          <span class="oh-row-meta">{project.worktree}</span>
                        </button>
                        <button
                          class="oh-row-action"
                          type="button"
                          title="Nueva sesión"
                          onClick={() => props.onNewSession(project.worktree)}
                        >
                          +
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>

      <div class="oh-sidebar-section oh-sessions-section">
        <div class="oh-section-header">
          <span class="oh-section-label">Sesiones</span>
        </div>
        <div class="oh-scroll">
          <Show when={!props.sessionsLoading} fallback={<div class="oh-empty">Cargando…</div>}>
            <Show when={props.sessions?.length} fallback={<div class="oh-empty">No hay sesiones</div>}>
              <ul class="oh-list">
                <For each={props.sessions}>
                  {(session) => (
                    <li>
                      <button
                        class="oh-row"
                        classList={{ "oh-row-active": props.selectedSession === session.id }}
                        type="button"
                        onClick={() => props.onSelectSession(session.id)}
                      >
                        <span class="oh-row-main">
                          <span class="oh-row-title">{session.title || "Sesión sin título"}</span>
                          <span class="oh-row-meta">{session.id.slice(0, 8)}</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>

      <div class="oh-sidebar-footer">
        <span class="oh-avatar">OH</span>
        <input
          class="oh-name-input"
          value={props.displayName}
          placeholder="Tu nombre"
          aria-label="Display name"
          onInput={(event) => props.onDisplayName(event.currentTarget.value)}
        />
      </div>
    </aside>
  )
}
