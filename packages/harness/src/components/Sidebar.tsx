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
  onAbout: () => void
  onSettings: () => void
  onRoutines: () => void
}

function projectLabel(project: Project) {
  if (project.name) return project.name
  const segments = project.worktree.split("/").filter(Boolean)
  return segments.at(-1) ?? project.worktree
}

const SkeletonRows: Component<{ count: number }> = (props) => (
  <div class="fc-skeleton-list">
    <For each={Array.from({ length: props.count })}>{() => <div class="fc-skeleton" />}</For>
  </div>
)

export const Sidebar: Component<SidebarProps> = (props) => {
  const orderedProjects = () => {
    const list = props.projects ?? []
    return [...list].sort(
      (a, b) => Number(props.pinned.includes(b.id)) - Number(props.pinned.includes(a.id)),
    )
  }

  return (
    <aside class="fc-sidebar" classList={{ "fc-sidebar-collapsed": props.collapsed }}>
      <div class="fc-sidebar-top">
        <button class="fc-new" type="button" onClick={() => props.onNewSession()}>
          <span class="fc-new-icon">+</span>
          <span>Nuevo</span>
        </button>
        <nav class="fc-nav">
          <button class="fc-nav-item" type="button">
            Artefactos
          </button>
          <button class="fc-nav-item" type="button" onClick={props.onRoutines}>
            Rutinas
          </button>
          <button class="fc-nav-item" type="button" onClick={props.onSettings}>
            Personalizar
          </button>
        </nav>
      </div>

      <div class="fc-sidebar-section fc-grow">
        <div class="fc-section-header">
          <span class="fc-section-label">Proyectos</span>
          <button class="fc-icon-button" type="button" title="Actualizar" onClick={() => props.onRefresh()}>
            ↻
          </button>
        </div>
        <div class="fc-scroll">
          <Show when={!props.projectsLoading} fallback={<SkeletonRows count={3} />}>
            <Show
              when={orderedProjects().length}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">Sin proyectos abiertos</span>
                  <span class="fc-empty-hint">Abre una carpeta para empezar</span>
                </div>
              }
            >
              <ul class="fc-list">
                <For each={orderedProjects()}>
                  {(project) => (
                    <li>
                      <div class="fc-row">
                        <button
                          class="fc-row-action"
                          classList={{ "fc-row-action-on": props.pinned.includes(project.id) }}
                          type="button"
                          title="Fijar"
                          onClick={() => props.onTogglePin(project.id)}
                        >
                          {props.pinned.includes(project.id) ? "★" : "☆"}
                        </button>
                        <button
                          class="fc-row-main"
                          type="button"
                          onClick={() => props.onNewSession(project.worktree)}
                        >
                          <span class="fc-row-title">{projectLabel(project)}</span>
                          <span class="fc-row-meta">{project.worktree}</span>
                        </button>
                        <button
                          class="fc-row-action"
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

      <div class="fc-sidebar-section fc-sessions-section">
        <div class="fc-section-header">
          <span class="fc-section-label">Sesiones</span>
        </div>
        <div class="fc-scroll">
          <Show when={!props.sessionsLoading} fallback={<SkeletonRows count={2} />}>
            <Show
              when={props.sessions?.length}
              fallback={
                <div class="fc-empty-state">
                  <span class="fc-empty-title">No hay sesiones</span>
                  <span class="fc-empty-hint">Crea una con Nuevo</span>
                </div>
              }
            >
              <ul class="fc-list">
                <For each={props.sessions}>
                  {(session) => (
                    <li>
                      <button
                        class="fc-row"
                        classList={{ "fc-row-active": props.selectedSession === session.id }}
                        type="button"
                        onClick={() => props.onSelectSession(session.id)}
                      >
                        <span class="fc-row-main">
                          <span class="fc-row-title">{session.title || "Sesión sin título"}</span>
                          <span class="fc-row-meta">{session.id.slice(0, 8)}</span>
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

      <div class="fc-sidebar-footer">
        <span class="fc-avatar">OH</span>
        <input
          class="fc-name-input"
          value={props.displayName}
          placeholder="Tu nombre"
          aria-label="Display name"
          onInput={(event) => props.onDisplayName(event.currentTarget.value)}
        />
        <button class="fc-icon-button" type="button" title="Acerca de" aria-label="Acerca de" onClick={props.onAbout}>
          i
        </button>
      </div>
    </aside>
  )
}
