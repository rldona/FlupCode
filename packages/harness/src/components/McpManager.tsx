import { For, Show, createSignal, type Component } from "solid-js"
import type { McpServer } from "../engine-types"
import type { McpConfig } from "../types"
import { t } from "../i18n"

type McpEditorProps = {
  servers: McpServer[]
  /** The configured servers themselves, keyed by name, so one can be opened for editing. */
  configs?: Record<string, McpConfig>
  busy: boolean
  onAdd: (name: string, config: McpConfig) => void
  onRemove: (name: string) => void
  onConnect: (name: string) => void
  onDisconnect: (name: string) => void
}

type McpManagerProps = McpEditorProps & {
  open: boolean
  onClose: () => void
  onBack?: () => void
}

const statusLabel = (server: McpServer) => {
  const value = (server.status as { status?: string }).status
  return value ?? "unknown"
}

/**
 * `KEY=value` lines, one per line, as the engine's map.
 *
 * The form takes what people already write in a `.env` rather than a JSON editor: a blank line or a
 * line without the separator is a mistake to skip, not a reason to refuse the whole save.
 */
export function pairsFrom(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf("=")
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    if (key) out[key] = trimmed.slice(at + 1).trim()
  }
  return out
}

export function pairsToText(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

/** Milliseconds from a field that may be blank; blank means "leave the engine's default". */
const timeoutFrom = (text: string) => {
  const value = Number.parseInt(text.trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export const McpEditor: Component<McpEditorProps> = (props) => {
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [command, setCommand] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [cwd, setCwd] = createSignal("")
  const [environment, setEnvironment] = createSignal("")
  const [headers, setHeaders] = createSignal("")
  const [timeout, setTimeout] = createSignal("")
  const [enabled, setEnabled] = createSignal(true)

  const reset = () => {
    setName("")
    setCommand("")
    setUrl("")
    setCwd("")
    setEnvironment("")
    setHeaders("")
    setTimeout("")
    setEnabled(true)
  }

  const edit = (server: McpServer) => {
    const config = props.configs?.[server.name]
    setName(server.name)
    if (!config) return
    setType(config.type)
    if (config.type === "local") {
      setCommand((config.command ?? []).join(" "))
      setCwd(config.cwd ?? "")
      setEnvironment(pairsToText(config.environment))
    } else {
      setUrl(config.url)
      setHeaders(pairsToText(config.headers))
    }
    setTimeout(config.timeout === undefined ? "" : String(config.timeout))
    setEnabled(config.enabled !== false)
  }

  const submit = () => {
    const serverName = name().trim()
    if (!serverName) return
    const maybeTimeout = timeoutFrom(timeout())
    const config: McpConfig =
      type() === "local"
        ? {
            type: "local",
            command: command().trim().split(/\s+/).filter(Boolean),
            ...(cwd().trim() ? { cwd: cwd().trim() } : {}),
            ...(Object.keys(pairsFrom(environment())).length ? { environment: pairsFrom(environment()) } : {}),
            ...(maybeTimeout === undefined ? {} : { timeout: maybeTimeout }),
            ...(enabled() ? {} : { enabled: false }),
          }
        : {
            type: "remote",
            url: url().trim(),
            ...(Object.keys(pairsFrom(headers())).length ? { headers: pairsFrom(headers()) } : {}),
            ...(maybeTimeout === undefined ? {} : { timeout: maybeTimeout }),
            ...(enabled() ? {} : { enabled: false }),
          }
    if (config.type === "local" && config.command.length === 0) return
    if (config.type === "remote" && !config.url) return
    props.onAdd(serverName, config)
    reset()
  }

  return (
    <>
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
                <button class="fc-button" type="button" disabled={props.busy} onClick={() => edit(server)}>
                  {t("Edit")}
                </button>
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
        <div class="fc-field-row">
          <label class="fc-field">
            <span>{t("Name")}</span>
            <input
              class="fc-question-custom"
              placeholder={t("Name")}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label class="fc-field">
            <span>{t("Type")}</span>
            <select
              class="fc-toolbar-select"
              value={type()}
              onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}
            >
              <option value="local">{t("Local")}</option>
              <option value="remote">{t("Remote")}</option>
            </select>
          </label>
        </div>

        <Show
          when={type() === "local"}
          fallback={
            <>
              <label class="fc-field">
                <span>{t("URL")}</span>
                <input
                  class="fc-question-custom"
                  placeholder="https://…"
                  value={url()}
                  onInput={(event) => setUrl(event.currentTarget.value)}
                />
              </label>
              <label class="fc-field">
                <span>{t("Headers")}</span>
                <textarea
                  class="fc-field-area"
                  rows={3}
                  placeholder="Authorization=Bearer …"
                  value={headers()}
                  onInput={(event) => setHeaders(event.currentTarget.value)}
                />
                <span class="fc-field-hint">{t("One Header=value per line.")}</span>
              </label>
            </>
          }
        >
          <label class="fc-field">
            <span>{t("Command")}</span>
            <input
              class="fc-question-custom"
              placeholder={t("command and arguments")}
              value={command()}
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
          </label>
          <label class="fc-field">
            <span>{t("Working directory")}</span>
            <input
              class="fc-question-custom"
              placeholder={t("Optional")}
              value={cwd()}
              onInput={(event) => setCwd(event.currentTarget.value)}
            />
          </label>
          <label class="fc-field">
            <span>{t("Environment")}</span>
            <textarea
              class="fc-field-area"
              rows={3}
              placeholder="API_KEY=…"
              value={environment()}
              onInput={(event) => setEnvironment(event.currentTarget.value)}
            />
            <span class="fc-field-hint">{t("One KEY=value per line.")}</span>
          </label>
        </Show>

        <div class="fc-field-row">
          <label class="fc-field">
            <span>{t("Timeout (ms)")}</span>
            <input
              class="fc-question-custom"
              inputmode="numeric"
              placeholder={t("5000")}
              value={timeout()}
              onInput={(event) => setTimeout(event.currentTarget.value)}
            />
          </label>
          <label class="fc-field fc-check">
            <input
              type="checkbox"
              checked={enabled()}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
            <span>{t("Start on launch")}</span>
          </label>
        </div>

        <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={submit}>
          {t("Add")}
        </button>
      </div>
    </>
  )
}

export const McpManager: Component<McpManagerProps> = (props) => (
  <Show when={props.open}>
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div
        class="fc-modal fc-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t("MCP servers")}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="fc-modal-header">
          <span class="fc-modal-heading">
            <Show when={props.onBack}>
              <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
                ←
              </button>
            </Show>
            <span>{t("MCP servers")}</span>
          </span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <McpEditor
          servers={props.servers}
          configs={props.configs}
          busy={props.busy}
          onAdd={props.onAdd}
          onRemove={props.onRemove}
          onConnect={props.onConnect}
          onDisconnect={props.onDisconnect}
        />
      </div>
    </div>
  </Show>
)
