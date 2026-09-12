import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { createClient, resolveServerUrl } from "./client"

export const App: Component = () => {
  const [serverUrl, setServerUrl] = createSignal(resolveServerUrl())
  const [selected, setSelected] = createSignal<string>()
  const [prompt, setPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const [health] = createResource(serverUrl, (url) => createClient(url).health.get())
  const [sessions, { refetch }] = createResource(serverUrl, async (url) => {
    const response = await createClient(url).session.list()
    return response.data
  })

  const run = async (action: (client: ReturnType<typeof createClient>) => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action(createClient(serverUrl()))
      void refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const createSession = () =>
    run(async (client) => {
      const session = await client.session.create({})
      setSelected(session.id)
    })

  const send = () => {
    const text = prompt().trim()
    if (!text) return
    void run(async (client) => {
      const sessionID = selected() ?? (await client.session.create({})).id
      setSelected(sessionID)
      await client.session.prompt({ sessionID, text })
      setPrompt("")
    })
  }

  return (
    <div class="oh-app">
      <aside class="oh-sidebar">
        <div class="oh-sidebar-top">
          <button class="oh-new" type="button" onClick={createSession} disabled={busy()}>
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

        <div class="oh-sidebar-section">
          <div class="oh-section-label">Fijado</div>
          <div class="oh-empty">Sin elementos fijados</div>
        </div>

        <div class="oh-sidebar-section oh-grow">
          <div class="oh-section-header">
            <span class="oh-section-label">Sesiones</span>
            <button class="oh-icon-button" type="button" title="Actualizar" onClick={() => void refetch()}>
              ↻
            </button>
          </div>
          <Show when={!sessions.loading} fallback={<div class="oh-empty">Cargando…</div>}>
            <Show when={sessions()?.length} fallback={<div class="oh-empty">No hay sesiones</div>}>
              <ul class="oh-session-list">
                <For each={sessions()}>
                  {(session) => (
                    <li>
                      <button
                        class="oh-session-item"
                        classList={{ "oh-session-item-active": selected() === session.id }}
                        type="button"
                        onClick={() => setSelected(session.id)}
                      >
                        <span class="oh-session-title">{session.title || "Sesión sin título"}</span>
                        <span class="oh-session-meta">{session.id.slice(0, 8)}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>

        <div class="oh-sidebar-footer">
          <span class="oh-avatar">OH</span>
          <span class="oh-profile">OpenHarness</span>
        </div>
      </aside>

      <main class="oh-main">
        <header class="oh-topbar">
          <div class="oh-topbar-left">
            <span class="oh-logo">OpenHarness</span>
          </div>
          <div class="oh-topbar-right">
            <input
              class="oh-server-input"
              value={serverUrl()}
              onInput={(event) => setServerUrl(event.currentTarget.value)}
              spellcheck={false}
              aria-label="Server URL"
            />
            <span
              class="oh-status"
              classList={{
                "oh-status-on": health()?.healthy === true,
                "oh-status-off": !!health.error,
              }}
            >
              {health.loading ? "Conectando" : health()?.healthy ? "Conectado" : "Sin conexión"}
            </span>
          </div>
        </header>

        <section class="oh-canvas">
          <h1 class="oh-greeting">¿Qué sigue?</h1>
          <p class="oh-subtitle">
            Shell inicial de OpenHarness. La paridad con la TUI y el diseño tipo Claude Code llegan en F2/F3.
          </p>

          <Show when={error()}>
            <div class="oh-error">{error()}</div>
          </Show>

          <div class="oh-card">
            <div class="oh-card-header">
              <span>Resumen</span>
              <span class="oh-card-meta">{sessions()?.length ?? 0} sesiones</span>
            </div>
            <div class="oh-stat-grid">
              <div class="oh-stat">
                <span class="oh-stat-value">{selected() ? selected()!.slice(0, 8) : "—"}</span>
                <span class="oh-stat-label">Sesión activa</span>
              </div>
              <div class="oh-stat">
                <span class="oh-stat-value">{health()?.version ?? "—"}</span>
                <span class="oh-stat-label">Servidor</span>
              </div>
            </div>
          </div>
        </section>

        <footer class="oh-composer">
          <div class="oh-composer-chips">
            <span class="oh-chip">Local</span>
            <span class="oh-chip">Sin carpeta</span>
          </div>
          <div class="oh-composer-row">
            <textarea
              class="oh-input"
              rows={1}
              placeholder="Describe una tarea o haz una pregunta"
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  send()
                }
              }}
            />
            <button class="oh-send" type="button" onClick={send} disabled={busy() || prompt().trim().length === 0}>
              Enviar
            </button>
          </div>
        </footer>
      </main>
    </div>
  )
}
