import { For, type Component } from "solid-js"
import { t } from "../i18n"
import type { McpServer } from "../engine-types"
import { Icon } from "./Icon"

type McpAuthNoticeProps = {
  /** The servers whose engine status is `needs_auth`, already filtered by the caller. */
  servers: McpServer[]
  busy: boolean
  onAuthenticate: (name: string) => void
  onOpenSettings: () => void
  onDismiss: () => void
}

/**
 * A quiet nudge, not a modal: an MCP server that needs OAuth is invisible otherwise, and the
 * agent silently cannot use it. The reader can authenticate right here or defer to Settings.
 */
export const McpAuthNotice: Component<McpAuthNoticeProps> = (props) => (
  <aside class="fc-mcp-auth-notice" role="status" aria-live="polite">
    <div class="fc-mcp-auth-notice-head">
      <span class="fc-mcp-auth-notice-title">{t("MCP servers need authentication")}</span>
      <button class="fc-mcp-auth-notice-close" type="button" aria-label={t("Dismiss")} onClick={props.onDismiss}>
        <Icon name="close" />
      </button>
    </div>
    <p class="fc-mcp-auth-notice-body">{t("Authenticate to let the agent use them.")}</p>
    <For each={props.servers}>
      {(server) => (
        <div class="fc-mcp-auth-notice-row">
          <span class="fc-mcp-auth-notice-name">{server.name}</span>
          <button
            class="fc-button fc-button-primary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onAuthenticate(server.name)}
          >
            {t("Authenticate now")}
          </button>
        </div>
      )}
    </For>
    <button class="fc-button" type="button" disabled={props.busy} onClick={props.onOpenSettings}>
      {t("Open MCP settings")}
    </button>
  </aside>
)
