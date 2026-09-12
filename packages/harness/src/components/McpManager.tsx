import { For, Show, createSignal, type Component } from "solid-js"
import type { McpServer } from "@opencode-ai/client"
import type { McpConfig } from "../types"

type McpManagerProps = {
  open: boolean
  servers: McpServer[]
  busy: boolean
  onAdd: (name: string, config: McpConfig) => void
  onRemove: (name: string) => void
  onConnect: (name: string) => void
  onDisconnect: (name: string) => void
  onClose: () => void
}

const statusLabel = (server: McpServer) => {
  const value = (server.status as { status?: string }).status
  return value ?? "unknown"
}

export const McpManager: Component<McpManagerProps> = (props) => {
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [field, setField] = createSignal("")

  const submit = () => {
    const serverName = name().trim()
    const value = field().trim()
    if (!serverName || !value) return
    if (type() === "local") props.onAdd(serverName, { type: "local", command: value.split(/\s+/) })
    else props.onAdd(serverName, { type: "remote", url: value })
    setName("")
    setField("")
  }

  return (
    <Show when={props.open}>
      <div class="oh-modal-backdrop" onClick={props.onClose}>
        <div class="oh-modal oh-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div class="oh-modal-header">
            <span>Servidores MCP</span>
            <button class="oh-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
              ×
            </button>
          </div>

          <Show
            when={props.servers.length > 0}
            fallback={<div class="oh-empty-state"><span class="oh-empty-title">Sin servidores MCP</span></div>}
          >
            <ul class="oh-mcp-list">
              <For each={props.servers}>
                {(server) => (
                  <li class="oh-mcp-row">
                    <span class="oh-mcp-name">{server.name}</span>
                    <span class="oh-chip">{statusLabel(server)}</span>
                    <button
                      class="oh-button"
                      type="button"
                      disabled={props.busy}
                      onClick={() => (statusLabel(server) === "connected" ? props.onDisconnect(server.name) : props.onConnect(server.name))}
                    >
                      {statusLabel(server) === "connected" ? "Desconectar" : "Conectar"}
                    </button>
                    <button
                      class="oh-button oh-button-danger"
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onRemove(server.name)}
                    >
                      Quitar
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <div class="oh-mcp-form">
            <input
              class="oh-question-custom"
              placeholder="Nombre"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <select
              class="oh-toolbar-select"
              value={type()}
              onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}
            >
              <option value="local">Local</option>
              <option value="remote">Remoto</option>
            </select>
            <input
              class="oh-question-custom"
              placeholder={type() === "local" ? "comando y argumentos" : "https://…"}
              value={field()}
              onInput={(event) => setField(event.currentTarget.value)}
            />
            <button class="oh-button oh-button-primary" type="button" disabled={props.busy} onClick={submit}>
              Añadir
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
