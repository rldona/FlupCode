import { For, Show, type Component } from "solid-js"
import type { PermissionV2Request } from "@opencode-ai/client"
import { t } from "../i18n"

export type PermissionReply = "once" | "always" | "reject"

type PermissionDockProps = {
  request: PermissionV2Request
  busy: boolean
  onReply: (reply: PermissionReply) => void
}

export const PermissionDock: Component<PermissionDockProps> = (props) => (
  <div class="fc-dock fc-dock-permission">
    <div class="fc-dock-header">
      <span class="fc-dock-title">{t("Permission required")}</span>
      <span class="fc-chip">{props.request.action}</span>
    </div>
    <Show when={props.request.resources.length > 0}>
      <ul class="fc-dock-list">
        <For each={props.request.resources}>{(resource) => <li><code>{resource}</code></li>}</For>
      </ul>
    </Show>
    <div class="fc-dock-actions">
      <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={() => props.onReply("once")}>
        {t("Allow once")}
      </button>
      <button class="fc-button" type="button" disabled={props.busy} onClick={() => props.onReply("always")}>
        {t("Allow always")}
      </button>
      <button
        class="fc-button fc-button-danger"
        type="button"
        disabled={props.busy}
        onClick={() => props.onReply("reject")}
      >
        {t("Reject")}
      </button>
    </div>
  </div>
)
