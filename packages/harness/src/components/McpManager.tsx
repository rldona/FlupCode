import { For, Show, createSignal, type Component } from "solid-js"
import type { McpServer } from "../engine-types"
import type { McpConfig } from "../types"
import { t } from "../i18n"

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
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div class="fc-modal-header">
            <span>{t("MCP servers")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <Show
            when={props.servers.length > 0}
            fallback={
              <div class="fc-empty-state">
                <span class="fc-empty-title">{t("No MCP servers")}</span>
              </div>
            }
          >
            <ul class="fc-mcp-list">
              <For each={props.servers}>
                {(server) => (
                  <li class="fc-mcp-row">
                    <span class="fc-mcp-name">{server.name}</span>
                    <span class="fc-chip">{statusLabel(server)}</span>
                    <button
                      class="fc-button"
                      type="button"
                      disabled={props.busy}
                      onClick={() =>
                        statusLabel(server) === "connected" ? props.onDisconnect(server.name) : props.onConnect(server.name)
                      }
                    >
                      {statusLabel(server) === "connected" ? t("Disconnect") : t("Connect")}
                    </button>
                    <button
                      class="fc-button fc-button-danger"
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onRemove(server.name)}
                    >
                      {t("Remove")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <div class="fc-mcp-form">
            <input
              class="fc-question-custom"
              placeholder={t("Name")}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <select
              class="fc-toolbar-select"
              value={type()}
              onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}
            >
              <option value="local">{t("Local")}</option>
              <option value="remote">{t("Remote")}</option>
            </select>
            <input
              class="fc-question-custom"
              placeholder={type() === "local" ? t("command and arguments") : "https://…"}
              value={field()}
              onInput={(event) => setField(event.currentTarget.value)}
            />
            <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={submit}>
              {t("Add")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
